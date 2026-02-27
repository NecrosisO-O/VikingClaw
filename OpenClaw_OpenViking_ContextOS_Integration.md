# OpenClaw x OpenViking Integration Architecture (Current Implementation)

Updated: 2026-02-27

## 1. Scope

This document describes the architecture that is actually implemented in this repository.

Important reality:

1. OpenClaw supports multiple memory backends (`builtin`, `qmd`, `openviking`).
2. The default backend is still `builtin`.
3. The architecture below is the effective runtime model when `memory.backend=openviking` is enabled.

Main anchor: `openclaw-2026.2.19/src/memory/backend-config.ts`

## 2. Runtime Topology

```text
User / Channel / CLI
        |
        v
OpenClaw Gateway (runtime orchestrator, tools, agent lifecycle)
        |
        +--> OpenVikingMemoryManager (read path)
        |       |
        |       +--> search/search + content/read/overview/abstract
        |       +--> strategy planner (memory/resource/skill priority)
        |       +--> optional relation expansion (BFS-style)
        |
        +--> OpenViking Bridge + Outbox (write path)
                |
                +--> session linking
                +--> events batch append
                +--> async/sync commit triggers
                +--> durable outbox retry/flush
```

Core implementation files:

- `openclaw-2026.2.19/src/memory/openviking/manager.ts`
- `openclaw-2026.2.19/src/memory/openviking/bridge.ts`
- `openclaw-2026.2.19/src/memory/openviking/outbox.ts`
- `openclaw-2026.2.19/src/memory/openviking/client.ts`

## 3. Backend Resolution and Defaults

### 3.1 Backend resolution

OpenClaw resolves backend from config and instantiates the matching manager.

- `builtin`: local built-in memory path
- `qmd`: Qdrant + model-assisted path
- `openviking`: OpenViking remote/local service path

### 3.2 OpenViking defaults (current)

When OpenViking is enabled and no custom override is provided:

- Endpoint: `http://127.0.0.1:9432`
- Search strategy: `auto`
- Read layer: `progressive`
- Search budget:
  - `maxEntries=6`
  - `maxSnippetChars=560`
  - `maxInjectedChars=3200`
- Relation expansion: `false` (opt-in)
- Outbox flush interval: `2000ms`
- Commit triggers:
  - every `24` messages
  - every `12` minutes
- FS write policy: disabled by default

Anchor: `openclaw-2026.2.19/src/memory/backend-config.ts`

## 4. Session Identity Model

OpenClaw session records include OpenViking linkage metadata:

- `openvikingSessionId`
- `lastCommitAt`
- `lastSyncedSeq`

Anchor: `openclaw-2026.2.19/src/config/sessions/types.ts`

Behavior:

1. On first write, OpenClaw ensures an OpenViking session mapping exists.
2. Mapping metadata is stored in OpenClaw session persistence.
3. Later writes/commits reuse this mapped OpenViking session id.

Anchor: `openclaw-2026.2.19/src/memory/openviking/bridge.ts`

## 5. Read Path Design

Read path is implemented in `OpenVikingMemoryManager`.

### 5.1 Retrieval planning

The manager combines:

- semantic search result signals,
- planner hints (`query_plan`, `query_results`),
- query lexical signals,
- session presence,

to decide retrieval priority across `memory`, `resource`, and `skill`.

Anchor: `openclaw-2026.2.19/src/memory/openviking/manager.ts`

### 5.2 Layered reading and budgeting

The manager supports `l0`, `l1`, `l2`, and `progressive` read layers, then trims output by budget before injection.

### 5.3 Relation expansion (optional)

If enabled, relation graph expansion can add adjacent context candidates with priority-aware budget boosting.

### 5.4 Fallback coverage

The manager can use `search/find` as a fallback when primary search planning yields empty candidates.

## 6. Write Path Design

Write path is centered on the OpenViking bridge and outbox queue.

Main lifecycle:

1. Convert OpenClaw events/messages/tool outputs into OpenViking events.
2. Enqueue to local outbox.
3. Background flusher posts batches to OpenViking endpoint:
   - `/api/v1/sessions/{sessionId}/events/batch`
4. Commit events are triggered by lifecycle and periodic policy.

Key functions:

- `ensureOpenVikingSessionLink(...)`
- `enqueueOpenVikingMessage(...)`
- `enqueueOpenVikingCommit(...)`
- `getOpenVikingOutboxStats(...)`

Anchor files:

- `openclaw-2026.2.19/src/memory/openviking/bridge.ts`
- `openclaw-2026.2.19/src/memory/openviking/client.ts`

Consistency model:

- Commit can be `sync` or `async`.
- Default is asynchronous, so durability is eventual rather than strictly immediate.

## 7. Operator Surface (CLI)

OpenClaw CLI exposes major OpenViking operations:

1. Search diagnostics
   - `memory search-trace`
   - `memory find`
   - `memory grep`
   - `memory glob`
2. Session lifecycle
   - `memory sessions-list/get/delete/extract/message`
3. Pack portability
   - `memory pack-export`
   - `memory pack-import`
4. Filesystem
   - `memory fs-ls/tree/stat/mkdir/rm/mv`
5. Relations
   - `memory relations/relation-link/relation-unlink`

Anchor: `openclaw-2026.2.19/src/cli/memory-cli.ts`

## 8. Safety and Guardrails

Writable filesystem operations are policy-gated.

Guard conditions:

1. `fsWrite.enabled` must be true.
2. `allowUriPrefixes` must be configured.
3. `denyUriPrefixes` is enforced.
4. `protectedUris` is enforced.
5. Recursive remove requires:
   - policy allow (`allowRecursiveRm=true`), and
   - explicit CLI confirmation (`--yes`).

Anchors:

- `openclaw-2026.2.19/src/memory/openviking/fs-relations.ts`
- `openclaw-2026.2.19/src/config/types.memory.ts`

## 9. Observability

Two operational observability surfaces are implemented:

1. `openclaw status`
   - strategy/read-layer summaries
   - budget drop counters
   - commit trigger profile
   - lag/periodic signal output
2. `openclaw memory search-trace`
   - latest retrieval strategy and selection snapshot

Anchors:

- `openclaw-2026.2.19/src/commands/status.command.ts`
- `openclaw-2026.2.19/src/cli/memory-cli.ts`

## 10. Current Architectural Boundaries

The current implementation intentionally keeps these boundaries:

1. No graphical retrieval trajectory UI (CLI/JSON diagnostics only).
2. Write durability is eventually consistent under default async commit mode.
3. Relation expansion is conservative by default (disabled unless configured).
4. OpenViking integration is a backend path, not a replacement of OpenClaw agent orchestration.

This provides a pragmatic balance for single-user long-horizon assistant deployments: better memory power and visibility, while preserving controllable risk boundaries.
