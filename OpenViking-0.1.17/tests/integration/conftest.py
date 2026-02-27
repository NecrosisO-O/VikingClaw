# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

"""Shared fixtures for integration tests.

Automatically starts an OpenViking server in a background thread so that
AsyncHTTPClient integration tests can run without a manually started server process.
"""

import shutil
import socket
import threading
import time
from pathlib import Path
import hashlib
import json
import os
import random
from unittest.mock import patch

import httpx
import pytest
import uvicorn

from openviking.models.embedder.base import EmbedResult
from openviking.server.app import create_app
from openviking.server.config import ServerConfig
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

TEST_ROOT = Path(__file__).parent
TEST_TMP_DIR = TEST_ROOT / ".tmp_integration"


class _MockDenseEmbedder:
    """Deterministic in-process embedder for integration tests."""

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
            "reasoning": "offline integration test mock plan",
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
        # IntentAnalyzer expects a structured JSON object with "queries".
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
    """Force integration tests to run without external model dependencies."""
    default_config = TEST_ROOT.parent.parent / "examples" / "ov.conf.example"
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
def temp_dir():
    """Create temp directory for the whole test session."""
    shutil.rmtree(TEST_TMP_DIR, ignore_errors=True)
    TEST_TMP_DIR.mkdir(parents=True, exist_ok=True)
    yield TEST_TMP_DIR
    shutil.rmtree(TEST_TMP_DIR, ignore_errors=True)


@pytest.fixture(scope="session")
def server_url(temp_dir):
    """Start a real uvicorn server in a background thread.

    Returns the base URL (e.g. ``http://127.0.0.1:<port>``).
    The server is automatically shut down after the test session.
    """
    prev_config = os.environ.get("OPENVIKING_CONFIG_FILE")
    config_source = (
        Path(prev_config) if prev_config else (TEST_ROOT.parent.parent / "examples" / "ov.conf.example")
    )
    if config_source.exists():
        with open(config_source, "r", encoding="utf-8") as f:
            conf_data = json.load(f)
    else:
        conf_data = {}

    conf_data.setdefault("storage", {})
    server_data_dir = temp_dir / "http_data"
    server_data_dir.mkdir(parents=True, exist_ok=True)
    conf_data["storage"].setdefault("agfs", {})
    conf_data["storage"]["agfs"]["backend"] = "local"
    conf_data["storage"]["agfs"]["path"] = str(server_data_dir)

    conf_data["storage"].setdefault("vectordb", {})
    conf_data["storage"]["vectordb"]["backend"] = "local"
    conf_data["storage"]["vectordb"]["path"] = str(server_data_dir)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as agfs_sock:
        agfs_sock.bind(("127.0.0.1", 0))
        conf_data["storage"]["agfs"]["port"] = agfs_sock.getsockname()[1]

    tmp_conf = temp_dir / "ov.integration.http.conf"
    with open(tmp_conf, "w", encoding="utf-8") as f:
        json.dump(conf_data, f)

    os.environ["OPENVIKING_CONFIG_FILE"] = str(tmp_conf)
    OpenVikingConfigSingleton.reset_instance()

    config_restored = False

    def _restore_config_env() -> None:
        nonlocal config_restored
        if config_restored:
            return
        if prev_config is None:
            os.environ.pop("OPENVIKING_CONFIG_FILE", None)
        else:
            os.environ["OPENVIKING_CONFIG_FILE"] = prev_config
        OpenVikingConfigSingleton.reset_instance()
        config_restored = True

    config = ServerConfig(api_key=None)
    # Let app lifespan initialize/close OpenVikingService inside uvicorn's loop.
    fastapi_app = create_app(config=config)

    # Find a free port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    uvi_config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(uvi_config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait for server ready
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            r = httpx.get(f"{url}/health", timeout=1)
            if r.status_code == 200:
                break
        except Exception:
            time.sleep(0.1)
    else:
        _restore_config_env()
        server.should_exit = True
        thread.join(timeout=5)
        raise RuntimeError(f"OpenViking integration server failed to start at {url}")

    # Avoid leaking fixture-specific config to unrelated tests.
    _restore_config_env()

    yield url

    _restore_config_env()
    server.should_exit = True
    thread.join(timeout=5)
