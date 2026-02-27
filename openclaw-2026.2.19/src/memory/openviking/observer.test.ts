import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMemoryBackendConfig } from "../backend-config.js";

const hoisted = vi.hoisted(() => {
  const resolvedOpenViking: ResolvedMemoryBackendConfig = {
    backend: "openviking",
    citations: "auto",
    openviking: {
      endpoint: "http://127.0.0.1:9432",
      headers: {},
      timeoutMs: 2_000,
      targetUri: "",
      dualWrite: true,
      commit: {
        mode: "async",
        triggers: {
          sessionEnd: true,
          reset: true,
          everyNMessages: 40,
          everyNMinutes: 20,
        },
      },
      outbox: {
        enabled: true,
        flushIntervalMs: 3_000,
        maxBatchSize: 25,
        retryBaseMs: 1_000,
        retryMaxMs: 60_000,
      },
      search: {
        limit: 10,
        targetUri: "",
        includeResources: false,
        includeSkills: false,
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
    },
  };
  return {
    resolved: resolvedOpenViking,
    observerSystem: vi.fn(),
    observerQueue: vi.fn(),
    observerVikingdb: vi.fn(),
    observerVlm: vi.fn(),
    observerTransaction: vi.fn(),
  };
});

vi.mock("../backend-config.js", () => ({
  resolveMemoryBackendConfig: vi.fn(() => hoisted.resolved),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    OpenVikingClient: class {
      endpoint = "http://127.0.0.1:9432";

      async observerSystem(): Promise<unknown> {
        return await hoisted.observerSystem();
      }

      async observerQueue(): Promise<unknown> {
        return await hoisted.observerQueue();
      }

      async observerVikingdb(): Promise<unknown> {
        return await hoisted.observerVikingdb();
      }

      async observerVlm(): Promise<unknown> {
        return await hoisted.observerVlm();
      }

      async observerTransaction(): Promise<unknown> {
        return await hoisted.observerTransaction();
      }
    },
  };
});

describe("openviking observer snapshot", () => {
  beforeEach(() => {
    hoisted.observerSystem.mockReset();
    hoisted.observerQueue.mockReset();
    hoisted.observerVikingdb.mockReset();
    hoisted.observerVlm.mockReset();
    hoisted.observerTransaction.mockReset();
  });

  it("collects healthy observer statuses", async () => {
    hoisted.observerSystem.mockResolvedValue({
      is_healthy: true,
      errors: [],
      components: {},
    });
    hoisted.observerQueue.mockResolvedValue({
      name: "queue",
      is_healthy: true,
      has_errors: false,
    });
    hoisted.observerVikingdb.mockResolvedValue({
      name: "vikingdb",
      is_healthy: true,
      has_errors: false,
    });
    hoisted.observerVlm.mockResolvedValue({
      name: "vlm",
      is_healthy: true,
      has_errors: false,
    });
    hoisted.observerTransaction.mockResolvedValue({
      name: "transaction",
      is_healthy: true,
      has_errors: false,
    });

    const { fetchOpenVikingObserverSnapshot } = await import("./observer.js");
    const snapshot = await fetchOpenVikingObserverSnapshot({
      cfg: { memory: { backend: "openviking" } } as never,
      agentId: "main",
      outboxDepth: 0,
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.componentsHealthy).toBe(4);
    expect(snapshot.componentsTotal).toBe(4);
    expect(snapshot.degradedComponents).toEqual([]);
    expect(snapshot.alerts).toEqual([]);
  });

  it("emits risk alerts when queue is degraded with outbox backlog", async () => {
    hoisted.observerSystem.mockResolvedValue({
      is_healthy: false,
      errors: ["queue degraded"],
      components: {},
    });
    hoisted.observerQueue.mockResolvedValue({
      name: "queue",
      is_healthy: false,
      has_errors: true,
    });
    hoisted.observerVikingdb.mockResolvedValue({
      name: "vikingdb",
      is_healthy: true,
      has_errors: false,
    });
    hoisted.observerVlm.mockResolvedValue({
      name: "vlm",
      is_healthy: true,
      has_errors: false,
    });
    hoisted.observerTransaction.mockResolvedValue({
      name: "transaction",
      is_healthy: true,
      has_errors: false,
    });

    const { fetchOpenVikingObserverSnapshot } = await import("./observer.js");
    const snapshot = await fetchOpenVikingObserverSnapshot({
      cfg: { memory: { backend: "openviking" } } as never,
      agentId: "main",
      outboxDepth: 123,
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.componentsHealthy).toBe(3);
    expect(snapshot.degradedComponents).toContain("queue");
    expect(snapshot.alerts.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "observer_system_unhealthy",
        "observer_component_degraded",
        "openviking_outbox_high_depth",
        "openviking_outbox_queue_risk",
      ]),
    );
  });

  it("keeps available=false when all observer calls fail", async () => {
    hoisted.observerSystem.mockRejectedValue(new Error("system timeout"));
    hoisted.observerQueue.mockRejectedValue(new Error("queue timeout"));
    hoisted.observerVikingdb.mockRejectedValue(new Error("vikingdb timeout"));
    hoisted.observerVlm.mockRejectedValue(new Error("vlm timeout"));
    hoisted.observerTransaction.mockRejectedValue(new Error("transaction timeout"));

    const { fetchOpenVikingObserverSnapshot } = await import("./observer.js");
    const snapshot = await fetchOpenVikingObserverSnapshot({
      cfg: { memory: { backend: "openviking" } } as never,
      agentId: "main",
    });

    expect(snapshot.available).toBe(false);
    expect(snapshot.error).toContain("timeout");
    expect(snapshot.componentsHealthy).toBe(0);
  });
});
