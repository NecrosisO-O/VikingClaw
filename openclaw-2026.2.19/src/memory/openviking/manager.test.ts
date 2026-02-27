import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { OpenVikingSearchStrategy } from "../../config/types.memory.js";
import type { ResolvedMemoryBackendConfig, ResolvedOpenVikingConfig } from "../backend-config.js";

const hoisted = vi.hoisted(() => ({
  search: vi.fn(),
  find: vi.fn(),
  read: vi.fn(async () => ""),
  abstract: vi.fn(async () => ""),
  overview: vi.fn(async () => ""),
  relations: vi.fn(async () => []),
  health: vi.fn(async () => true),
  resolveLinkedSessionId: vi.fn(() => "linked-ov-session"),
  getOutboxStats: vi.fn(() => ({ depth: 0 })),
  getBridgeStats: vi.fn(() => ({
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
  })),
}));

vi.mock("./client.js", () => ({
  OpenVikingClient: class {
    async search(payload: unknown): Promise<unknown> {
      return await hoisted.search(payload);
    }

    async find(payload: unknown): Promise<unknown> {
      return await hoisted.find(payload);
    }

    async read(uri: string): Promise<string> {
      return await hoisted.read(uri);
    }

    async abstract(uri: string): Promise<string> {
      return await hoisted.abstract(uri);
    }

    async overview(uri: string): Promise<string> {
      return await hoisted.overview(uri);
    }

    async relations(uri: string): Promise<Array<{ uri: string; reason?: string }>> {
      return await hoisted.relations(uri);
    }

    async health(): Promise<boolean> {
      return await hoisted.health();
    }
  },
}));

vi.mock("./bridge.js", () => ({
  resolveLinkedOpenVikingSessionId: (params: unknown) => hoisted.resolveLinkedSessionId(params),
  getOpenVikingOutboxStats: (params: unknown) => hoisted.getOutboxStats(params),
  getOpenVikingBridgeStats: (params: unknown) => hoisted.getBridgeStats(params),
}));

function createOpenVikingConfig(params?: {
  endpoint?: string;
  explainability?: boolean;
  includeResources?: boolean;
  includeSkills?: boolean;
  strategy?: OpenVikingSearchStrategy;
  readLayer?: "l0" | "l1" | "l2" | "progressive";
  maxEntries?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  relationExpansion?: boolean;
  relationMaxDepth?: number;
  relationMaxAnchors?: number;
  relationMaxExpandedEntries?: number;
  relationSeedAnchorScore?: number;
  relationPriorityBudgetBoost?: boolean;
  relationPriorityDepthBonus?: number;
  relationPriorityAnchorsBonus?: number;
  relationPriorityExpandedBonus?: number;
}): ResolvedOpenVikingConfig {
  return {
    endpoint: params?.endpoint ?? "http://127.0.0.1:9432",
    headers: {},
    timeoutMs: 1_000,
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
      includeResources: params?.includeResources ?? false,
      includeSkills: params?.includeSkills ?? false,
      explainability: params?.explainability === true,
      strategy: params?.strategy ?? "auto",
      readLayer: params?.readLayer ?? "progressive",
      maxEntries: params?.maxEntries ?? 6,
      maxSnippetChars: params?.maxSnippetChars ?? 700,
      maxInjectedChars: params?.maxInjectedChars ?? 4_000,
      relationExpansion: params?.relationExpansion === true,
      relationMaxDepth: params?.relationMaxDepth ?? 1,
      relationMaxAnchors: params?.relationMaxAnchors ?? 2,
      relationMaxExpandedEntries: params?.relationMaxExpandedEntries ?? 4,
      relationSeedAnchorScore: params?.relationSeedAnchorScore ?? 0.55,
      relationPriorityBudgetBoost: params?.relationPriorityBudgetBoost ?? true,
      relationPriorityDepthBonus: params?.relationPriorityDepthBonus ?? 1,
      relationPriorityAnchorsBonus: params?.relationPriorityAnchorsBonus ?? 1,
      relationPriorityExpandedBonus: params?.relationPriorityExpandedBonus ?? 2,
    },
  };
}

function createMemoryConfig(
  resolvedOpenViking: ResolvedOpenVikingConfig,
): ResolvedMemoryBackendConfig {
  return {
    backend: "openviking",
    citations: "auto",
    openviking: resolvedOpenViking,
  };
}

async function createManager(params?: {
  endpoint?: string;
  explainability?: boolean;
  includeResources?: boolean;
  includeSkills?: boolean;
  strategy?: OpenVikingSearchStrategy;
  readLayer?: "l0" | "l1" | "l2" | "progressive";
  maxEntries?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  relationExpansion?: boolean;
  relationMaxDepth?: number;
  relationMaxAnchors?: number;
  relationMaxExpandedEntries?: number;
  relationSeedAnchorScore?: number;
  relationPriorityBudgetBoost?: boolean;
  relationPriorityDepthBonus?: number;
  relationPriorityAnchorsBonus?: number;
  relationPriorityExpandedBonus?: number;
  agentId?: string;
}) {
  const { OpenVikingMemoryManager } = await import("./manager.js");
  return await OpenVikingMemoryManager.create({
    cfg: { memory: { backend: "openviking" } } as OpenClawConfig,
    agentId: params?.agentId ?? "agent-main",
    resolved: createMemoryConfig(
      createOpenVikingConfig({
        endpoint: params?.endpoint,
        explainability: params?.explainability,
        includeResources: params?.includeResources,
        includeSkills: params?.includeSkills,
        strategy: params?.strategy,
        readLayer: params?.readLayer,
        maxEntries: params?.maxEntries,
        maxSnippetChars: params?.maxSnippetChars,
        maxInjectedChars: params?.maxInjectedChars,
        relationExpansion: params?.relationExpansion,
        relationMaxDepth: params?.relationMaxDepth,
        relationMaxAnchors: params?.relationMaxAnchors,
        relationMaxExpandedEntries: params?.relationMaxExpandedEntries,
        relationSeedAnchorScore: params?.relationSeedAnchorScore,
        relationPriorityBudgetBoost: params?.relationPriorityBudgetBoost,
        relationPriorityDepthBonus: params?.relationPriorityDepthBonus,
        relationPriorityAnchorsBonus: params?.relationPriorityAnchorsBonus,
        relationPriorityExpandedBonus: params?.relationPriorityExpandedBonus,
      }),
    ),
  });
}

describe("openviking manager explainability", () => {
  beforeEach(() => {
    hoisted.search.mockReset();
    hoisted.find.mockReset();
    hoisted.read.mockReset();
    hoisted.abstract.mockReset();
    hoisted.overview.mockReset();
    hoisted.relations.mockReset();
    hoisted.health.mockReset();
    hoisted.resolveLinkedSessionId.mockReset();
    hoisted.getOutboxStats.mockReset();
    hoisted.read.mockResolvedValue("");
    hoisted.abstract.mockResolvedValue("");
    hoisted.overview.mockResolvedValue("");
    hoisted.find.mockResolvedValue({ memories: [], resources: [], skills: [] });
    hoisted.relations.mockResolvedValue([]);
    hoisted.health.mockResolvedValue(true);
    hoisted.resolveLinkedSessionId.mockReturnValue("linked-ov-session");
    hoisted.getOutboxStats.mockReturnValue({ depth: 0 });
  });

  it("surfaces explainability summary in status after a search", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/summary", score: 0.9, overview: "memory-hit" }],
      resources: [{ uri: "viking://resource/docs/guide.md", score: 0.8, overview: "resource-hit" }],
      skills: [{ uri: "viking://resource/skills/plan.md", score: 0.7, overview: "skill-hit" }],
      query_plan: {
        queries: [
          { query: "project marker", context_type: "memory", priority: 1 },
          { query: "skill guidance", context_type: "skill" },
        ],
      },
      query_results: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
    });
    const manager = await createManager({
      explainability: true,
      includeResources: true,
      includeSkills: true,
      endpoint: "http://127.0.0.1:9432",
      agentId: "agent-explain",
    });

    const rows = await manager.search("  project marker  ", { sessionKey: "main:session" });
    expect(rows).toHaveLength(3);

    const status = manager.status();
    const search = (
      status.custom as {
        search?: {
          explainability?: boolean;
          lastExplain?: {
            typedQueries?: number;
            queryResults?: number;
            topQueries?: Array<{ query?: string; contextType?: string; priority?: number }>;
          };
        };
      }
    ).search;
    expect(search?.explainability).toBe(true);
    expect(search?.lastExplain?.typedQueries).toBe(2);
    expect(search?.lastExplain?.queryResults).toBe(3);
    expect(search?.lastExplain?.topQueries?.[0]).toMatchObject({
      query: "project marker",
      contextType: "memory",
      priority: 1,
    });
    expect(hoisted.resolveLinkedSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "main:session" }),
    );
  });

  it("keeps lastExplain absent when explainability is disabled", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/only-memory", score: 0.95, overview: "memory-hit" }],
      query_plan: { queries: [{ query: "should-not-show", context_type: "memory" }] },
      query_results: [{ id: "r1" }],
    });
    const manager = await createManager({
      explainability: false,
      endpoint: "http://127.0.0.1:9544",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-no-explain",
    });

    const rows = await manager.search("test");
    expect(rows).toHaveLength(1);

    const status = manager.status();
    const search = (
      status.custom as {
        search?: {
          explainability?: boolean;
          lastExplain?: unknown;
        };
      }
    ).search;
    expect(search?.explainability).toBe(false);
    expect("lastExplain" in (search ?? {})).toBe(false);
  });

  it("falls back to find when search has no selected contexts", async () => {
    hoisted.search.mockResolvedValue({
      memories: [],
      resources: [],
      skills: [],
      query_plan: {
        queries: [{ query: "deploy config path", context_type: "resource", priority: 1 }],
      },
      query_results: [],
    });
    hoisted.find.mockResolvedValue({
      memories: [{ uri: "viking://session/fallback-hit", score: 0.81, overview: "fallback-memory" }],
      resources: [],
      skills: [],
    });
    const manager = await createManager({
      explainability: true,
      includeResources: false,
      includeSkills: false,
      agentId: "agent-find-fallback",
    });

    const rows = await manager.search("deploy config path");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "viking://session/fallback-hit" });
    expect(hoisted.find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "deploy config path",
      }),
    );

    const status = manager.status();
    const lastExplain = (
      status.custom as {
        search?: {
          lastExplain?: { fallback?: string; fallbackHits?: number };
        };
      }
    ).search?.lastExplain;
    expect(lastExplain?.fallback).toBe("find");
    expect(lastExplain?.fallbackHits).toBe(1);
  });
});

describe("openviking manager search strategy", () => {
  beforeEach(() => {
    hoisted.search.mockReset();
    hoisted.find.mockReset();
    hoisted.read.mockReset();
    hoisted.abstract.mockReset();
    hoisted.overview.mockReset();
    hoisted.relations.mockReset();
    hoisted.health.mockReset();
    hoisted.resolveLinkedSessionId.mockReset();
    hoisted.getOutboxStats.mockReset();
    hoisted.read.mockResolvedValue("");
    hoisted.abstract.mockResolvedValue("");
    hoisted.overview.mockResolvedValue("");
    hoisted.find.mockResolvedValue({ memories: [], resources: [], skills: [] });
    hoisted.relations.mockResolvedValue([]);
    hoisted.health.mockResolvedValue(true);
    hoisted.resolveLinkedSessionId.mockReturnValue("linked-ov-session");
    hoisted.getOutboxStats.mockReturnValue({ depth: 0 });
  });

  it("uses memory_first strategy with memory-only defaults", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/memory-1", score: 0.7, overview: "memory-hit" }],
      resources: [
        { uri: "viking://resource/docs/readme.md", score: 0.95, overview: "resource-hit" },
      ],
      skills: [{ uri: "viking://resource/skills/triage.md", score: 0.9, overview: "skill-hit" }],
    });
    const manager = await createManager({
      strategy: "memory_first",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-memory-first",
    });

    const rows = await manager.search("status");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("viking://session/memory-1");

    const search = (
      manager.status().custom as { search?: { lastStrategy?: Record<string, unknown> } }
    ).search;
    expect(search?.lastStrategy).toMatchObject({
      strategy: "memory_first",
      priority: "memory",
      includeResources: false,
      includeSkills: false,
    });
  });

  it("uses resource_first strategy and boosts resource ranking", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/memory-2", score: 0.8, overview: "memory-hit" }],
      resources: [{ uri: "viking://resource/docs/spec.md", score: 0.75, overview: "resource-hit" }],
      skills: [{ uri: "viking://resource/skills/plan.md", score: 0.7, overview: "skill-hit" }],
    });
    const manager = await createManager({
      strategy: "resource_first",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-resource-first",
    });

    const rows = await manager.search("show docs");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.path).toBe("viking://resource/docs/spec.md");
    expect(rows[1]?.path).toBe("viking://session/memory-2");

    const search = (
      manager.status().custom as { search?: { lastStrategy?: Record<string, unknown> } }
    ).search;
    expect(search?.lastStrategy).toMatchObject({
      strategy: "resource_first",
      priority: "resource",
      includeResources: true,
      includeSkills: false,
    });
  });

  it("uses skill_first strategy and includes skills even when includeSkills is false", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/memory-3", score: 0.68, overview: "memory-hit" }],
      resources: [
        { uri: "viking://resource/docs/manual.md", score: 0.66, overview: "resource-hit" },
      ],
      skills: [{ uri: "viking://resource/skills/review.md", score: 0.7, overview: "skill-hit" }],
    });
    const manager = await createManager({
      strategy: "skill_first",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-skill-first",
    });

    const rows = await manager.search("next plan");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.path).toBe("viking://resource/skills/review.md");
    expect(rows[1]?.path).toBe("viking://session/memory-3");

    const search = (
      manager.status().custom as { search?: { lastStrategy?: Record<string, unknown> } }
    ).search;
    expect(search?.lastStrategy).toMatchObject({
      strategy: "skill_first",
      priority: "skill",
      includeResources: false,
      includeSkills: true,
    });
  });

  it("auto strategy detects resource intent from query signals", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/memory-4", score: 0.78, overview: "memory-hit" }],
      resources: [
        { uri: "viking://resource/docs/config.md", score: 0.74, overview: "resource-hit" },
      ],
      skills: [{ uri: "viking://resource/skills/style.md", score: 0.72, overview: "skill-hit" }],
    });
    const manager = await createManager({
      strategy: "auto",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-auto",
    });

    const rows = await manager.search("show config file documentation path");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.path).toBe("viking://resource/docs/config.md");
    expect(rows[1]?.path).toBe("viking://session/memory-4");

    const search = (
      manager.status().custom as { search?: { lastStrategy?: Record<string, unknown> } }
    ).search;
    expect(search?.lastStrategy).toMatchObject({
      strategy: "auto",
      priority: "resource",
      includeResources: true,
      includeSkills: false,
    });
  });

  it("auto strategy prefers planner query_plan context over keyword heuristics", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/memory-plan-1", score: 0.8, overview: "memory-hit" }],
      resources: [{ uri: "viking://resource/docs/plan.md", score: 0.82, overview: "resource-hit" }],
      skills: [{ uri: "viking://resource/skills/plan.md", score: 0.74, overview: "skill-hit" }],
      query_plan: {
        queries: [
          { query: "project docs", context_type: "resource", priority: 4 },
          { query: "delivery workflow", context_type: "skill", priority: 1 },
        ],
      },
    });
    const manager = await createManager({
      strategy: "auto",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-auto-planner-plan",
    });

    const rows = await manager.search("show config file documentation path");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.path).toBe("viking://resource/skills/plan.md");

    const search = (
      manager.status().custom as { search?: { lastStrategy?: Record<string, unknown> } }
    ).search;
    expect(search?.lastStrategy).toMatchObject({
      strategy: "auto",
      priority: "skill",
      includeResources: true,
      includeSkills: true,
      reason: "auto-planner-plan",
    });
  });

  it("auto strategy can use query_results context signals when query_plan is unavailable", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/memory-plan-2", score: 0.74, overview: "memory-hit" }],
      resources: [
        { uri: "viking://resource/docs/config-ref.md", score: 0.8, overview: "resource-hit" },
      ],
      skills: [{ uri: "viking://resource/skills/style.md", score: 0.7, overview: "skill-hit" }],
      query_results: [
        {
          query: { context_type: "memory" },
          matched_contexts: [{ id: "m1" }, { id: "m2" }],
        },
      ],
    });
    const manager = await createManager({
      strategy: "auto",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-auto-planner-results",
    });

    const rows = await manager.search("show config file docs path");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.path).toBe("viking://session/memory-plan-2");

    const search = (
      manager.status().custom as { search?: { lastStrategy?: Record<string, unknown> } }
    ).search;
    expect(search?.lastStrategy).toMatchObject({
      strategy: "auto",
      priority: "memory",
      includeResources: true,
      includeSkills: false,
      reason: "auto-planner-results",
    });
  });
});

describe("openviking manager layered snippet loading", () => {
  beforeEach(() => {
    hoisted.search.mockReset();
    hoisted.find.mockReset();
    hoisted.read.mockReset();
    hoisted.abstract.mockReset();
    hoisted.overview.mockReset();
    hoisted.relations.mockReset();
    hoisted.health.mockReset();
    hoisted.resolveLinkedSessionId.mockReset();
    hoisted.getOutboxStats.mockReset();
    hoisted.read.mockResolvedValue("");
    hoisted.abstract.mockResolvedValue("");
    hoisted.overview.mockResolvedValue("");
    hoisted.find.mockResolvedValue({ memories: [], resources: [], skills: [] });
    hoisted.relations.mockResolvedValue([]);
    hoisted.health.mockResolvedValue(true);
    hoisted.resolveLinkedSessionId.mockReturnValue("linked-ov-session");
    hoisted.getOutboxStats.mockReturnValue({ depth: 0 });
  });

  it("upgrades to l2 in progressive mode when summaries are too short", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/layered-1", score: 0.9, overview: "tiny" }],
    });
    hoisted.read.mockResolvedValue("long form memory content from l2");
    const manager = await createManager({
      readLayer: "progressive",
      maxSnippetChars: 200,
      maxInjectedChars: 500,
      maxEntries: 3,
      agentId: "agent-layer-upgrade",
    });

    const rows = await manager.search("what did we decide");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snippet).toContain("long form memory content");
    expect(hoisted.read).toHaveBeenCalledTimes(1);

    const search = (
      manager.status().custom as {
        search?: { lastLayering?: Record<string, unknown> };
      }
    ).search;
    expect(search?.lastLayering).toMatchObject({
      requestedLayer: "progressive",
      l2: 1,
      l1: 0,
      l0: 0,
      entries: 1,
    });
  });

  it("applies maxEntries and maxInjectedChars budgets", async () => {
    hoisted.search.mockResolvedValue({
      memories: [
        { uri: "viking://session/budget-1", score: 0.95, overview: "A".repeat(80) },
        { uri: "viking://session/budget-2", score: 0.93, overview: "B".repeat(80) },
      ],
    });
    const manager = await createManager({
      readLayer: "l1",
      maxEntries: 2,
      maxSnippetChars: 80,
      maxInjectedChars: 50,
      agentId: "agent-layer-budget",
    });

    const rows = await manager.search("budget check", { maxResults: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snippet.length).toBeLessThanOrEqual(50);

    const search = (
      manager.status().custom as {
        search?: { lastLayering?: Record<string, unknown>; lastRanking?: Record<string, unknown> };
      }
    ).search;
    expect(search?.lastLayering).toMatchObject({
      requestedLayer: "l1",
      entries: 1,
      truncatedByBudget: true,
      l1: 1,
    });
    expect(search?.lastRanking).toMatchObject({
      hardLimit: 2,
      totalCandidates: 2,
      filteredCandidates: 2,
      selectedCandidates: 2,
      emittedCandidates: 1,
      droppedByMaxEntries: 0,
      droppedByBudget: 1,
      skippedEmptySnippet: 0,
    });
  });
});

describe("openviking manager relation expansion", () => {
  beforeEach(() => {
    hoisted.search.mockReset();
    hoisted.find.mockReset();
    hoisted.read.mockReset();
    hoisted.abstract.mockReset();
    hoisted.overview.mockReset();
    hoisted.relations.mockReset();
    hoisted.health.mockReset();
    hoisted.resolveLinkedSessionId.mockReset();
    hoisted.getOutboxStats.mockReset();
    hoisted.read.mockResolvedValue("");
    hoisted.abstract.mockResolvedValue("");
    hoisted.overview.mockResolvedValue("");
    hoisted.find.mockResolvedValue({ memories: [], resources: [], skills: [] });
    hoisted.relations.mockResolvedValue([]);
    hoisted.health.mockResolvedValue(true);
    hoisted.resolveLinkedSessionId.mockReturnValue("linked-ov-session");
    hoisted.getOutboxStats.mockReturnValue({ depth: 0 });
  });

  it("adds relation-expanded hits and direct/relation markers when enabled", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/rel-memory-1", score: 0.92, overview: "direct-memory" }],
    });
    hoisted.relations.mockImplementation(async (uri: string) => {
      if (uri === "viking://session/rel-memory-1") {
        return [{ uri: "viking://resource/docs/linked-spec", reason: "linked-doc" }];
      }
      return [];
    });
    hoisted.overview.mockImplementation(async (uri: string) => {
      if (uri === "viking://resource/docs/linked-spec") {
        return "linked-spec-overview";
      }
      return "direct-memory";
    });
    const manager = await createManager({
      relationExpansion: true,
      relationMaxDepth: 1,
      relationMaxAnchors: 1,
      relationMaxExpandedEntries: 2,
      readLayer: "l1",
      agentId: "agent-rel-enabled",
    });

    const rows = await manager.search("show related docs", { maxResults: 4 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.snippet).toContain("[direct-hit]");
    expect(rows[1]?.path).toBe("viking://resource/docs/linked-spec");
    expect(rows[1]?.snippet).toContain("[relation-expanded");

    const search = (
      manager.status().custom as {
        search?: { lastRelations?: Record<string, unknown>; lastRanking?: Record<string, unknown> };
      }
    ).search;
    expect(search?.lastRelations).toMatchObject({
      enabled: true,
      discovered: 1,
      directSelected: 1,
      relationSelected: 1,
    });
    expect(search?.lastRanking).toMatchObject({
      directCandidates: 1,
      relationCandidates: 1,
      selectedCandidates: 2,
      emittedCandidates: 2,
    });
  });

  it("uses query_plan target directories as relation anchors when direct hits are empty", async () => {
    const seedUri = "viking://resource/docs/root";
    const relationUri = "viking://resource/docs/from-seed";
    hoisted.search.mockResolvedValue({
      memories: [],
      resources: [],
      skills: [],
      query_plan: {
        queries: [
          {
            query: "linked docs",
            context_type: "resource",
            priority: 1,
            target_directories: [seedUri],
          },
        ],
      },
    });
    hoisted.relations.mockImplementation(async (uri: string) => {
      if (uri === seedUri) {
        return [{ uri: relationUri, reason: "seed-link" }];
      }
      return [];
    });
    hoisted.overview.mockImplementation(async (uri: string) => {
      if (uri === relationUri) {
        return "seed-relation-overview";
      }
      return "";
    });
    const manager = await createManager({
      relationExpansion: true,
      relationMaxDepth: 1,
      relationMaxAnchors: 2,
      relationMaxExpandedEntries: 2,
      readLayer: "l1",
      strategy: "auto",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-rel-seed",
    });

    const rows = await manager.search("show config path");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe(relationUri);
    expect(rows[0]?.snippet).toContain("[relation-expanded");
    expect(hoisted.relations).toHaveBeenCalledWith(seedUri);

    const search = (
      manager.status().custom as {
        search?: { lastRelations?: Record<string, unknown>; lastRanking?: Record<string, unknown> };
      }
    ).search;
    expect(search?.lastRelations).toMatchObject({
      anchors: 1,
      seedAnchors: 1,
      discovered: 1,
      directSelected: 0,
      relationSelected: 1,
    });
    expect(search?.lastRanking).toMatchObject({
      directCandidates: 0,
      relationCandidates: 1,
      selectedCandidates: 1,
      emittedCandidates: 1,
    });
  });

  it("applies relation priority budget boost for resource-priority auto strategy", async () => {
    hoisted.search.mockResolvedValue({
      memories: [
        { uri: "viking://session/rel-budget-memory", score: 0.82, overview: "memory-hit" },
      ],
      resources: [
        { uri: "viking://resource/docs/rel-budget-doc", score: 0.8, overview: "resource-hit" },
      ],
      skills: [],
    });
    hoisted.relations.mockResolvedValue([]);
    const manager = await createManager({
      relationExpansion: true,
      relationMaxDepth: 1,
      relationMaxAnchors: 1,
      relationMaxExpandedEntries: 1,
      relationPriorityBudgetBoost: true,
      relationPriorityDepthBonus: 1,
      relationPriorityAnchorsBonus: 1,
      relationPriorityExpandedBonus: 2,
      readLayer: "l1",
      strategy: "auto",
      includeResources: false,
      includeSkills: false,
      agentId: "agent-rel-budget-boost",
    });

    const rows = await manager.search("show config docs path");
    expect(rows).toHaveLength(2);

    const search = (
      manager.status().custom as { search?: { lastRelations?: Record<string, unknown> } }
    ).search;
    expect(search?.lastRelations).toMatchObject({
      priority: "resource",
      boostApplied: true,
      baseMaxDepth: 1,
      baseMaxAnchors: 1,
      baseMaxExpandedEntries: 1,
      maxDepth: 2,
      maxAnchors: 2,
      maxExpandedEntries: 3,
      anchors: 2,
    });
  });

  it("does not call relations endpoint when relation expansion is disabled", async () => {
    hoisted.search.mockResolvedValue({
      memories: [{ uri: "viking://session/rel-memory-2", score: 0.9, overview: "direct-memory" }],
    });
    const manager = await createManager({
      relationExpansion: false,
      agentId: "agent-rel-disabled",
    });

    const rows = await manager.search("show related docs", { maxResults: 4 });
    expect(rows).toHaveLength(1);
    expect(hoisted.relations).not.toHaveBeenCalled();
    const search = (
      manager.status().custom as {
        search?: { lastRelations?: Record<string, unknown> };
      }
    ).search;
    expect(search?.lastRelations).toMatchObject({
      enabled: false,
      relationSelected: 0,
    });
  });
});
