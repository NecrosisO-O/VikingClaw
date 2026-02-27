#!/usr/bin/env python3
# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for signal-token score bonus in hierarchical retrieval."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from openviking.retrieve.hierarchical_retriever import HierarchicalRetriever


def test_extract_signal_tokens_for_identifier_like_query():
    query = "请回忆我的项目代号：PROBE_U3_1771768588882 和 Editor-3"
    tokens = HierarchicalRetriever._extract_signal_tokens(query)

    assert "PROBE_U3_1771768588882" in tokens
    assert "Editor-3" in tokens


def test_signal_token_bonus_positive_when_abstract_contains_marker():
    query = "User project code PROBE_U3_1771768588882"
    abstract = "关联项目: 项目代号为PROBE_U3_1771768588882"

    bonus = HierarchicalRetriever._signal_token_bonus(query, abstract)

    assert bonus > 0


def test_signal_token_bonus_zero_for_plain_natural_language_query():
    query = "what is my preferred editor"
    abstract = "编辑器偏好: 首选Editor-6"

    bonus = HierarchicalRetriever._signal_token_bonus(query, abstract)

    assert bonus == 0.0
