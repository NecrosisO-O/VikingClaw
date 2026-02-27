# OpenClaw x OpenViking Integration

Chinese version: [README.zh-CN.md](./README.zh-CN.md)

This repository targets a **single-user, long-horizon assistant** deployment model:

- **OpenClaw** provides the conversation entrypoints, tool execution, and multi-channel runtime.
- **OpenViking** provides long-term memory, context retrieval, and session persistence.

The goal is not a shallow combination of two projects. The goal is practical, day-to-day collaboration quality:
persistent memory, controllable retrieval, explainable behavior, and operable migration workflows.

## AI Assistance Notice

- This repository includes upstream code snapshots (`openclaw-2026.2.19/`, `OpenViking-0.1.17/`) that were not independently generated within this repository.
- Integration changes, configuration work, and documentation updates in this repository were produced with AI coding assistant support.

## Project Scope

This project is intended for scenarios where:

1. You want a long-term assistant, not just stateless single-turn Q&A.
2. You want context to come from conversation history plus resources and skills.
3. You want memory behavior to be observable, auditable, and portable.

## Core Capabilities

### 1. Unified Context Surface (memory/resource/skill)

OpenViking uses filesystem-style semantics to unify context sources, and OpenClaw can retrieve across:

- Memory fragments
- Resource documents
- Skill-related context

### 2. Layered Retrieval and Injection Budgeting

Layered reads (`l0/l1/l2/progressive`) plus injection budgets are used to:

- Keep relevant context
- Reduce context overload
- Improve response stability and controllability

### 3. Automatic Session Persistence and Async Commits

Messages and tool events are written to an outbox and asynchronously committed into OpenViking,
so memory accumulates over time and remains searchable.

### 4. Retrieval Observability

`memory search-trace` and `status` signals expose:

- Retrieval strategy and layer decisions
- Budget hit/cut behavior
- Timeliness signals (flush/commit/lag)

### 5. Governance Surface (Session/FS/Relation/Pack)

CLI operations support:

- Session query, append, delete, extract
- Filesystem read and policy-gated write
- Relation link management
- Pack export/import for migration and backup

## Repository Layout

```text
.
├── openclaw-2026.2.19/      # OpenClaw integration code (primary workspace)
├── OpenViking-0.1.17/       # OpenViking source snapshot (server-side and integration reference)
├── README.md                # Main English README
├── README.zh-CN.md          # Chinese README
├── LICENSE                  # Root-level license note (aggregate repo)
└── NOTICE                   # Third-party attribution and notices
```

## Architecture Overview

```text
User / Channel / CLI
        |
        v
  OpenClaw Gateway
        |
        +--> LLM Answer + Tool Execution
        |
        +--> OpenViking Memory Backend
                  |
                  +--> Search/Find/Grep/Glob   (read path)
                  +--> Event Outbox + Commit   (write path)
                  +--> Session/FS/Relation/Pack
```

Read path and write path are separated to preserve response experience while maintaining durable memory growth.

## Environment Requirements

Recommended baseline:

- Node.js `>= 22.12.0`
- pnpm `>= 10`
- Python `3.11 - 3.13`
- Linux / macOS (Windows via WSL2 recommended)

## Quick Start (Local Minimal Setup)

### 1) Install OpenViking

```bash
cd OpenViking-0.1.17
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -e .[test]
```

### 2) Configure OpenViking (`~/.openviking/ov.conf`)

```json
{
  "embedding": {
    "dense": {
      "provider": "volcengine",
      "api_key": "YOUR_API_KEY",
      "model": "doubao-embedding-vision-250615",
      "dimension": 1024,
      "input": "multimodal"
    }
  },
  "vlm": {
    "provider": "volcengine",
    "api_key": "YOUR_API_KEY",
    "model": "doubao-seed-1-8-251228"
  },
  "storage": {
    "agfs": { "backend": "local", "path": "./data" },
    "vectordb": { "backend": "local", "path": "./data" }
  },
  "server": {
    "host": "127.0.0.1",
    "port": 9432
  }
}
```

Start server:

```bash
python -m openviking serve --config ~/.openviking/ov.conf --host 127.0.0.1 --port 9432
```

### 3) Install OpenClaw

```bash
cd openclaw-2026.2.19
pnpm install
pnpm ui:build
pnpm build
```

### 4) Configure OpenClaw (`~/.openclaw/openclaw.json`)

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
  memory: {
    backend: "openviking",
    openviking: {
      endpoint: "http://127.0.0.1:9432",
      dualWrite: true,
      commit: {
        mode: "async",
        triggers: {
          sessionEnd: true,
          reset: true,
          everyNMessages: 24,
          everyNMinutes: 12,
        },
      },
      outbox: {
        enabled: true,
        flushIntervalMs: 2000,
        maxBatchSize: 25,
        retryBaseMs: 1000,
        retryMaxMs: 60000,
      },
      search: {
        strategy: "auto",
        readLayer: "progressive",
        maxEntries: 6,
        maxSnippetChars: 560,
        maxInjectedChars: 3200,
        relationExpansion: false,
      },
    },
  },
}
```

### 5) Start and Validate

```bash
cd openclaw-2026.2.19
pnpm openclaw gateway --port 18789 --verbose
```

In another terminal:

```bash
cd openclaw-2026.2.19
pnpm openclaw status
pnpm openclaw health
pnpm openclaw agent --message "Please remember that I prefer concise answers"
```

## Common Commands

Run the following under `openclaw-2026.2.19`.

### Runtime and Health

```bash
pnpm openclaw gateway --port 18789 --verbose
pnpm openclaw status
pnpm openclaw health
```

### Retrieval and Observability

```bash
pnpm openclaw memory status
pnpm openclaw memory search "deployment notes"
pnpm openclaw memory search-trace
pnpm openclaw memory find "where is the openclaw config file" --limit 8
pnpm openclaw memory grep viking://resources "OPENAI_API_KEY" --case-insensitive
pnpm openclaw memory glob "**/*.md" --uri viking://resources
```

### Session Governance

```bash
pnpm openclaw memory sessions-list
pnpm openclaw memory sessions-get <session_id>
pnpm openclaw memory sessions-extract <session_id>
pnpm openclaw memory sessions-message <session_id> user "remember this preference"
pnpm openclaw memory sessions-delete <session_id>
```

### Resources and Migration

```bash
pnpm openclaw memory ingest-resource ./docs/runbook.md --wait
pnpm openclaw memory ingest-skill --data '{"name":"incident-playbook"}' --wait
pnpm openclaw memory pack-export viking://resources/docs /tmp/docs.ovpack
pnpm openclaw memory pack-import /tmp/docs.ovpack viking://resources --force
```

### FS and Relations (Policy-Gated)

```bash
pnpm openclaw memory fs-ls viking://resources --recursive
pnpm openclaw memory fs-tree viking://resources
pnpm openclaw memory fs-stat viking://resources/docs
pnpm openclaw memory fs-mkdir viking://resources/docs/new-folder
pnpm openclaw memory fs-rm viking://resources/docs/old-folder --yes
pnpm openclaw memory fs-mv viking://resources/docs/a viking://resources/docs/archive/a
pnpm openclaw memory relations viking://resources/docs/guide
pnpm openclaw memory relation-link viking://resources/docs/a viking://resources/docs/b --reason "same topic"
pnpm openclaw memory relation-unlink viking://resources/docs/a viking://resources/docs/b
```

## Production Deployment Notes

1. Run OpenViking and OpenClaw as independent long-running services (systemd/launchd/container).
2. Put OpenViking data directories on stable storage and include them in backups.
3. For cross-host deployments, enable OpenViking API key and set `memory.openviking.apiKey` in OpenClaw.
4. Include periodic pack export in backup/recovery operations.

## Important Behavior Notes

1. Memory commits are asynchronous by default (eventual consistency), so updates may not be instantly retrievable in the next turn.
2. `search-trace` currently provides text/JSON diagnostics, not a graphical trajectory UI.
3. Configure allow/deny/protected FS policies before enabling write operations.

## Development and Upgrade Strategy

1. This repository is an integration workspace, not an official OpenClaw or OpenViking release repository.
2. For upstream upgrades, evaluate diffs on a branch first, then migrate into the integration branch.
3. Primary integration-sensitive paths:
   - `openclaw-2026.2.19/src/memory/openviking/`
   - `openclaw-2026.2.19/src/memory/backend-config.ts`
   - `openclaw-2026.2.19/src/cli/memory-cli.ts`
   - `openclaw-2026.2.19/src/commands/status.command.ts`

## License and Attribution

- Root-level licensing note: see `LICENSE`
- Third-party attribution: see `NOTICE`
- Upstream licenses remain unchanged:
  - `openclaw-2026.2.19/`: MIT
  - `OpenViking-0.1.17/`: Apache-2.0

## Upstream Links

- OpenClaw GitHub: <https://github.com/openclaw/openclaw>
- OpenClaw Docs: <https://docs.openclaw.ai/start/getting-started>
- OpenViking GitHub: <https://github.com/volcengine/OpenViking>
- OpenViking Docs: <https://www.openviking.ai/docs>
