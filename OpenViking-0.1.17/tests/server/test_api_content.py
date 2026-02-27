# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

"""Tests for content endpoints: read, abstract, overview."""


async def test_read_content(client_with_resource):
    client, uri = client_with_resource
    # The resource URI may be a directory; list recursively and pick a leaf file.
    ls_resp = await client.get("/api/v1/fs/ls", params={"uri": uri, "recursive": True})
    assert ls_resp.status_code == 200
    entries = ls_resp.json().get("result", [])

    file_uri = None
    for entry in entries:
        if isinstance(entry, dict) and not entry.get("isDir"):
            file_uri = entry.get("uri")
            break

    if not file_uri:
        file_uri = uri

    resp = await client.get(
        "/api/v1/content/read", params={"uri": file_uri}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["result"] is not None


async def test_abstract_content(client_with_resource):
    client, uri = client_with_resource
    resp = await client.get(
        "/api/v1/content/abstract", params={"uri": uri}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


async def test_overview_content(client_with_resource):
    client, uri = client_with_resource
    resp = await client.get(
        "/api/v1/content/overview", params={"uri": uri}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
