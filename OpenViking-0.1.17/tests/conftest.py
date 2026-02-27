# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

"""Global test fixtures"""

import asyncio
import hashlib
import json
import os
import random
import shutil
from pathlib import Path
from typing import AsyncGenerator, Generator
from unittest.mock import patch

import pytest
import pytest_asyncio

from openviking import AsyncOpenViking
from openviking.models.embedder.base import EmbedResult
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

# Test data root directory
TEST_ROOT = Path(__file__).parent
TEST_TMP_DIR = TEST_ROOT / ".tmp"


class _MockDenseEmbedder:
    """Deterministic in-process embedder for offline tests."""

    is_sparse = False
    is_hybrid = False

    def __init__(self, dimension: int = 1024):
        self._dimension = dimension

    def get_dimension(self) -> int:
        return self._dimension

    def _vector(self, text: str) -> list[float]:
        seed = int(hashlib.md5(text.encode("utf-8")).hexdigest(), 16)
        rng = random.Random(seed)
        vector = [rng.uniform(-0.1, 0.1) for _ in range(self._dimension)]
        norm = sum(x * x for x in vector) ** 0.5
        if norm > 0:
            vector = [x / norm for x in vector]
        return vector

    def embed(self, text: str) -> EmbedResult:
        return EmbedResult(dense_vector=self._vector(text))

    def embed_batch(self, texts: list[str]) -> list[EmbedResult]:
        return [self.embed(t) for t in texts]

    def close(self):
        return None


class _MockVLM:
    """Lightweight VLM mock for semantic summary/overview generation."""

    def __init__(self):
        self._usage = {
            "total_usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "last_updated": "1970-01-01T00:00:00+00:00",
            },
            "usage_by_model": {},
        }

    def _mock_intent_plan(self, prompt: str) -> str:
        current_message = "context"
        lines = [line.strip() for line in prompt.splitlines()]
        for i, line in enumerate(lines):
            if line == "### Current Message":
                for follow in lines[i + 1 :]:
                    if follow:
                        current_message = follow
                        break
                break

        payload = {
            "reasoning": "offline test mock plan",
            "queries": [
                {
                    "query": current_message,
                    "context_type": "resource",
                    "intent": "retrieve related resources",
                    "priority": 1,
                }
            ],
        }
        return json.dumps(payload, ensure_ascii=False)

    def get_completion(self, prompt: str, *args, **kwargs) -> str:
        if "OpenViking's context query planner" in prompt:
            return self._mock_intent_plan(prompt)
        return f"mock vlm summary len={len(prompt)}"

    async def get_completion_async(self, prompt: str, *args, **kwargs) -> str:
        return self.get_completion(prompt, *args, **kwargs)

    def get_vision_completion(self, prompt: str, images=None, **kwargs) -> str:
        return self.get_completion(prompt, images=images, **kwargs)

    async def get_vision_completion_async(self, prompt: str, images=None, **kwargs) -> str:
        return self.get_vision_completion(prompt, images=images, **kwargs)

    def get_token_usage(self) -> dict:
        return self._usage


@pytest.fixture(scope="session", autouse=True)
def _offline_model_mocks():
    """Force tests to run without external model dependencies."""
    default_config = TEST_ROOT.parent / "examples" / "ov.conf.example"
    prev_config = os.environ.get("OPENVIKING_CONFIG_FILE")
    if prev_config is None and default_config.exists():
        os.environ["OPENVIKING_CONFIG_FILE"] = str(default_config)

    OpenVikingConfigSingleton.reset_instance()

    mock_embedder = _MockDenseEmbedder(dimension=1024)
    mock_vlm = _MockVLM()

    with (
        patch(
            "openviking_cli.utils.config.EmbeddingConfig.get_embedder",
            return_value=mock_embedder,
        ),
        patch(
            "openviking_cli.utils.config.VLMConfig.get_vlm_instance",
            return_value=mock_vlm,
        ),
    ):
        yield

    if prev_config is None:
        os.environ.pop("OPENVIKING_CONFIG_FILE", None)
    else:
        os.environ["OPENVIKING_CONFIG_FILE"] = prev_config
    OpenVikingConfigSingleton.reset_instance()


@pytest.fixture(scope="session")
def event_loop():
    """Create session-level event loop"""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="function")
def temp_dir() -> Generator[Path, None, None]:
    """Create temp directory, auto-cleanup before and after test"""
    shutil.rmtree(TEST_TMP_DIR, ignore_errors=True)
    TEST_TMP_DIR.mkdir(parents=True, exist_ok=True)
    yield TEST_TMP_DIR
    shutil.rmtree(TEST_TMP_DIR, ignore_errors=True)


@pytest.fixture(scope="function")
def test_data_dir(temp_dir: Path) -> Path:
    """Create test data directory"""
    data_dir = temp_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


@pytest.fixture(scope="function")
def sample_text_file(temp_dir: Path) -> Path:
    """Create sample text file"""
    file_path = temp_dir / "sample.txt"
    file_path.write_text("This is a sample text file for testing OpenViking.")
    return file_path


@pytest.fixture(scope="function")
def sample_markdown_file(temp_dir: Path) -> Path:
    """Create sample Markdown file"""
    file_path = temp_dir / "sample.md"
    file_path.write_text(
        """# Sample Document

## Introduction
This is a sample markdown document for testing OpenViking.

## Features
- Feature 1: Resource management
- Feature 2: Semantic search
- Feature 3: Session management

## Usage
Use this document to test various OpenViking functionalities.
"""
    )
    return file_path


@pytest.fixture(scope="function")
def sample_skill_file(temp_dir: Path) -> Path:
    """Create sample skill file in SKILL.md format"""
    file_path = temp_dir / "sample_skill.md"
    file_path.write_text(
        """---
name: sample-skill
description: A sample skill for testing OpenViking skill management
tags:
  - test
  - sample
---

# Sample Skill

## Description
A sample skill for testing OpenViking skill management.

## Usage
Use this skill when you need to test skill functionality.

## Instructions
1. Step one: Initialize the skill
2. Step two: Execute the skill
3. Step three: Verify the result
"""
    )
    return file_path


@pytest.fixture(scope="function")
def sample_directory(temp_dir: Path) -> Path:
    """Create sample directory with multiple files"""
    dir_path = temp_dir / "sample_dir"
    dir_path.mkdir(parents=True, exist_ok=True)

    (dir_path / "file1.txt").write_text("Content of file 1 for testing.")
    (dir_path / "file2.md").write_text("# File 2\nContent of file 2 for testing.")

    subdir = dir_path / "subdir"
    subdir.mkdir()
    (subdir / "file3.txt").write_text("Content of file 3 in subdir for testing.")

    return dir_path


@pytest.fixture(scope="function")
def sample_files(temp_dir: Path) -> list[Path]:
    """Create multiple sample files for batch testing"""
    files = []
    for i in range(3):
        file_path = temp_dir / f"batch_file_{i}.md"
        file_path.write_text(
            f"""# Batch File {i}

## Content
This is batch file number {i} for testing batch operations.

## Keywords
- batch
- test
- file{i}
"""
        )
        files.append(file_path)
    return files


# ============ Client Fixtures ============


@pytest_asyncio.fixture(scope="function")
async def client(test_data_dir: Path) -> AsyncGenerator[AsyncOpenViking, None]:
    """Create initialized OpenViking client"""
    await AsyncOpenViking.reset()

    client = AsyncOpenViking(path=str(test_data_dir))
    await client.initialize()

    yield client

    await client.close()
    await AsyncOpenViking.reset()


@pytest_asyncio.fixture(scope="function")
async def uninitialized_client(test_data_dir: Path) -> AsyncGenerator[AsyncOpenViking, None]:
    """Create uninitialized OpenViking client (for testing initialization flow)"""
    await AsyncOpenViking.reset()

    client = AsyncOpenViking(path=str(test_data_dir))

    yield client

    try:
        await client.close()
    except Exception:
        pass
    await AsyncOpenViking.reset()


@pytest_asyncio.fixture(scope="function")
async def client_with_resource_sync(
    client: AsyncOpenViking, sample_markdown_file: Path
) -> AsyncGenerator[tuple[AsyncOpenViking, str], None]:
    """Create client with resource (sync mode, wait for vectorization)"""
    result = await client.add_resource(
        path=str(sample_markdown_file), reason="Test resource", wait=True
    )
    uri = result.get("root_uri", "")

    yield client, uri


@pytest_asyncio.fixture(scope="function")
async def client_with_resource(
    client: AsyncOpenViking, sample_markdown_file: Path
) -> AsyncGenerator[tuple[AsyncOpenViking, str], None]:
    """Create client with resource (async mode, no wait for vectorization)"""
    result = await client.add_resource(path=str(sample_markdown_file), reason="Test resource")
    uri = result.get("root_uri", "")
    yield client, uri
