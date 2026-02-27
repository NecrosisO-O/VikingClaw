# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for Viking URI root handling."""

from openviking_cli.utils.uri import VikingURI


def test_root_uri_is_parsed() -> None:
    uri = VikingURI("viking://")

    assert uri.scope == ""
    assert uri.full_path == ""
    assert VikingURI.is_valid("viking://")


def test_join_from_root_preserves_scheme() -> None:
    assert VikingURI("viking://").join("resources").uri == "viking://resources"
    assert VikingURI("viking://").join("/resources/docs/").uri == "viking://resources/docs"


def test_root_uri_has_no_parent() -> None:
    assert VikingURI("viking://").parent is None
