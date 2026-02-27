import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const sessionKey = "agent:main:main";
  const storePath = "/tmp/openclaw-bridge-test-sessions.json";
  const cfg = {
    memory: {
      backend: "openviking",
    },
  };
  const resolved = {
    endpoint: "http://127.0.0.1:1933",
    headers: {},
    timeoutMs: 1_000,
    targetUri: "viking://",
    dualWrite: true,
    commit: {
      mode: "async",
      triggers: {
        sessionEnd: true,
        reset: true,
        everyNMessages: 40,
        everyNMinutes: 1,
      },
    },
    outbox: {
      enabled: true,
      path: "/tmp/openclaw-bridge-test-outbox.jsonl",
      flushIntervalMs: 1_000,
      maxBatchSize: 10,
      retryBaseMs: 250,
      retryMaxMs: 10_000,
    },
    search: {
      limit: 10,
      targetUri: "viking://",
      includeResources: true,
      includeSkills: true,
      explainability: false,
      strategy: "auto",
      readLayer: "progressive",
      maxEntries: 6,
      maxSnippetChars: 700,
      maxInjectedChars: 4_000,
      relationExpansion: false,
      relationMaxDepth: 1,
      relationMaxAnchors: 2,
      relationMaxExpandedEntries: 4,
      relationSeedAnchorScore: 0.55,
      relationPriorityBudgetBoost: true,
      relationPriorityDepthBonus: 1,
      relationPriorityAnchorsBonus: 1,
      relationPriorityExpandedBonus: 2,
    },
  };
  const store: Record<string, Record<string, unknown>> = {};

  return {
    sessionKey,
    storePath,
    cfg,
    resolved,
    store,
    addEventsBatch: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ session_id: "created-ov-session" })),
    commitSession: vi.fn(async () => {}),
    health: vi.fn(async () => true),
    outboxStart: vi.fn(async () => {}),
    outboxEnqueue: vi.fn(async () => 0),
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => hoisted.cfg),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => hoisted.storePath),
  loadSessionStore: vi.fn(() => hoisted.store),
  updateSessionStore: vi.fn(
    async (
      _storePath: string,
      mutator: (store: Record<string, Record<string, unknown>>) => unknown,
    ) => mutator(hoisted.store),
  ),
}));

vi.mock("../backend-config.js", () => ({
  resolveMemoryBackendConfig: vi.fn(() => ({
    backend: "openviking",
    openviking: hoisted.resolved,
  })),
}));

vi.mock("./client.js", () => ({
  OpenVikingClient: class {
    endpoint = hoisted.resolved.endpoint;

    async addEventsBatch(payload: unknown): Promise<void> {
      await hoisted.addEventsBatch(payload);
    }

    async createSession(): Promise<{ session_id: string }> {
      return await hoisted.createSession();
    }

    async commitSession(payload: unknown): Promise<void> {
      await hoisted.commitSession(payload);
    }

    async health(): Promise<boolean> {
      return await hoisted.health();
    }
  },
}));

vi.mock("./outbox.js", () => ({
  OpenVikingOutbox: class {
    async start(): Promise<void> {
      await hoisted.outboxStart();
    }

    stop(): void {}

    async enqueue(payload: unknown): Promise<number> {
      return await hoisted.outboxEnqueue(payload);
    }

    getStats(): { depth: number } {
      return { depth: 0 };
    }
  },
}));

describe("openviking bridge commit triggers", () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.addEventsBatch.mockReset();
    hoisted.createSession.mockReset();
    hoisted.createSession.mockResolvedValue({ session_id: "created-ov-session" });
    hoisted.commitSession.mockReset();
    hoisted.health.mockReset();
    hoisted.health.mockResolvedValue(true);
    hoisted.outboxStart.mockReset();
    hoisted.outboxEnqueue.mockReset();
    hoisted.outboxEnqueue.mockResolvedValue(0);
    hoisted.store[hoisted.sessionKey] = {
      sessionId: "local-session",
      openvikingSessionId: "linked-ov-session",
      updatedAt: Date.now(),
      lastSyncedSeq: 0,
      lastCommitAt: Date.now() - 2 * 60_000,
    };
  });

  it("queues one periodic commit after stale message activity without recursion", async () => {
    const { enqueueOpenVikingMessage, getOpenVikingBridgeStats } = await import("./bridge.js");
    const previousCommitAt = Number(hoisted.store[hoisted.sessionKey]?.lastCommitAt ?? 0);

    await expect(
      enqueueOpenVikingMessage({
        sessionKey: hoisted.sessionKey,
        role: "user",
        content: "hello",
      }),
    ).resolves.toBe(true);

    expect(hoisted.outboxEnqueue).toHaveBeenCalledTimes(2);
    const messagePayload = hoisted.outboxEnqueue.mock.calls[0]?.[0] as {
      events: Array<{ event_type: string }>;
    };
    const commitPayload = hoisted.outboxEnqueue.mock.calls[1]?.[0] as {
      events: Array<{ event_type: string; metadata?: { source?: string } }>;
    };
    expect(messagePayload.events[0]?.event_type).toBe("message");
    expect(commitPayload.events[0]?.event_type).toBe("commit");
    expect(commitPayload.events[0]?.metadata?.source).toBe("time-threshold");
    expect(Number(hoisted.store[hoisted.sessionKey]?.lastCommitAt ?? 0)).toBeGreaterThan(
      previousCommitAt,
    );
    const stats = getOpenVikingBridgeStats({ sessionKey: hoisted.sessionKey });
    expect(stats?.eventsQueued).toBe(2);
    expect(stats?.messageEventsQueued).toBe(1);
    expect(stats?.commitEventsQueued).toBe(1);
    expect(stats?.asyncCommits).toBe(1);
    expect(stats?.periodicCommitsByTime).toBe(1);
    expect(stats?.lastCommitCause).toBe("periodic");
    expect(stats?.lastCommitSource).toBe("time-threshold");
    expect(stats?.lastCommitMode).toBe("async");
    expect(typeof stats?.lastCommitLagMs).toBe("number");
  });

  it("does not recursively enqueue commit events when commit is already being queued", async () => {
    const { enqueueOpenVikingCommit, getOpenVikingBridgeStats } = await import("./bridge.js");
    const previousCommitAt = Number(hoisted.store[hoisted.sessionKey]?.lastCommitAt ?? 0);

    await expect(
      enqueueOpenVikingCommit({
        sessionKey: hoisted.sessionKey,
        cause: "periodic",
        source: "time-threshold",
      }),
    ).resolves.toBe(true);

    expect(hoisted.outboxEnqueue).toHaveBeenCalledTimes(1);
    const commitPayload = hoisted.outboxEnqueue.mock.calls[0]?.[0] as {
      events: Array<{ event_type: string }>;
    };
    expect(commitPayload.events[0]?.event_type).toBe("commit");
    expect(Number(hoisted.store[hoisted.sessionKey]?.lastCommitAt ?? 0)).toBeGreaterThan(
      previousCommitAt,
    );
    const stats = getOpenVikingBridgeStats({ sessionKey: hoisted.sessionKey });
    expect(stats?.eventsQueued).toBe(1);
    expect(stats?.commitEventsQueued).toBe(1);
    expect(stats?.asyncCommits).toBe(1);
    expect(stats?.periodicCommitsByTime).toBe(1);
    expect(stats?.lastCommitCause).toBe("periodic");
    expect(stats?.lastCommitSource).toBe("time-threshold");
    expect(stats?.lastCommitMode).toBe("async");
  });
});
