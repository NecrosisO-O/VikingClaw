import crypto from "node:crypto";
import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedOpenVikingConfig,
} from "../backend-config.js";
import { OpenVikingClient, type OpenVikingSessionEvent } from "./client.js";
import { OpenVikingOutbox, type OpenVikingOutboxStats } from "./outbox.js";

const log = createSubsystemLogger("memory/openviking/bridge");

type BridgeContext = {
  cfg: OpenClawConfig;
  agentId: string;
  resolved: ResolvedOpenVikingConfig;
  storePath: string;
  sessionKey?: string;
};

export type OpenVikingBridgeStats = {
  eventsQueued: number;
  messageEventsQueued: number;
  toolEventsQueued: number;
  commitEventsQueued: number;
  syncCommits: number;
  asyncCommits: number;
  periodicCommitsByMessage: number;
  periodicCommitsByTime: number;
  sessionEndCommits: number;
  resetCommits: number;
  manualCommits: number;
  lastEventQueuedAt?: number;
  lastCommitQueuedAt?: number;
  lastCommitCause?: string;
  lastCommitSource?: string;
  lastCommitMode?: "sync" | "async";
  lastCommitLagMs?: number;
  lastPeriodicTriggerAt?: number;
  lastPeriodicTrigger?: "message-threshold" | "time-threshold";
};

type BridgeRuntimeStats = OpenVikingBridgeStats;

type BridgeInstance = {
  key: string;
  client: OpenVikingClient;
  outbox: OpenVikingOutbox;
  resolved: ResolvedOpenVikingConfig;
  storePath: string;
  stats: BridgeRuntimeStats;
};

const BRIDGES = new Map<string, Promise<BridgeInstance>>();
const BRIDGE_CACHE = new Map<string, BridgeInstance>();

function createInitialBridgeStats(): BridgeRuntimeStats {
  return {
    eventsQueued: 0,
    messageEventsQueued: 0,
    toolEventsQueued: 0,
    commitEventsQueued: 0,
    syncCommits: 0,
    asyncCommits: 0,
    periodicCommitsByMessage: 0,
    periodicCommitsByTime: 0,
    sessionEndCommits: 0,
    resetCommits: 0,
    manualCommits: 0,
  };
}

function snapshotBridgeStats(stats: BridgeRuntimeStats): OpenVikingBridgeStats {
  return {
    ...stats,
  };
}

function recordQueuedEvents(stats: BridgeRuntimeStats, events: OpenVikingSessionEvent[]): void {
  if (!events.length) {
    return;
  }
  const now = Date.now();
  for (const event of events) {
    stats.eventsQueued += 1;
    if (event.event_type === "message") {
      stats.messageEventsQueued += 1;
    } else if (event.event_type === "tool_result") {
      stats.toolEventsQueued += 1;
    } else if (event.event_type === "commit") {
      stats.commitEventsQueued += 1;
    }
  }
  stats.lastEventQueuedAt = now;
}

function recordCommit(
  stats: BridgeRuntimeStats,
  params: {
    mode: "sync" | "async";
    cause: string;
    source?: string;
  },
): void {
  const now = Date.now();
  stats.lastCommitQueuedAt = now;
  stats.lastCommitCause = params.cause;
  stats.lastCommitSource = params.source?.trim() || undefined;
  stats.lastCommitMode = params.mode;
  if (typeof stats.lastEventQueuedAt === "number") {
    stats.lastCommitLagMs = Math.max(0, now - stats.lastEventQueuedAt);
  }
  if (params.mode === "sync") {
    stats.syncCommits += 1;
  } else {
    stats.asyncCommits += 1;
  }
  if (params.cause === "session_end") {
    stats.sessionEndCommits += 1;
    return;
  }
  if (params.cause === "reset") {
    stats.resetCommits += 1;
    return;
  }
  if (params.cause === "periodic") {
    if (params.source === "message-threshold") {
      stats.periodicCommitsByMessage += 1;
      stats.lastPeriodicTrigger = "message-threshold";
      stats.lastPeriodicTriggerAt = now;
      return;
    }
    if (params.source === "time-threshold") {
      stats.periodicCommitsByTime += 1;
      stats.lastPeriodicTrigger = "time-threshold";
      stats.lastPeriodicTriggerAt = now;
      return;
    }
  }
  stats.manualCommits += 1;
}

function resolveContext(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): BridgeContext | null {
  let cfg: OpenClawConfig;
  try {
    cfg = params.cfg ?? loadConfig();
  } catch {
    return null;
  }
  const sessionKey = params.sessionKey?.trim();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey,
      config: cfg,
    });
  const resolvedBackend = resolveMemoryBackendConfig({ cfg, agentId });
  if (resolvedBackend.backend !== "openviking" || !resolvedBackend.openviking) {
    return null;
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return {
    cfg,
    agentId,
    resolved: resolvedBackend.openviking,
    storePath,
    sessionKey,
  };
}

function resolveOutboxPath(params: {
  resolved: ResolvedOpenVikingConfig;
  storePath: string;
  agentId: string;
}): string {
  const configured = params.resolved.outbox.path?.trim();
  if (configured) {
    if (configured.endsWith(".jsonl")) {
      return configured;
    }
    return path.join(configured, `${params.agentId}.jsonl`);
  }
  return path.join(path.dirname(params.storePath), "openviking-outbox", `${params.agentId}.jsonl`);
}

async function getBridge(context: BridgeContext): Promise<BridgeInstance> {
  const key = `${context.agentId}:${context.resolved.endpoint}`;
  const existing = BRIDGES.get(key);
  if (existing) {
    return await existing;
  }
  const created = (async (): Promise<BridgeInstance> => {
    const client = new OpenVikingClient(context.resolved);
    const outbox = new OpenVikingOutbox({
      filePath: resolveOutboxPath({
        resolved: context.resolved,
        storePath: context.storePath,
        agentId: context.agentId,
      }),
      flushIntervalMs: context.resolved.outbox.flushIntervalMs,
      maxBatchSize: context.resolved.outbox.maxBatchSize,
      retryBaseMs: context.resolved.outbox.retryBaseMs,
      retryMaxMs: context.resolved.outbox.retryMaxMs,
      sender: async (payload) => {
        await client.addEventsBatch({
          sessionId: payload.sessionId,
          events: payload.events,
        });
      },
    });
    if (context.resolved.outbox.enabled) {
      await outbox.start();
    }
    const bridge: BridgeInstance = {
      key,
      client,
      outbox,
      resolved: context.resolved,
      storePath: context.storePath,
      stats: createInitialBridgeStats(),
    };
    BRIDGE_CACHE.set(key, bridge);
    return bridge;
  })();
  BRIDGES.set(key, created);
  try {
    return await created;
  } catch (err) {
    BRIDGES.delete(key);
    BRIDGE_CACHE.delete(key);
    throw err;
  }
}

function normalizeRole(role: string | undefined): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

function normalizeEventContent(content: string | undefined): string {
  const trimmed = (content ?? "").trim();
  if (!trimmed) {
    return "";
  }
  // Cap event payload size to avoid runaway outbox growth.
  return trimmed.length > 16_000 ? `${trimmed.slice(0, 16_000)}\n\n[truncated]` : trimmed;
}

function readSessionEntry(params: {
  storePath: string;
  sessionKey?: string;
}): {
  openvikingSessionId?: string;
  lastSyncedSeq?: number;
  lastCommitAt?: number;
} | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  try {
    const store = loadSessionStore(params.storePath);
    return store[sessionKey] ?? null;
  } catch {
    return null;
  }
}

async function bumpSessionSeq(params: {
  storePath: string;
  sessionKey: string;
  delta: number;
}): Promise<number | undefined> {
  return await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry) {
        return undefined;
      }
      const next = (entry.lastSyncedSeq ?? 0) + Math.max(1, params.delta);
      store[params.sessionKey] = {
        ...entry,
        lastSyncedSeq: next,
      };
      return next;
    },
    { activeSessionKey: params.sessionKey },
  );
}

async function markCommitQueued(params: { storePath: string; sessionKey: string }): Promise<void> {
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry) {
        return;
      }
      store[params.sessionKey] = {
        ...entry,
        lastCommitAt: Date.now(),
      };
    },
    { activeSessionKey: params.sessionKey },
  );
}

export function resolveLinkedOpenVikingSessionId(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const context = resolveContext(params);
  if (!context?.sessionKey) {
    return undefined;
  }
  const entry = readSessionEntry({
    storePath: context.storePath,
    sessionKey: context.sessionKey,
  });
  return entry?.openvikingSessionId;
}

export async function ensureOpenVikingSessionLink(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): Promise<string | undefined> {
  const context = resolveContext(params);
  if (!context?.sessionKey) {
    return undefined;
  }
  const existing = resolveLinkedOpenVikingSessionId(context);
  if (existing) {
    return existing;
  }
  try {
    const bridge = await getBridge(context);
    const created = await bridge.client.createSession();
    const openvikingSessionId = created.session_id?.trim();
    if (!openvikingSessionId) {
      return undefined;
    }
    await updateSessionStore(
      context.storePath,
      (store) => {
        const entry = store[context.sessionKey!];
        if (!entry) {
          return;
        }
        store[context.sessionKey!] = {
          ...entry,
          openvikingSessionId,
        };
      },
      { activeSessionKey: context.sessionKey },
    );
    return openvikingSessionId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to link session: sessionKey=${context.sessionKey} error=${message}`);
    return undefined;
  }
}

async function enqueueEvents(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  events: OpenVikingSessionEvent[];
  bumpSeq?: boolean;
  skipCommitTriggers?: boolean;
}): Promise<boolean> {
  const context = resolveContext(params);
  if (!context?.sessionKey) {
    return false;
  }
  if (!context.resolved.dualWrite) {
    return false;
  }
  const sessionId = await ensureOpenVikingSessionLink(context);
  if (!sessionId) {
    return false;
  }
  const bridge = await getBridge(context);
  if (!bridge.resolved.outbox.enabled) {
    await bridge.client.addEventsBatch({ sessionId, events: params.events });
  } else {
    await bridge.outbox.enqueue({
      sessionKey: context.sessionKey,
      sessionId,
      events: params.events,
    });
  }
  recordQueuedEvents(bridge.stats, params.events);

  let nextSeq: number | undefined;
  if (params.bumpSeq !== false) {
    nextSeq = await bumpSessionSeq({
      storePath: context.storePath,
      sessionKey: context.sessionKey,
      delta: params.events.length,
    });
  }

  if (params.skipCommitTriggers) {
    return true;
  }
  if (params.events.some((event) => event.event_type === "commit")) {
    return true;
  }

  const triggers = context.resolved.commit.triggers;
  if (triggers.everyNMessages > 0 && nextSeq && nextSeq % triggers.everyNMessages === 0) {
    await enqueueOpenVikingCommit({
      cfg: context.cfg,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      cause: "periodic",
      source: "message-threshold",
    });
  } else if (triggers.everyNMinutes > 0) {
    const entry = readSessionEntry({
      storePath: context.storePath,
      sessionKey: context.sessionKey,
    });
    const elapsed = Date.now() - (entry?.lastCommitAt ?? 0);
    if (entry?.lastCommitAt && elapsed >= triggers.everyNMinutes * 60_000) {
      await enqueueOpenVikingCommit({
        cfg: context.cfg,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        cause: "periodic",
        source: "time-threshold",
      });
    }
  }
  return true;
}

export async function enqueueOpenVikingMessage(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  role: "user" | "assistant" | string;
  content: string;
  eventType?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const content = normalizeEventContent(params.content);
  if (!content) {
    return false;
  }
  return await enqueueEvents({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    events: [
      {
        event_id: crypto.randomUUID(),
        event_type: params.eventType ?? "message",
        role: normalizeRole(params.role),
        content,
        metadata: params.metadata,
      },
    ],
  });
}

export async function enqueueOpenVikingToolEvent(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
}): Promise<boolean> {
  const content = JSON.stringify(
    {
      tool: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError === true,
      result: params.result,
    },
    null,
    2,
  );
  return await enqueueOpenVikingMessage({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    role: "assistant",
    content,
    eventType: "tool_result",
    metadata: {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError === true,
    },
  });
}

export async function enqueueOpenVikingCommit(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  cause?: "manual" | "session_end" | "reset" | "periodic" | string;
  source?: string;
}): Promise<boolean> {
  const context = resolveContext(params);
  if (!context?.sessionKey) {
    return false;
  }
  const triggers = context.resolved.commit.triggers;
  if (params.cause === "session_end" && !triggers.sessionEnd) {
    return false;
  }
  if (params.cause === "reset" && !triggers.reset) {
    return false;
  }
  if (context.resolved.commit.mode === "sync") {
    const sessionId = await ensureOpenVikingSessionLink(context);
    if (!sessionId) {
      return false;
    }
    const bridge = await getBridge(context);
    await bridge.client.commitSession({
      sessionId,
      cause: params.cause ?? "manual",
    });
    bridge.stats.commitEventsQueued += 1;
    recordCommit(bridge.stats, {
      mode: "sync",
      cause: params.cause ?? "manual",
      source: params.source,
    });
    await markCommitQueued({
      storePath: context.storePath,
      sessionKey: context.sessionKey,
    });
    return true;
  }
  const committed = await enqueueEvents({
    cfg: context.cfg,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    bumpSeq: false,
    skipCommitTriggers: true,
    events: [
      {
        event_id: crypto.randomUUID(),
        event_type: "commit",
        cause: params.cause ?? "manual",
        metadata: params.source ? { source: params.source } : undefined,
      },
    ],
  });
  if (committed) {
    const bridge = await getBridge(context);
    recordCommit(bridge.stats, {
      mode: "async",
      cause: params.cause ?? "manual",
      source: params.source,
    });
    await markCommitQueued({
      storePath: context.storePath,
      sessionKey: context.sessionKey,
    });
  }
  return committed;
}

export function getOpenVikingBridgeStats(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): OpenVikingBridgeStats | null {
  const context = resolveContext(params);
  if (!context) {
    return null;
  }
  const key = `${context.agentId}:${context.resolved.endpoint}`;
  const bridge = BRIDGE_CACHE.get(key);
  if (!bridge) {
    return createInitialBridgeStats();
  }
  return snapshotBridgeStats(bridge.stats);
}

export async function primeOpenVikingBridge(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const context = resolveContext(params);
  if (!context) {
    return { ok: false, error: "openviking backend not enabled" };
  }
  try {
    const bridge = await getBridge(context);
    const healthy = await bridge.client.health();
    if (!healthy) {
      return { ok: false, error: `OpenViking endpoint unavailable: ${bridge.client.endpoint}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function getOpenVikingOutboxStats(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): OpenVikingOutboxStats | null {
  const context = resolveContext(params);
  if (!context) {
    return null;
  }
  const key = `${context.agentId}:${context.resolved.endpoint}`;
  const bridge = BRIDGE_CACHE.get(key);
  if (!bridge) {
    return { depth: 0 };
  }
  return bridge.outbox.getStats();
}
