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
    addResource: vi.fn(),
    addSkill: vi.fn(),
    waitProcessed: vi.fn(),
  };
});

vi.mock("../backend-config.js", () => ({
  resolveMemoryBackendConfig: vi.fn(() => hoisted.resolved),
}));

vi.mock("./client.js", () => ({
  OpenVikingClient: class {
    endpoint =
      hoisted.resolved.backend === "openviking" && hoisted.resolved.openviking
        ? hoisted.resolved.openviking.endpoint
        : "http://127.0.0.1:9432";

    async addResource(payload: unknown): Promise<unknown> {
      return await hoisted.addResource(payload);
    }

    async addSkill(payload: unknown): Promise<unknown> {
      return await hoisted.addSkill(payload);
    }

    async waitProcessed(payload: unknown): Promise<unknown> {
      return await hoisted.waitProcessed(payload);
    }
  },
}));

describe("openviking ingest", () => {
  beforeEach(() => {
    hoisted.resolved = {
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
    hoisted.addResource.mockReset();
    hoisted.addSkill.mockReset();
    hoisted.waitProcessed.mockReset();
  });

  it("retries transient add_resource failures and waits for processing", async () => {
    hoisted.addResource
      .mockRejectedValueOnce(new Error("openviking request failed (503): temporary busy"))
      .mockResolvedValueOnce({ uri: "viking://resources/demo/readme.md", accepted: true });
    hoisted.waitProcessed.mockResolvedValueOnce({
      resource: { processed: 1, error_count: 0, errors: [] },
    });
    const { ingestOpenVikingResource } = await import("./ingest.js");

    const receipt = await ingestOpenVikingResource({
      cfg: { memory: { backend: "openviking" } } as never,
      agentId: "main",
      path: "/tmp/demo.md",
      reason: "cli test",
      wait: true,
      timeoutSec: 10,
      retries: 2,
      retryBaseMs: 1,
    });

    expect(hoisted.addResource).toHaveBeenCalledTimes(2);
    expect(hoisted.waitProcessed).toHaveBeenCalledTimes(1);
    expect(receipt.attempts).toBe(2);
    expect(receipt.waited).toBe(true);
    expect(receipt.payload.uri).toBe("viking://resources/demo/readme.md");
    expect(receipt.waitStatus).toMatchObject({
      resource: { processed: 1 },
    });
  });

  it("does not retry non-retriable add_skill errors", async () => {
    hoisted.addSkill.mockRejectedValueOnce(
      new Error("openviking request failed (400): invalid skill payload"),
    );
    const { ingestOpenVikingSkill } = await import("./ingest.js");

    await expect(
      ingestOpenVikingSkill({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        data: { name: "invalid" },
        wait: false,
        retries: 3,
      }),
    ).rejects.toThrow("openviking request failed (400)");
    expect(hoisted.addSkill).toHaveBeenCalledTimes(1);
  });

  it("skips wait endpoint when queue_status is returned inline", async () => {
    hoisted.addSkill.mockResolvedValueOnce({
      uri: "viking://skills/demo",
      queue_status: {
        skill: { processed: 1, error_count: 0, errors: [] },
      },
    });
    const { ingestOpenVikingSkill } = await import("./ingest.js");

    const receipt = await ingestOpenVikingSkill({
      cfg: { memory: { backend: "openviking" } } as never,
      agentId: "main",
      data: { name: "demo" },
      wait: true,
    });

    expect(hoisted.addSkill).toHaveBeenCalledTimes(1);
    expect(hoisted.waitProcessed).toHaveBeenCalledTimes(0);
    expect(receipt.waitStatus).toMatchObject({
      skill: { processed: 1 },
    });
  });

  it("fails fast when memory backend is not openviking", async () => {
    hoisted.resolved = {
      backend: "builtin",
      citations: "auto",
    };
    const { ingestOpenVikingResource } = await import("./ingest.js");

    await expect(
      ingestOpenVikingResource({
        cfg: {} as never,
        agentId: "main",
        path: "/tmp/demo.md",
      }),
    ).rejects.toThrow("openviking backend required");
  });
});
