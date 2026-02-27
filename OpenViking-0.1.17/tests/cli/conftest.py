# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""CLI fixtures that run against a real in-process OpenViking HTTP server."""

import json
import os
import socket
import threading
import time
from pathlib import Path
from typing import Generator

import httpx
import pytest
import uvicorn

from openviking.server.app import create_app
from openviking.server.config import ServerConfig
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton


def _get_free_port() -> int:
    """Reserve a free port for the test server."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _wait_for_health(url: str, timeout_s: float = 20.0) -> None:
    """Poll the health endpoint until the server is ready."""
    deadline = time.time() + timeout_s
    last_error = None
    while time.time() < deadline:
        try:
            response = httpx.get(f"{url}/health", timeout=1.0)
            if response.status_code == 200:
                return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"OpenViking server failed to start: {last_error}")


@pytest.fixture(scope="session")
def openviking_server(tmp_path_factory: pytest.TempPathFactory) -> Generator[str, None, None]:
    """Start an in-process OpenViking server for CLI tests."""
    storage_dir = tmp_path_factory.mktemp("openviking_cli_data")
    port = _get_free_port()
    agfs_port = _get_free_port()

    # Load base config with fallback chain:
    # 1) OPENVIKING_CONFIG_FILE (if provided)
    # 2) examples/ov.conf
    # 3) examples/ov.conf.example
    config_candidates = []
    env_config_file = os.getenv("OPENVIKING_CONFIG_FILE")
    if env_config_file:
        config_candidates.append(Path(env_config_file).resolve())
    config_candidates.extend(
        [
            Path("examples/ov.conf").resolve(),
            Path("examples/ov.conf.example").resolve(),
        ]
    )

    base_conf_path = next((p for p in config_candidates if p.exists()), None)
    if base_conf_path is None:
        raise FileNotFoundError(
            "No base ov.conf found for CLI tests. "
            "Set OPENVIKING_CONFIG_FILE or provide examples/ov.conf(.example)."
        )

    with open(base_conf_path, encoding="utf-8") as f:
        conf_data = json.load(f)

    conf_data.setdefault("server", {})
    conf_data["server"]["host"] = "127.0.0.1"
    conf_data["server"]["port"] = port

    conf_data.setdefault("storage", {})
    conf_data["storage"].setdefault("vectordb", {})
    conf_data["storage"]["vectordb"]["backend"] = "local"
    conf_data["storage"]["vectordb"]["path"] = str(storage_dir)
    conf_data["storage"].setdefault("agfs", {})
    conf_data["storage"]["agfs"]["backend"] = "local"
    conf_data["storage"]["agfs"]["path"] = str(storage_dir)
    conf_data["storage"]["agfs"]["port"] = agfs_port

    # Write temporary ov.conf
    tmp_conf = storage_dir / "ov.conf"
    with open(tmp_conf, "w") as f:
        json.dump(conf_data, f)

    prev_config = os.environ.get("OPENVIKING_CONFIG_FILE")
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

    app_config = ServerConfig(api_key=None)
    # Let app lifespan initialize/close OpenVikingService inside uvicorn's loop.
    fastapi_app = create_app(config=app_config)

    uvi_config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(uvi_config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    url = f"http://127.0.0.1:{port}"

    try:
        _wait_for_health(url)
        # Avoid leaking fixture-specific config to the rest of the session.
        _restore_config_env()
        yield url
    finally:
        _restore_config_env()
        server.should_exit = True
        thread.join(timeout=10)
