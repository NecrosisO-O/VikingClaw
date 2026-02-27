#!/usr/bin/env python3
# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Regression tests for summary/summaries compatibility in VikingFS.search()."""

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _make_viking_fs():
    """Create a lightweight VikingFS instance with minimal dependencies."""
    from openviking.storage.viking_fs import VikingFS

    fs = VikingFS.__new__(VikingFS)
    fs.agfs = MagicMock()
    fs.query_embedder = object()
    fs.vector_store = object()
    fs.rerank_config = None
    fs._uri_prefix = "viking://"
    return fs


@pytest.mark.asyncio
async def test_search_merges_summaries_and_legacy_summary(monkeypatch):
    """search() should merge both keys in order and dedupe repeated chunks."""
    from openviking.retrieve.hierarchical_retriever import HierarchicalRetriever
    from openviking.retrieve.intent_analyzer import IntentAnalyzer
    from openviking_cli.retrieve import ContextType, QueryPlan, QueryResult, TypedQuery

    captured: dict = {}

    async def fake_analyze(
        self,
        compression_summary,
        messages,
        current_message,
        context_type=None,
        target_abstract="",
    ):
        captured["compression_summary"] = compression_summary
        return QueryPlan(
            queries=[
                TypedQuery(
                    query=current_message,
                    context_type=ContextType.RESOURCE,
                    intent="test",
                    priority=1,
                )
            ],
            session_context="mock",
            reasoning="mock",
        )

    async def fake_retrieve(self, typed_query, limit=10, score_threshold=None, metadata_filter=None):
        return QueryResult(query=typed_query, matched_contexts=[], searched_directories=[])

    monkeypatch.setattr(IntentAnalyzer, "analyze", fake_analyze)
    monkeypatch.setattr(HierarchicalRetriever, "retrieve", fake_retrieve)

    fs = _make_viking_fs()
    await fs.search(
        query="what changed",
        session_info={
            "summaries": ["alpha", "beta", "alpha", "  "],
            "summary": ["beta", "gamma"],
            "recent_messages": [{"role": "user", "content": "hello"}],
        },
    )

    assert captured["compression_summary"] == "alpha\n\nbeta\n\ngamma"


@pytest.mark.asyncio
async def test_search_accepts_string_forms_for_summaries(monkeypatch):
    """search() should also support string values for both summary keys."""
    from openviking.retrieve.hierarchical_retriever import HierarchicalRetriever
    from openviking.retrieve.intent_analyzer import IntentAnalyzer
    from openviking_cli.retrieve import ContextType, QueryPlan, QueryResult, TypedQuery

    captured: dict = {}

    async def fake_analyze(
        self,
        compression_summary,
        messages,
        current_message,
        context_type=None,
        target_abstract="",
    ):
        captured["compression_summary"] = compression_summary
        return QueryPlan(
            queries=[
                TypedQuery(
                    query=current_message,
                    context_type=ContextType.RESOURCE,
                    intent="test",
                    priority=1,
                )
            ],
            session_context="mock",
            reasoning="mock",
        )

    async def fake_retrieve(self, typed_query, limit=10, score_threshold=None, metadata_filter=None):
        return QueryResult(query=typed_query, matched_contexts=[], searched_directories=[])

    monkeypatch.setattr(IntentAnalyzer, "analyze", fake_analyze)
    monkeypatch.setattr(HierarchicalRetriever, "retrieve", fake_retrieve)

    fs = _make_viking_fs()
    await fs.search(
        query="legacy context",
        session_info={
            "summaries": "  fresh summary  ",
            "summary": "legacy summary",
            "recent_messages": [],
        },
    )

    assert captured["compression_summary"] == "fresh summary\n\nlegacy summary"
