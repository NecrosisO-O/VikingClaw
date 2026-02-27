import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMemoryBackendConfig } from "../backend-config.js";

const hoisted = vi.hoisted(() => {
  const resolved: ResolvedMemoryBackendConfig = {
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
      fsWrite: {
        enabled: true,
        allowUriPrefixes: ["viking://resources/docs"],
        denyUriPrefixes: ["viking://resources/docs/sealed"],
        protectedUris: ["viking://resources/docs/protected"],
        allowRecursiveRm: false,
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
    resolved,
    fsMkdir: vi.fn(),
    fsRm: vi.fn(),
    fsMv: vi.fn(),
  };
});

vi.mock("../backend-config.js", () => ({
  resolveMemoryBackendConfig: vi.fn(() => hoisted.resolved),
}));

vi.mock("./client.js", () => ({
  OpenVikingClient: class {
    async fsMkdir(uri: string): Promise<unknown> {
      return await hoisted.fsMkdir(uri);
    }
    async fsRm(params: { uri: string; recursive?: boolean }): Promise<unknown> {
      return await hoisted.fsRm(params);
    }
    async fsMv(params: { fromUri: string; toUri: string }): Promise<unknown> {
      return await hoisted.fsMv(params);
    }
  },
}));

describe("openviking fs write policy", () => {
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
        fsWrite: {
          enabled: true,
          allowUriPrefixes: ["viking://resources/docs"],
          denyUriPrefixes: ["viking://resources/docs/sealed"],
          protectedUris: ["viking://resources/docs/protected"],
          allowRecursiveRm: false,
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
    hoisted.fsMkdir.mockReset();
    hoisted.fsRm.mockReset();
    hoisted.fsMv.mockReset();
  });

  it("blocks mkdir when fs write is disabled", async () => {
    if (hoisted.resolved.backend === "openviking" && hoisted.resolved.openviking?.fsWrite) {
      hoisted.resolved.openviking.fsWrite.enabled = false;
    }
    const { mkdirOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      mkdirOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        uri: "viking://resources/docs/new-dir",
      }),
    ).rejects.toThrow("fs write is disabled");
    expect(hoisted.fsMkdir).not.toHaveBeenCalled();
  });

  it("requires allowUriPrefixes for mkdir", async () => {
    if (hoisted.resolved.backend === "openviking" && hoisted.resolved.openviking?.fsWrite) {
      hoisted.resolved.openviking.fsWrite.allowUriPrefixes = [];
    }
    const { mkdirOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      mkdirOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        uri: "viking://resources/docs/new-dir",
      }),
    ).rejects.toThrow("allowUriPrefixes");
    expect(hoisted.fsMkdir).not.toHaveBeenCalled();
  });

  it("allows mkdir in allowlisted prefix", async () => {
    hoisted.fsMkdir.mockResolvedValueOnce({ uri: "viking://resources/docs/new-dir" });
    const { mkdirOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      mkdirOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        uri: "viking://resources/docs/new-dir",
      }),
    ).resolves.toMatchObject({ uri: "viking://resources/docs/new-dir" });
    expect(hoisted.fsMkdir).toHaveBeenCalledWith("viking://resources/docs/new-dir");
  });

  it("blocks recursive rm unless policy allows it", async () => {
    const { rmOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      rmOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        uri: "viking://resources/docs/archive",
        recursive: true,
      }),
    ).rejects.toThrow("allowRecursiveRm=true");
    expect(hoisted.fsRm).not.toHaveBeenCalled();
  });

  it("allows recursive rm when policy enables it", async () => {
    if (hoisted.resolved.backend === "openviking" && hoisted.resolved.openviking?.fsWrite) {
      hoisted.resolved.openviking.fsWrite.allowRecursiveRm = true;
    }
    hoisted.fsRm.mockResolvedValueOnce({
      uri: "viking://resources/docs/archive",
      recursive: true,
    });
    const { rmOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      rmOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        uri: "viking://resources/docs/archive",
        recursive: true,
      }),
    ).resolves.toMatchObject({
      uri: "viking://resources/docs/archive",
    });
    expect(hoisted.fsRm).toHaveBeenCalledWith({
      uri: "viking://resources/docs/archive",
      recursive: true,
    });
  });

  it("blocks mv to protected uri", async () => {
    const { mvOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      mvOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        fromUri: "viking://resources/docs/draft",
        toUri: "viking://resources/docs/protected",
      }),
    ).rejects.toThrow("protected uri");
    expect(hoisted.fsMv).not.toHaveBeenCalled();
  });

  it("allows mv when both uris satisfy policy", async () => {
    hoisted.fsMv.mockResolvedValueOnce({
      from: "viking://resources/docs/draft",
      to: "viking://resources/docs/archive/draft",
    });
    const { mvOpenVikingFs } = await import("./fs-relations.js");

    await expect(
      mvOpenVikingFs({
        cfg: { memory: { backend: "openviking" } } as never,
        agentId: "main",
        fromUri: "viking://resources/docs/draft",
        toUri: "viking://resources/docs/archive/draft",
      }),
    ).resolves.toMatchObject({
      from: "viking://resources/docs/draft",
    });
    expect(hoisted.fsMv).toHaveBeenCalledWith({
      fromUri: "viking://resources/docs/draft",
      toUri: "viking://resources/docs/archive/draft",
    });
  });
});
