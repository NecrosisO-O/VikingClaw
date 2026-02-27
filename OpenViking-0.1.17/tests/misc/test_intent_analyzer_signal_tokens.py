#!/usr/bin/env python3
# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for signal-token preservation in IntentAnalyzer query rewrite."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from openviking.retrieve.intent_analyzer import IntentAnalyzer
from openviking_cli.retrieve import ContextType


def test_extract_signal_tokens_keeps_identifier_like_values():
    text = "请回忆我的项目代号：PROBE_U1_1771767485933，首选编辑器是Editor-6。"
    tokens = IntentAnalyzer._extract_signal_tokens(text)

    assert "PROBE_U1_1771767485933" in tokens
    assert "Editor-6" in tokens


def test_enrich_query_appends_missing_signal_token():
    generated = "User's project code information"
    current = "请回忆我的项目代号：PROBE_U1_1771767485933"

    enriched = IntentAnalyzer._enrich_query_with_signal_tokens(generated, current)

    assert "User's project code information" in enriched
    assert "PROBE_U1_1771767485933" in enriched


def test_enrich_query_does_not_duplicate_existing_signal_token():
    generated = "User's project code information PROBE_U1_1771767485933"
    current = "请回忆我的项目代号：PROBE_U1_1771767485933"

    enriched = IntentAnalyzer._enrich_query_with_signal_tokens(generated, current)

    assert enriched == generated


def test_build_signal_source_uses_recent_user_memory_anchor():
    analyzer = IntentAnalyzer(max_recent_messages=5)

    class _Msg:
        def __init__(self, role: str, content: str):
            self.role = role
            self.content = content

    messages = [
        _Msg("assistant", "已记录。"),
        _Msg("user", "我的项目代号是PROBE_U9_20260222，首选编辑器是Editor-9。"),
    ]

    signal_source = analyzer._build_signal_source(
        messages=messages,
        current_message="我目前首选编辑器是什么？",
        query_context_type=ContextType.MEMORY,
    )
    enriched = IntentAnalyzer._enrich_query_with_signal_tokens("User's preferred editor", signal_source)

    assert "PROBE_U9_20260222" in enriched
    assert "Editor-9" in enriched


def test_build_signal_source_keeps_current_only_for_non_memory():
    analyzer = IntentAnalyzer(max_recent_messages=5)
    messages = [{"role": "user", "content": "我的项目代号是PROBE_U9_20260222"}]

    signal_source = analyzer._build_signal_source(
        messages=messages,
        current_message="请找一下 RFC 资源模板",
        query_context_type=ContextType.RESOURCE,
    )

    assert signal_source == "请找一下 RFC 资源模板"
