#!/usr/bin/env python3
import argparse
import json
import os
import re
import signal
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse


def now_ms() -> int:
  return int(time.time() * 1000)


class RuntimeState:
  def __init__(self) -> None:
    self._lock = threading.Lock()
    self.sessions: dict[str, list[dict[str, Any]]] = {}
    self.resources: dict[str, dict[str, str]] = {}

  def create_session(self) -> str:
    session_id = f"s-{uuid.uuid4().hex}"
    with self._lock:
      self.sessions.setdefault(session_id, [])
    return session_id

  def append_events(self, session_id: str, events: list[dict[str, Any]]) -> int:
    dedup: dict[str, dict[str, Any]] = {}
    for event in events:
      event_id = str(event.get("event_id") or uuid.uuid4().hex)
      dedup[event_id] = {
        "event_id": event_id,
        "event_type": str(event.get("event_type") or "message"),
        "role": str(event.get("role") or ""),
        "content": str(event.get("content") or ""),
        "metadata": event.get("metadata") if isinstance(event.get("metadata"), dict) else {},
        "cause": str(event.get("cause") or ""),
      }
    with self._lock:
      bucket = self.sessions.setdefault(session_id, [])
      existing_ids = {str(item.get("event_id") or "") for item in bucket}
      inserted = 0
      for item in dedup.values():
        if item["event_id"] in existing_ids:
          continue
        bucket.append(item)
        inserted += 1
      return inserted

  def build_snippet(self, session_id: str | None, query: str) -> tuple[str, str]:
    query_lower = query.lower().strip()
    with self._lock:
      if session_id and session_id in self.sessions:
        candidates = self.sessions[session_id]
      else:
        candidates = []
        for events in self.sessions.values():
          candidates.extend(events)

      ranked: list[str] = []
      for event in candidates:
        content = str(event.get("content") or "").strip()
        if not content:
          continue
        if query_lower and query_lower in content.lower():
          ranked.insert(0, content)
        else:
          ranked.append(content)

      if not ranked:
        return (
          "No matching context yet. Add events first.",
          "mock runtime context is currently empty",
        )

      overview = " | ".join(ranked[:4])
      abstract = ranked[0]
      if len(overview) > 1200:
        overview = overview[:1200]
      if len(abstract) > 400:
        abstract = abstract[:400]
      return (overview, abstract)

  def add_resource(self, source_path: str) -> tuple[str, str]:
    basename = os.path.basename(source_path.strip()) or "resource.md"
    stem = basename.rsplit(".", 1)[0].strip() or "resource"
    slug = re.sub(r"[^a-z0-9._-]+", "-", stem.lower()).strip("-") or "resource"
    uri = f"viking://resources/{slug}/{basename}"
    text = ""
    try:
      with open(source_path, "r", encoding="utf-8") as handle:
        text = handle.read()
    except Exception:
      text = ""
    with self._lock:
      self.resources[uri] = {
        "uri": uri,
        "text": text,
        "basename": basename,
        "slug": slug,
      }
    return uri, text

  def read_resource(self, uri: str) -> dict[str, str] | None:
    with self._lock:
      item = self.resources.get(uri)
      if not item:
        return None
      return dict(item)

  def search_resources(self, query: str) -> list[dict[str, Any]]:
    query_lower = query.lower().strip()
    with self._lock:
      values = list(self.resources.values())
    rows: list[dict[str, Any]] = []
    for item in values:
      text = item.get("text", "")
      score = 0.5
      if query_lower and query_lower in text.lower():
        score = 0.93
      elif query_lower:
        continue
      rows.append(
        {
          "uri": item["uri"],
          "context_type": "resource",
          "abstract": text[:400] if text else item["basename"],
          "overview": text[:1000] if text else item["basename"],
          "score": score,
          "match_reason": "runtime-mock-resource-match",
        }
      )
    rows.sort(key=lambda entry: float(entry.get("score", 0)), reverse=True)
    return rows[:3]


STATE = RuntimeState()


class Handler(BaseHTTPRequestHandler):
  protocol_version = "HTTP/1.1"

  def log_message(self, fmt: str, *args: Any) -> None:
    return

  def _read_json(self) -> dict[str, Any]:
    length_raw = self.headers.get("Content-Length")
    if not length_raw:
      return {}
    try:
      length = int(length_raw)
    except ValueError:
      return {}
    if length <= 0:
      return {}
    body = self.rfile.read(length)
    try:
      parsed = json.loads(body.decode("utf-8"))
      return parsed if isinstance(parsed, dict) else {}
    except Exception:
      return {}

  def _write_json(self, payload: dict[str, Any], status: int = 200) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(raw)))
    self.end_headers()
    self.wfile.write(raw)

  def _ok(self, result: Any) -> None:
    self._write_json({"status": "ok", "result": result}, 200)

  def _error(self, message: str, status: int = 400) -> None:
    self._write_json({"status": "error", "error": {"message": message}}, status)

  def do_GET(self) -> None:
    parsed = urlparse(self.path)
    path = parsed.path
    if path == "/health":
      self._ok({"healthy": True, "ts": now_ms()})
      return

    if path == "/api/v1/content/read" or path == "/api/v1/content/abstract" or path == "/api/v1/content/overview":
      query = parse_qs(parsed.query)
      uri = (query.get("uri", [""])[0] or "").strip()
      resource = STATE.read_resource(uri)
      if resource:
        text = resource.get("text", "")
        abstract = text[:400] if text else resource.get("basename", "")
        overview = text[:1000] if text else resource.get("basename", "")
        if path.endswith("/read"):
          self._ok(text)
        elif path.endswith("/abstract"):
          self._ok(abstract)
        else:
          self._ok(overview)
        return
      session_id = ""
      match = re.match(r"^viking://session/([^/]+)$", uri)
      if match:
        session_id = match.group(1)
      overview, abstract = STATE.build_snippet(session_id or None, "")
      if path.endswith("/read"):
        self._ok(overview)
      elif path.endswith("/abstract"):
        self._ok(abstract)
      else:
        self._ok(overview)
      return

    if path.startswith("/api/v1/fs/"):
      self._ok([])
      return

    if path == "/api/v1/relations":
      self._ok([])
      return

    if path.startswith("/api/v1/observer/"):
      name = path.rsplit("/", 1)[-1]
      if name == "system":
        self._ok(
          {
            "is_healthy": True,
            "errors": [],
            "components": {
              "queue": {"name": "queue", "is_healthy": True, "has_errors": False},
              "vikingdb": {"name": "vikingdb", "is_healthy": True, "has_errors": False},
              "vlm": {"name": "vlm", "is_healthy": True, "has_errors": False},
              "transaction": {"name": "transaction", "is_healthy": True, "has_errors": False},
            },
          }
        )
      else:
        self._ok({"name": name, "is_healthy": True, "has_errors": False})
      return

    self._error(f"unsupported endpoint: {path}", 404)

  def do_POST(self) -> None:
    parsed = urlparse(self.path)
    path = parsed.path
    payload = self._read_json()

    if path == "/api/v1/sessions":
      session_id = STATE.create_session()
      self._ok({"session_id": session_id})
      return

    if path == "/api/v1/search/search":
      query = str(payload.get("query") or "").strip()
      session_id = str(payload.get("session_id") or "").strip() or None
      overview, abstract = STATE.build_snippet(session_id, query)
      uri = f"viking://session/{session_id or 'global'}"
      entry = {
        "uri": uri,
        "context_type": "memory",
        "abstract": abstract,
        "overview": overview,
        "score": 0.98,
        "match_reason": "runtime-mock-match",
      }
      self._ok(
        {
          "memories": [entry],
          "resources": STATE.search_resources(query),
          "skills": [],
          "query_plan": {
            "queries": [
              {
                "query": query or "context",
                "context_type": "memory",
                "intent": "retrieve related memory",
                "priority": 1,
              }
            ]
          },
          "query_results": [{"id": "runtime-mock-r1", "context_type": "memory", "score": 0.98}],
          "total": 1,
        }
      )
      return

    if path == "/api/v1/resources":
      source_path = str(payload.get("path") or "").strip()
      if not source_path:
        self._error("path is required", 400)
        return
      uri, _ = STATE.add_resource(source_path)
      self._ok({"uri": uri, "enqueued": True, "waited": bool(payload.get("wait"))})
      return

    if path == "/api/v1/skills":
      self._ok({"uri": "viking://skills/runtime-mock", "enqueued": True})
      return

    if path == "/api/v1/system/wait":
      self._ok({"done": True})
      return

    match_events = re.match(r"^/api/v1/sessions/([^/]+)/events/batch$", path)
    if match_events:
      session_id = match_events.group(1)
      events = payload.get("events")
      if not isinstance(events, list):
        self._error("events must be a list", 400)
        return
      inserted = STATE.append_events(session_id, [event for event in events if isinstance(event, dict)])
      self._ok({"inserted": inserted})
      return

    match_commit = re.match(r"^/api/v1/sessions/([^/]+)/commit$", path)
    if match_commit:
      session_id = match_commit.group(1)
      self._ok({"session_id": session_id, "committed": True})
      return

    self._error(f"unsupported endpoint: {path}", 404)

  def do_DELETE(self) -> None:
    parsed = urlparse(self.path)
    if parsed.path == "/api/v1/relations/link":
      self._ok({"removed": True})
      return
    self._error(f"unsupported endpoint: {parsed.path}", 404)


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--config", required=True)
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, required=True)
  parser.add_argument("--log-level", default="warning")
  args = parser.parse_args()

  server = ThreadingHTTPServer((args.host, args.port), Handler)

  def _shutdown(*_args: Any) -> None:
    threading.Thread(target=server.shutdown, daemon=True).start()

  signal.signal(signal.SIGINT, _shutdown)
  signal.signal(signal.SIGTERM, _shutdown)
  server.serve_forever()


if __name__ == "__main__":
  main()
