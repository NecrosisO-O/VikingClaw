# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""
Memory Deduplicator for OpenViking.

LLM-assisted deduplication with CREATE/MERGE/SKIP decisions
"""

import re
from dataclasses import dataclass
from enum import Enum
from typing import List

from openviking.core.context import Context
from openviking.models.embedder.base import EmbedResult
from openviking.prompts import render_prompt
from openviking.storage import VikingDBManager
from openviking_cli.utils import get_logger
from openviking_cli.utils.config import get_openviking_config

from .memory_extractor import CandidateMemory, MemoryCategory

logger = get_logger(__name__)


class DedupDecision(str, Enum):
    """Deduplication decision types."""

    CREATE = "create"  # New memory, create directly
    MERGE = "merge"  # Merge with existing memories
    SKIP = "skip"  # Duplicate, skip


@dataclass
class DedupResult:
    """Result of deduplication decision."""

    decision: DedupDecision
    candidate: CandidateMemory
    similar_memories: List[Context]  # Similar existing memories
    reason: str = ""


class MemoryDeduplicator:
    """Handles memory deduplication with LLM decision making."""

    SIMILARITY_THRESHOLD = 0.6  # Vector similarity threshold for pre-filtering

    def __init__(
        self,
        vikingdb: VikingDBManager,
    ):
        """Initialize deduplicator."""
        self.vikingdb = vikingdb
        self.embedder = vikingdb.get_embedder()

    async def deduplicate(
        self,
        candidate: CandidateMemory,
    ) -> DedupResult:
        """Decide how to handle a candidate memory."""
        # Step 1: Vector pre-filtering - find similar memories in same category
        similar_memories = await self._find_similar_memories(candidate)

        if not similar_memories:
            # No similar memories, create directly
            return DedupResult(
                decision=DedupDecision.CREATE,
                candidate=candidate,
                similar_memories=[],
                reason="No similar memories found",
            )

        # Preferences are expected to be continuously updated; merge to keep a single
        # consolidated memory instead of accumulating stale preference fragments.
        if candidate.category == MemoryCategory.PREFERENCES:
            return DedupResult(
                decision=DedupDecision.MERGE,
                candidate=candidate,
                similar_memories=similar_memories,
                reason="Preference memory update merged with existing similar memory",
            )

        # Step 2: LLM decision
        decision, reason = await self._llm_decision(candidate, similar_memories)

        return DedupResult(
            decision=decision,
            candidate=candidate,
            similar_memories=similar_memories,
            reason=reason,
        )

    async def _find_similar_memories(
        self,
        candidate: CandidateMemory,
    ) -> List[Context]:
        """Find similar existing memories using vector search."""
        if not self.embedder:
            return []

        # Generate embedding for candidate
        query_text = f"{candidate.abstract} {candidate.content}"
        embed_result: EmbedResult = self.embedder.embed(query_text)
        query_vector = embed_result.dense_vector

        # Determine collection and filter based on category
        collection = "context"

        # Build category filter
        category_value = candidate.category.value

        try:
            # Search with category filter
            strict_results = await self.vikingdb.search(
                collection=collection,
                query_vector=query_vector,
                limit=5,
                filter={
                    "op": "and",
                    "conds": [
                        {"field": "category", "op": "must", "conds": [category_value]},
                        {"field": "is_leaf", "op": "must", "conds": [True]},
                    ],
                },
            )

            # Filter by similarity threshold
            strict_similar: List[Context] = []
            for result in strict_results:
                if result.get("score", 0) >= self.SIMILARITY_THRESHOLD:
                    context = Context.from_dict(result)
                    if context:
                        strict_similar.append(context)
            if strict_similar:
                return strict_similar

            # Fallback: some stored records may miss `category`; retry with is_leaf-only
            # and constrain candidates by category URI prefix.
            uri_prefix = self._category_uri_prefix(candidate.category)
            loose_results = await self.vikingdb.search(
                collection=collection,
                query_vector=query_vector,
                limit=20,
                filter={
                    "op": "and",
                    "conds": [
                        {"field": "is_leaf", "op": "must", "conds": [True]},
                    ],
                },
            )

            loose_similar: List[Context] = []
            for result in loose_results:
                if result.get("score", 0) < self.SIMILARITY_THRESHOLD:
                    continue
                uri = str(result.get("uri", ""))
                if uri_prefix and not uri.startswith(uri_prefix):
                    continue
                context = Context.from_dict(result)
                if context:
                    loose_similar.append(context)
            if loose_similar:
                return loose_similar

            # Final fallback for freshly written memories that are not yet vector-indexed.
            fs_similar = await self._find_similar_from_fs(candidate, uri_prefix)
            return fs_similar

        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            return []

    @staticmethod
    def _category_uri_prefix(category: MemoryCategory) -> str:
        if category == MemoryCategory.PREFERENCES:
            return "viking://user/memories/preferences/"
        if category == MemoryCategory.ENTITIES:
            return "viking://user/memories/entities/"
        if category == MemoryCategory.EVENTS:
            return "viking://user/memories/events/"
        if category == MemoryCategory.CASES:
            return "viking://agent/memories/cases/"
        if category == MemoryCategory.PATTERNS:
            return "viking://agent/memories/patterns/"
        if category == MemoryCategory.PROFILE:
            return "viking://user/memories/profile"
        return ""

    @staticmethod
    def _tokenize_for_similarity(text: str) -> set[str]:
        normalized = re.sub(r"\s+", " ", (text or "").strip().lower())
        if not normalized:
            return set()
        # Keep ASCII words and single CJK characters for rough cross-language overlap.
        return set(re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]", normalized))

    @classmethod
    def _text_overlap_similarity(cls, left: str, right: str) -> float:
        left_tokens = cls._tokenize_for_similarity(left)
        right_tokens = cls._tokenize_for_similarity(right)
        if not left_tokens or not right_tokens:
            return 0.0
        union = left_tokens | right_tokens
        if not union:
            return 0.0
        return len(left_tokens & right_tokens) / len(union)

    async def _find_similar_from_fs(
        self,
        candidate: CandidateMemory,
        uri_prefix: str,
    ) -> List[Context]:
        if not uri_prefix:
            return []

        try:
            from openviking.storage.viking_fs import get_viking_fs

            viking_fs = get_viking_fs()
            if not viking_fs:
                return []

            base_uri = uri_prefix.rstrip("/")
            entries = await viking_fs.ls(base_uri, output="original")
            candidate_text = f"{candidate.abstract}\n{candidate.content}"
            scored: List[tuple[float, Context]] = []

            for entry in entries:
                if entry.get("isDir"):
                    continue
                uri = str(entry.get("uri", ""))
                if not uri.startswith(base_uri):
                    continue
                if not uri.endswith(".md"):
                    continue
                try:
                    existing_content = await viking_fs.read_file(uri)
                except Exception:
                    continue
                similarity = self._text_overlap_similarity(candidate_text, existing_content or "")
                if similarity < 0.12:
                    continue
                try:
                    abstract = await viking_fs.abstract(uri)
                except Exception:
                    abstract = ""
                scored.append(
                    (
                        similarity,
                        Context(
                            uri=uri,
                            parent_uri=base_uri,
                            is_leaf=True,
                            abstract=abstract or "",
                            context_type="memory",
                            category=candidate.category.value,
                        ),
                    )
                )

            scored.sort(key=lambda item: item[0], reverse=True)
            return [context for _score, context in scored[:3]]
        except Exception as e:
            logger.warning(f"Filesystem similarity fallback failed: {e}")
            return []

    async def _llm_decision(
        self,
        candidate: CandidateMemory,
        similar_memories: List[Context],
    ) -> tuple[DedupDecision, str]:
        """Use LLM to decide deduplication action."""
        vlm = get_openviking_config().vlm
        if not vlm or not vlm.is_available():
            # Without LLM, default to CREATE (conservative)
            return DedupDecision.CREATE, "LLM not available, defaulting to CREATE"

        # Format existing memories for prompt
        existing_formatted = []
        for i, mem in enumerate(similar_memories[:3]):  # Max 3 for context
            meta = getattr(mem, "meta", {}) or {}
            abstract = (
                getattr(mem, "_abstract_cache", "")
                or meta.get("abstract", "")
                or getattr(mem, "abstract", "")
            )
            existing_formatted.append(f"{i + 1}. {abstract}")

        prompt = render_prompt(
            "compression.dedup_decision",
            {
                "candidate_content": candidate.content,
                "candidate_abstract": candidate.abstract,
                "candidate_overview": candidate.overview,
                "existing_memories": "\n".join(existing_formatted),
            },
        )

        try:
            from openviking_cli.utils.llm import parse_json_from_response

            response = await vlm.get_completion_async(prompt)
            data = parse_json_from_response(response) or {}

            decision_str = data.get("decision", "create").lower()
            reason = data.get("reason", "")

            # Map to enum
            decision_map = {
                "create": DedupDecision.CREATE,
                "merge": DedupDecision.MERGE,
                "skip": DedupDecision.SKIP,
            }
            decision = decision_map.get(decision_str, DedupDecision.CREATE)

            return decision, reason

        except Exception as e:
            logger.warning(f"LLM dedup decision failed: {e}")
            return DedupDecision.CREATE, f"LLM failed: {e}"

    @staticmethod
    def _cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        if len(vec_a) != len(vec_b):
            return 0.0

        dot = sum(a * b for a, b in zip(vec_a, vec_b))
        mag_a = sum(a * a for a in vec_a) ** 0.5
        mag_b = sum(b * b for b in vec_b) ** 0.5

        if mag_a == 0 or mag_b == 0:
            return 0.0

        return dot / (mag_a * mag_b)
