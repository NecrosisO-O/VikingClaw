# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List

from openviking.storage.viking_vector_index_backend import VikingVectorIndexBackend


class _FakeResultItem:
    def __init__(self, item_id: str, fields: Dict[str, Any]):
        self.id = item_id
        self.fields = fields


class _FakeSearchResult:
    def __init__(self, data: List[_FakeResultItem]):
        self.data = data


class _FakeCollection:
    def __init__(self):
        self.upsert_payloads: List[List[Dict[str, Any]]] = []
        self.search_result = _FakeSearchResult([])

    def upsert_data(self, data_list: List[Dict[str, Any]]):
        self.upsert_payloads.append(data_list)

    def search_by_random(self, index_name: str, limit: int, filters: Dict[str, Any]):
        return self.search_result


async def test_insert_reuses_latest_uri_record_and_cleans_stale_duplicates():
    backend = object.__new__(VikingVectorIndexBackend)
    fake_coll = _FakeCollection()

    backend._get_collection = lambda _collection: fake_coll  # type: ignore[attr-defined]
    backend._get_meta_data = lambda _name, _coll: {  # type: ignore[attr-defined]
        "Fields": [
            {"FieldName": "id"},
            {"FieldName": "uri"},
            {"FieldName": "context_type"},
            {"FieldName": "abstract"},
            {"FieldName": "updated_at"},
            {"FieldName": "created_at"},
        ]
    }

    async def _fake_filter(*, collection, filter, limit, **kwargs):  # type: ignore[no-untyped-def]
        assert collection == "context"
        assert filter == {"op": "must", "field": "uri", "conds": ["viking://user/memories/pref.md"]}
        assert limit == 10000
        return [
            {"id": "dup_old", "updated_at": "2026-02-20T10:00:00"},
            {"id": "dup_new", "updated_at": "2026-02-22T10:00:00"},
            {"id": "dup_older", "updated_at": "2026-02-10T10:00:00"},
        ]

    deleted_ids: List[List[str]] = []

    async def _fake_delete(_collection: str, ids: List[str]) -> int:
        deleted_ids.append(ids)
        return len(ids)

    backend.filter = _fake_filter  # type: ignore[method-assign]
    backend.delete = _fake_delete  # type: ignore[method-assign]

    record_id = await backend.insert(
        "context",
        {
            "uri": "viking://user/memories/pref.md",
            "context_type": "memory",
            "abstract": "编辑器偏好已更新为 Helix",
            "updated_at": "2026-02-22T10:30:00",
        },
    )

    assert record_id == "dup_new"
    assert deleted_ids == [["dup_old", "dup_older"]]
    assert len(fake_coll.upsert_payloads) == 1
    assert fake_coll.upsert_payloads[0][0]["id"] == "dup_new"


async def test_fetch_by_uri_returns_single_record():
    backend = object.__new__(VikingVectorIndexBackend)
    fake_coll = _FakeCollection()
    fake_coll.search_result = _FakeSearchResult(
        [_FakeResultItem("rec_1", {"uri": "viking://user/memories/pref.md", "abstract": "Helix"})]
    )

    backend._get_collection = lambda _collection: fake_coll  # type: ignore[attr-defined]

    record = await backend.fetch_by_uri("context", "viking://user/memories/pref.md")

    assert record is not None
    assert record["id"] == "rec_1"
    assert record["abstract"] == "Helix"


async def test_remove_by_uri_deletes_all_duplicate_records_for_same_uri():
    backend = object.__new__(VikingVectorIndexBackend)

    async def _fake_filter(*, collection, filter, limit, **kwargs):  # type: ignore[no-untyped-def]
        assert collection == "context"
        assert limit == 10000
        if filter == {"op": "must", "field": "uri", "conds": ["viking://user/memories/pref.md"]}:
            return [
                {"id": "id_1", "uri": "viking://user/memories/pref.md", "is_leaf": True},
                {"id": "id_2", "uri": "viking://user/memories/pref.md", "is_leaf": True},
            ]
        return []

    deleted_ids: List[List[str]] = []

    async def _fake_delete(_collection: str, ids: List[str]) -> int:
        deleted_ids.append(ids)
        return len(ids)

    backend.filter = _fake_filter  # type: ignore[method-assign]
    backend.delete = _fake_delete  # type: ignore[method-assign]

    removed = await backend.remove_by_uri("context", "viking://user/memories/pref.md")

    assert removed == 2
    assert deleted_ids == [["id_1", "id_2"]]
