# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""
Intent analyzer for OpenViking retrieval.

Analyzes session context to generate query plans.
"""

import re
from typing import List, Optional

from openviking.message import Message
from openviking.prompts import render_prompt
from openviking_cli.retrieve.types import ContextType, QueryPlan, TypedQuery
from openviking_cli.utils.config import get_openviking_config
from openviking_cli.utils.llm import parse_json_from_response
from openviking_cli.utils.logger import get_logger

logger = get_logger(__name__)


class IntentAnalyzer:
    """
    Intent analyzer: generates query plans from session context.

    Responsibilities:
    1. Integrate session context (compression + recent messages + current message)
    2. Call LLM to analyze intent
    3. Generate multiple TypedQueries for memory/resources/skill
    """

    def __init__(self, max_recent_messages: int = 5):
        """Initialize intent analyzer."""
        self.max_recent_messages = max_recent_messages

    @staticmethod
    def _extract_signal_tokens(text: str) -> List[str]:
        """Extract high-signal tokens that should not be dropped in query rewrite."""
        if not text:
            return []

        token_pattern = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{3,}")
        tokens: List[str] = []
        for token in token_pattern.findall(text):
            has_digit = any(ch.isdigit() for ch in token)
            has_upper = any(ch.isupper() for ch in token)
            # Keep identifiers/code-like tokens, avoid appending generic natural words.
            if "_" not in token and "-" not in token and not has_digit and not has_upper:
                continue
            if token not in tokens:
                tokens.append(token)
        return tokens

    @classmethod
    def _enrich_query_with_signal_tokens(
        cls,
        generated_query: str,
        current_message: Optional[str],
    ) -> str:
        """Merge missing high-signal tokens from current message into generated query."""
        query = (generated_query or "").strip()
        tokens = cls._extract_signal_tokens(current_message or "")
        if not tokens:
            return query

        lower_query = query.lower()
        missing_tokens = [token for token in tokens if token.lower() not in lower_query]
        if not missing_tokens:
            return query

        suffix = " ".join(missing_tokens[:3])
        return f"{query} {suffix}".strip() if query else suffix

    @staticmethod
    def _message_role(message) -> str:
        if isinstance(message, dict):
            return str(message.get("role", "") or "")
        return str(getattr(message, "role", "") or "")

    @staticmethod
    def _message_content(message) -> str:
        if isinstance(message, dict):
            return str(message.get("content", "") or "")
        return str(getattr(message, "content", "") or "")

    def _build_signal_source(
        self,
        messages: List[Message],
        current_message: Optional[str],
        query_context_type: ContextType,
    ) -> str:
        """Build text source used for preserving signal tokens.

        For memory retrieval, include recent user turns as fallback anchors so
        conversational follow-up questions can stay session-specific.
        """
        chunks: List[str] = []
        if current_message:
            chunks.append(current_message)

        if query_context_type != ContextType.MEMORY:
            return "\n".join(chunks)

        if messages:
            for msg in reversed(messages[-self.max_recent_messages :]):
                if self._message_role(msg) != "user":
                    continue
                content = self._message_content(msg).strip()
                if not content:
                    continue
                chunks.append(content)
                if len(chunks) >= 3:
                    break

        return "\n".join(chunks)

    async def analyze(
        self,
        compression_summary: str,
        messages: List[Message],
        current_message: Optional[str] = None,
        context_type: Optional[ContextType] = None,
        target_abstract: str = "",
    ) -> QueryPlan:
        """Analyze session context and generate query plan.

        Args:
            compression_summary: Session compression summary
            messages: Session message history
            current_message: Current message (if any)
            context_type: Constrained context type (only generate queries for this type)
            target_abstract: Target directory abstract for more precise queries
        """
        # Build context prompt
        prompt = self._build_context_prompt(
            compression_summary,
            messages,
            current_message,
            context_type,
            target_abstract,
        )

        # Call LLM
        response = await get_openviking_config().vlm.get_completion_async(prompt)

        # Parse result
        parsed = parse_json_from_response(response)
        if not parsed:
            raise ValueError("Failed to parse intent analysis response")

        # Build QueryPlan
        queries = []
        for q in parsed.get("queries", []):
            try:
                query_context_type = ContextType(q.get("context_type", "resource"))
            except ValueError:
                query_context_type = ContextType.RESOURCE

            signal_source = self._build_signal_source(
                messages=messages,
                current_message=current_message,
                query_context_type=query_context_type,
            )
            query_text = self._enrich_query_with_signal_tokens(
                q.get("query", ""),
                signal_source,
            )

            queries.append(
                TypedQuery(
                    query=query_text,
                    context_type=query_context_type,
                    intent=q.get("intent", ""),
                    priority=q.get("priority", 3),
                )
            )

        # Log analysis result
        for i, q in enumerate(queries):
            logger.info(
                f'  [{i + 1}] type={q.context_type.value}, priority={q.priority}, query="{q.query}"'
            )
        logger.debug(f"[IntentAnalyzer] Reasoning: {parsed.get('reasoning', '')[:200]}...")

        return QueryPlan(
            queries=queries,
            session_context=self._summarize_context(compression_summary, current_message),
            reasoning=parsed.get("reasoning", ""),
        )

    def _build_context_prompt(
        self,
        compression_summary: str,
        messages: List[Message],
        current_message: Optional[str],
        context_type: Optional[ContextType] = None,
        target_abstract: str = "",
    ) -> str:
        """Build prompt for intent analysis."""
        # Format compression info
        summary = compression_summary if compression_summary else "None"

        # Format recent messages
        recent = messages[-self.max_recent_messages :] if messages else []
        recent_messages = (
            "\n".join(f"[{m.role}]: {m.content}" for m in recent if m.content) if recent else "None"
        )

        # Current message
        current = current_message if current_message else "None"

        return render_prompt(
            "retrieval.intent_analysis",
            {
                "compression_summary": summary,
                "recent_messages": recent_messages,
                "current_message": current,
                "context_type": context_type.value if context_type else "",
                "target_abstract": target_abstract,
            },
        )

    def _summarize_context(
        self,
        compression_summary: str,
        current_message: Optional[str],
    ) -> str:
        """Generate context summary."""
        parts = []
        if compression_summary:
            parts.append(f"Session summary: {compression_summary}")
        if current_message:
            parts.append(f"Current message: {current_message[:100]}")
        return " | ".join(parts) if parts else "No context"
