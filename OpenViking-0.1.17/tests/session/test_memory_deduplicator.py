# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

"""Memory deduplicator behavior tests."""

from unittest.mock import AsyncMock

from openviking.core.context import Context
from openviking.models.embedder.base import EmbedResult
from openviking.session.memory_deduplicator import DedupDecision, MemoryDeduplicator
from openviking.session.memory_extractor import CandidateMemory, MemoryCategory


class _DummyVikingDB:
    def get_embedder(self):
        return None


class _FallbackSearchVikingDB:
    def __init__(self):
        self.calls = []

    def get_embedder(self):
        class _DummyEmbedder:
            def embed(self, _text: str) -> EmbedResult:
                return EmbedResult(dense_vector=[0.1, 0.2, 0.3])

        return _DummyEmbedder()

    async def search(self, collection, query_vector, limit, filter):
        self.calls.append(
            {
                "collection": collection,
                "query_vector": query_vector,
                "limit": limit,
                "filter": filter,
            }
        )
        conds = filter.get("conds", []) if isinstance(filter, dict) else []
        has_category_filter = any(c.get("field") == "category" for c in conds if isinstance(c, dict))
        if has_category_filter:
            return []
        return [
            {
                "uri": "viking://user/memories/preferences/mem_existing.md",
                "is_leaf": True,
                "context_type": "memory",
                "category": "",
                "score": 0.81,
                "abstract": "existing preference memory",
            }
        ]


class _NoVectorHitVikingDB:
    def get_embedder(self):
        class _DummyEmbedder:
            def embed(self, _text: str) -> EmbedResult:
                return EmbedResult(dense_vector=[0.1, 0.2, 0.3])

        return _DummyEmbedder()

    async def search(self, collection, query_vector, limit, filter):
        return []


class _AvailableVLM:
    @staticmethod
    def is_available() -> bool:
        return True

    async def get_completion_async(self, _prompt: str) -> str:
        return '{"decision":"merge","reason":"llm decision ok"}'


class _ConfigWithAvailableVLM:
    def __init__(self):
        self.vlm = _AvailableVLM()


def _candidate(
    category: MemoryCategory,
    *,
    abstract: str = "candidate abstract",
    content: str = "candidate content",
    overview: str = "candidate overview",
) -> CandidateMemory:
    return CandidateMemory(
        category=category,
        abstract=abstract,
        overview=overview,
        content=content,
        source_session="session-test",
        user="default",
        language="en",
    )


def _similar_memory(category: str = "preferences") -> Context:
    return Context(
        uri=f"viking://user/memories/{category}/mem_existing.md",
        parent_uri=f"viking://user/memories/{category}",
        is_leaf=True,
        abstract="existing memory",
        context_type="memory",
        category=category,
    )


async def test_preferences_with_similar_memory_prefers_merge(monkeypatch):
    deduplicator = MemoryDeduplicator(vikingdb=_DummyVikingDB())
    monkeypatch.setattr(
        deduplicator,
        "_find_similar_memories",
        AsyncMock(return_value=[_similar_memory("preferences")]),
    )
    llm_decision = AsyncMock(return_value=(DedupDecision.CREATE, "llm suggested create"))
    monkeypatch.setattr(deduplicator, "_llm_decision", llm_decision)

    result = await deduplicator.deduplicate(_candidate(MemoryCategory.PREFERENCES))

    assert result.decision == DedupDecision.MERGE
    assert "Preference memory update" in result.reason
    llm_decision.assert_not_awaited()


async def test_non_preferences_follow_llm_decision(monkeypatch):
    deduplicator = MemoryDeduplicator(vikingdb=_DummyVikingDB())
    monkeypatch.setattr(
        deduplicator,
        "_find_similar_memories",
        AsyncMock(return_value=[_similar_memory("events")]),
    )
    llm_decision = AsyncMock(return_value=(DedupDecision.SKIP, "llm suggested skip"))
    monkeypatch.setattr(deduplicator, "_llm_decision", llm_decision)

    result = await deduplicator.deduplicate(_candidate(MemoryCategory.EVENTS))

    assert result.decision == DedupDecision.SKIP
    assert result.reason == "llm suggested skip"
    llm_decision.assert_awaited_once()


async def test_llm_decision_handles_context_without_abstract_cache(monkeypatch):
    deduplicator = MemoryDeduplicator(vikingdb=_DummyVikingDB())
    monkeypatch.setattr(
        "openviking.session.memory_deduplicator.get_openviking_config",
        lambda: _ConfigWithAvailableVLM(),
    )

    decision, reason = await deduplicator._llm_decision(
        _candidate(MemoryCategory.EVENTS),
        [_similar_memory("events")],
    )

    assert decision == DedupDecision.MERGE
    assert reason == "llm decision ok"


async def test_no_similar_memory_creates_without_llm(monkeypatch):
    deduplicator = MemoryDeduplicator(vikingdb=_DummyVikingDB())
    monkeypatch.setattr(
        deduplicator,
        "_find_similar_memories",
        AsyncMock(return_value=[]),
    )
    llm_decision = AsyncMock(return_value=(DedupDecision.MERGE, "unused"))
    monkeypatch.setattr(deduplicator, "_llm_decision", llm_decision)

    result = await deduplicator.deduplicate(_candidate(MemoryCategory.ENTITIES))

    assert result.decision == DedupDecision.CREATE
    assert result.reason == "No similar memories found"
    llm_decision.assert_not_awaited()


async def test_find_similar_memories_falls_back_when_category_missing():
    db = _FallbackSearchVikingDB()
    deduplicator = MemoryDeduplicator(vikingdb=db)

    similar = await deduplicator._find_similar_memories(_candidate(MemoryCategory.PREFERENCES))

    assert len(similar) == 1
    assert similar[0].uri.startswith("viking://user/memories/preferences/")
    assert len(db.calls) == 2


async def test_find_similar_memories_falls_back_to_fs_when_vector_not_ready(monkeypatch):
    class _FakeVikingFS:
        async def ls(self, _uri: str, output: str = "original"):
            assert output == "original"
            return [
                {
                    "uri": "viking://user/memories/preferences/mem_existing.md",
                    "isDir": False,
                }
            ]

        async def read_file(self, _uri: str):
            return "用户当前主要使用Helix，Neovim仅偶尔使用。"

        async def abstract(self, _uri: str):
            return "代码编辑器偏好：主要使用Helix，仅偶尔使用Neovim"

    monkeypatch.setattr(
        "openviking.storage.viking_fs.get_viking_fs",
        lambda: _FakeVikingFS(),
    )

    deduplicator = MemoryDeduplicator(vikingdb=_NoVectorHitVikingDB())
    similar = await deduplicator._find_similar_memories(
        _candidate(
            MemoryCategory.PREFERENCES,
            abstract="代码编辑器偏好：主要使用Helix，仅偶尔使用Neovim",
            content="用户更新了编辑器偏好，当前主要使用Helix。",
            overview="更新后的编辑器偏好",
        )
    )

    assert len(similar) == 1
    assert similar[0].uri == "viking://user/memories/preferences/mem_existing.md"
