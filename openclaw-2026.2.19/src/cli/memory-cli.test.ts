import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const ingestOpenVikingResource = vi.fn();
const ingestOpenVikingSkill = vi.fn();
const findOpenVikingContext = vi.fn();
const grepOpenVikingContext = vi.fn();
const globOpenVikingContext = vi.fn();
const listOpenVikingFs = vi.fn();
const treeOpenVikingFs = vi.fn();
const statOpenVikingFs = vi.fn();
const mkdirOpenVikingFs = vi.fn();
const rmOpenVikingFs = vi.fn();
const mvOpenVikingFs = vi.fn();
const listOpenVikingRelations = vi.fn();
const linkOpenVikingRelation = vi.fn();
const unlinkOpenVikingRelation = vi.fn();
const listOpenVikingSessions = vi.fn();
const getOpenVikingSession = vi.fn();
const deleteOpenVikingSession = vi.fn();
const extractOpenVikingSession = vi.fn();
const addOpenVikingSessionMessage = vi.fn();
const exportOpenVikingPack = vi.fn();
const importOpenVikingPack = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../memory/openviking/ingest.js", () => ({
  ingestOpenVikingResource,
  ingestOpenVikingSkill,
}));

vi.mock("../memory/openviking/fs-relations.js", () => ({
  findOpenVikingContext,
  grepOpenVikingContext,
  globOpenVikingContext,
  listOpenVikingFs,
  treeOpenVikingFs,
  statOpenVikingFs,
  mkdirOpenVikingFs,
  rmOpenVikingFs,
  mvOpenVikingFs,
  listOpenVikingRelations,
  linkOpenVikingRelation,
  unlinkOpenVikingRelation,
  listOpenVikingSessions,
  getOpenVikingSession,
  deleteOpenVikingSession,
  extractOpenVikingSession,
  addOpenVikingSessionMessage,
  exportOpenVikingPack,
  importOpenVikingPack,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

let registerMemoryCli: typeof import("./memory-cli.js").registerMemoryCli;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;
let isVerbose: typeof import("../globals.js").isVerbose;
let setVerbose: typeof import("../globals.js").setVerbose;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./memory-cli.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
  ({ isVerbose, setVerbose } = await import("../globals.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
  ingestOpenVikingResource.mockReset();
  ingestOpenVikingSkill.mockReset();
  findOpenVikingContext.mockReset();
  grepOpenVikingContext.mockReset();
  globOpenVikingContext.mockReset();
  listOpenVikingFs.mockReset();
  treeOpenVikingFs.mockReset();
  statOpenVikingFs.mockReset();
  mkdirOpenVikingFs.mockReset();
  rmOpenVikingFs.mockReset();
  mvOpenVikingFs.mockReset();
  listOpenVikingRelations.mockReset();
  linkOpenVikingRelation.mockReset();
  unlinkOpenVikingRelation.mockReset();
  listOpenVikingSessions.mockReset();
  getOpenVikingSession.mockReset();
  deleteOpenVikingSession.mockReset();
  extractOpenVikingSession.mockReset();
  addOpenVikingSessionMessage.mockReset();
  exportOpenVikingPack.mockReset();
  importOpenVikingPack.mockReset();
  process.exitCode = undefined;
  setVerbose(false);
});

describe("memory cli", () => {
  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  async function withQmdIndexDb(content: string, run: (dbPath: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-qmd-index-"));
    const dbPath = path.join(tmpDir, "index.sqlite");
    try {
      await fs.writeFile(dbPath, content, "utf-8");
      await run(dbPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, close });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("logs qmd index file path and size after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD index: "));
      expect(log).toHaveBeenCalledWith("Memory index updated (main).");
      expect(close).toHaveBeenCalled();
    });
  });

  it("fails index when qmd db file is empty", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Memory index failed (main): QMD index file is empty"),
      );
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });

  it("ingests resource via openviking cli command", async () => {
    ingestOpenVikingResource.mockResolvedValueOnce({
      kind: "resource",
      endpoint: "http://127.0.0.1:9432",
      attempts: 1,
      waited: true,
      payload: { uri: "viking://resources/runtime/readme.md" },
      waitStatus: { resource: { processed: 1, error_count: 0, errors: [] } },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli([
      "ingest-resource",
      "/tmp/readme.md",
      "--reason",
      "unit test",
      "--instruction",
      "index this file",
    ]);

    expect(ingestOpenVikingResource).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        path: "/tmp/readme.md",
        reason: "unit test",
        instruction: "index this file",
        wait: true,
        retries: 2,
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenViking resource ingest (main)"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("viking://resources/runtime/readme.md"));
  });

  it("ingest-resource surfaces errors and sets exit code", async () => {
    ingestOpenVikingResource.mockRejectedValueOnce(new Error("openviking unavailable"));

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["ingest-resource", "/tmp/fail.md"]);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("OpenViking resource ingest failed: openviking unavailable"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("ingests skill from --data payload", async () => {
    ingestOpenVikingSkill.mockResolvedValueOnce({
      kind: "skill",
      endpoint: "http://127.0.0.1:9432",
      attempts: 1,
      waited: false,
      payload: { uri: "viking://skills/incident-playbook" },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli([
      "ingest-skill",
      "--data",
      '{"name":"incident-playbook","desc":"steps"}',
      "--no-wait",
    ]);

    expect(ingestOpenVikingSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        wait: false,
        retries: 2,
        data: { name: "incident-playbook", desc: "steps" },
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenViking skill ingest (main)"));
  });

  it("ingest-skill accepts payload file", async () => {
    ingestOpenVikingSkill.mockResolvedValueOnce({
      kind: "skill",
      endpoint: "http://127.0.0.1:9432",
      attempts: 1,
      waited: true,
      payload: {},
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-skill-file-"));
    const payloadPath = path.join(tmpDir, "skill.json");
    try {
      await fs.writeFile(payloadPath, '{"name":"skill-from-file","level":"advanced"}', "utf8");
      await runMemoryCli(["ingest-skill", "--file", payloadPath]);
      expect(ingestOpenVikingSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: "skill-from-file", level: "advanced" },
        }),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ingest-skill fails when both --data and --file are provided", async () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    await runMemoryCli(["ingest-skill", "--data", "x", "--file", "/tmp/skill.json"]);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("OpenViking skill ingest failed: use either --data or --file"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fs-ls calls openviking filesystem helper", async () => {
    listOpenVikingFs.mockResolvedValueOnce(["docs/readme.md", "docs/guide.md"]);

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["fs-ls", "viking://resources/docs", "--recursive", "--simple"]);

    expect(listOpenVikingFs).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs",
        recursive: true,
        simple: true,
        output: "agent",
      }),
    );
    expect(log).toHaveBeenCalledWith("docs/readme.md\ndocs/guide.md");
  });

  it("find command calls openviking find helper", async () => {
    findOpenVikingContext.mockResolvedValueOnce({
      memories: [{ uri: "viking://memories/ops", score: 0.92, abstract: "ops note" }],
      resources: [],
      skills: [],
    });

    await runMemoryCli([
      "find",
      "deploy config path",
      "--target-uri",
      "viking://resources",
      "--limit",
      "8",
      "--score-threshold",
      "0.35",
      "--json",
    ]);

    expect(findOpenVikingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        query: "deploy config path",
        targetUri: "viking://resources",
        limit: 8,
        scoreThreshold: 0.35,
      }),
    );
  });

  it("grep command calls openviking grep helper", async () => {
    grepOpenVikingContext.mockResolvedValueOnce({
      matches: [{ uri: "viking://resources/docs/runbook.md", line: 12, content: "OPENAI_API_KEY=..." }],
      count: 1,
    });

    await runMemoryCli([
      "grep",
      "viking://resources/docs",
      "OPENAI_API_KEY",
      "--case-insensitive",
      "--json",
    ]);

    expect(grepOpenVikingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs",
        pattern: "OPENAI_API_KEY",
        caseInsensitive: true,
      }),
    );
  });

  it("glob command calls openviking glob helper", async () => {
    globOpenVikingContext.mockResolvedValueOnce({
      matches: ["viking://resources/docs/readme.md", "viking://resources/docs/guide.md"],
      count: 2,
    });

    await runMemoryCli(["glob", "**/*.md", "--uri", "viking://resources/docs", "--json"]);

    expect(globOpenVikingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        pattern: "**/*.md",
        uri: "viking://resources/docs",
      }),
    );
  });

  it("sessions-list command calls list helper", async () => {
    listOpenVikingSessions.mockResolvedValueOnce([
      { session_id: "sid-1", uri: "viking://session/sid-1", is_dir: true },
    ]);

    await runMemoryCli(["sessions-list", "--json"]);

    expect(listOpenVikingSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
      }),
    );
  });

  it("sessions-get and sessions-extract call helpers", async () => {
    getOpenVikingSession.mockResolvedValueOnce({ session_id: "sid-1", message_count: 2 });
    extractOpenVikingSession.mockResolvedValueOnce([
      { uri: "viking://user/memories/pref", abstract: "pref" },
    ]);

    await runMemoryCli(["sessions-get", "sid-1", "--json"]);
    await runMemoryCli(["sessions-extract", "sid-1", "--json"]);

    expect(getOpenVikingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionId: "sid-1",
      }),
    );
    expect(extractOpenVikingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionId: "sid-1",
      }),
    );
  });

  it("sessions-delete and sessions-message call helpers", async () => {
    deleteOpenVikingSession.mockResolvedValueOnce({ session_id: "sid-1" });
    addOpenVikingSessionMessage.mockResolvedValueOnce({
      session_id: "sid-1",
      message_count: 3,
    });

    await runMemoryCli(["sessions-delete", "sid-1"]);
    await runMemoryCli(["sessions-message", "sid-1", "user", "remember this", "--json"]);

    expect(deleteOpenVikingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionId: "sid-1",
      }),
    );
    expect(addOpenVikingSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionId: "sid-1",
        role: "user",
        content: "remember this",
      }),
    );
  });

  it("sessions-message validates role", async () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["sessions-message", "sid-1", "system", "not allowed"]);

    expect(addOpenVikingSessionMessage).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('OpenViking sessions-message failed: role must be "user" or "assistant"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("pack-export command calls helper", async () => {
    exportOpenVikingPack.mockResolvedValueOnce({ file: "/tmp/demo.ovpack" });

    await runMemoryCli(["pack-export", "viking://resources/docs", "/tmp/demo.ovpack", "--json"]);

    expect(exportOpenVikingPack).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs",
        to: "/tmp/demo.ovpack",
      }),
    );
  });

  it("pack-import command calls helper and respects flags", async () => {
    importOpenVikingPack.mockResolvedValueOnce({ uri: "viking://resources/docs" });

    await runMemoryCli([
      "pack-import",
      "/tmp/demo.ovpack",
      "viking://resources",
      "--force",
      "--no-vectorize",
      "--json",
    ]);

    expect(importOpenVikingPack).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        filePath: "/tmp/demo.ovpack",
        parent: "viking://resources",
        force: true,
        vectorize: false,
      }),
    );
  });

  it("search-trace prints summary and writes snapshot file", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () =>
        makeMemoryStatus({
          backend: "openviking",
          custom: {
            search: {
              strategy: "auto",
              readLayer: "progressive",
              lastStrategy: {
                strategy: "auto",
                priority: "resource",
                includeResources: true,
                includeSkills: false,
              },
              lastExplain: { typedQueries: 2, queryResults: 1, fallback: "find", fallbackHits: 1 },
              lastLayering: { requestedLayer: "progressive", l0: 1, l1: 2, l2: 3, truncatedByBudget: false },
              lastRelations: { directSelected: 2, relationSelected: 1, discovered: 3 },
              lastRanking: { totalCandidates: 5, selectedCandidates: 3, emittedCandidates: 2, droppedByBudget: 1 },
            },
          },
        }),
      close,
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-trace-"));
    const savePath = path.join(tmpDir, "trace.json");
    try {
      await runMemoryCli(["search-trace", "--save", savePath]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenViking trace saved:"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenViking search trace (latest)"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Decision path:"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("1) Strategy"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Result: emitted 2/5 candidates"));
      const saved = JSON.parse(await fs.readFile(savePath, "utf-8")) as {
        backend?: string;
        search?: unknown;
      };
      expect(saved.backend).toBe("openviking");
      expect(saved.search).toBeTruthy();
      expect(close).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("search-trace reports when trace is unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () =>
        makeMemoryStatus({
          backend: "openviking",
          custom: {},
        }),
      close,
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["search-trace"]);

    expect(log).toHaveBeenCalledWith("No OpenViking search trace available yet.");
    expect(close).toHaveBeenCalled();
  });

  it("search-trace supports json output", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () =>
        makeMemoryStatus({
          backend: "openviking",
          custom: {
            search: {
              lastStrategy: { strategy: "auto", priority: "memory" },
            },
          },
        }),
      close,
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["search-trace", "--json"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('"search"'));
    expect(close).toHaveBeenCalled();
  });

  it("search-trace renders fallback note for empty trace payload", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () =>
        makeMemoryStatus({
          backend: "openviking",
          custom: {
            search: {},
          },
        }),
      close,
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["search-trace"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No trace sections captured yet."));
    expect(close).toHaveBeenCalled();
  });

  it("fs-tree validates output mode", async () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["fs-tree", "viking://resources/docs", "--output", "bad"]);

    expect(treeOpenVikingFs).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('OpenViking fs-tree failed: output must be "agent" or "original"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fs-stat calls stat helper", async () => {
    statOpenVikingFs.mockResolvedValueOnce({ uri: "viking://resources/docs", isDir: true });

    await runMemoryCli(["fs-stat", "viking://resources/docs", "--json"]);

    expect(statOpenVikingFs).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs",
      }),
    );
  });

  it("fs-mkdir calls helper", async () => {
    mkdirOpenVikingFs.mockResolvedValueOnce({ uri: "viking://resources/docs/new-dir" });

    await runMemoryCli(["fs-mkdir", "viking://resources/docs/new-dir", "--json"]);

    expect(mkdirOpenVikingFs).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs/new-dir",
      }),
    );
  });

  it("fs-rm requires --yes confirmation", async () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["fs-rm", "viking://resources/docs/old-dir"]);

    expect(rmOpenVikingFs).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("OpenViking fs-rm failed: fs-rm requires --yes confirmation"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fs-rm calls helper with recursive flag", async () => {
    rmOpenVikingFs.mockResolvedValueOnce({ uri: "viking://resources/docs/old-dir", recursive: true });

    await runMemoryCli([
      "fs-rm",
      "viking://resources/docs/old-dir",
      "--recursive",
      "--yes",
      "--json",
    ]);

    expect(rmOpenVikingFs).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs/old-dir",
        recursive: true,
      }),
    );
  });

  it("fs-mv calls helper", async () => {
    mvOpenVikingFs.mockResolvedValueOnce({
      from: "viking://resources/docs/draft",
      to: "viking://resources/docs/archive/draft",
    });

    await runMemoryCli([
      "fs-mv",
      "viking://resources/docs/draft",
      "viking://resources/docs/archive/draft",
      "--json",
    ]);

    expect(mvOpenVikingFs).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        fromUri: "viking://resources/docs/draft",
        toUri: "viking://resources/docs/archive/draft",
      }),
    );
  });

  it("relations command uses relations helper", async () => {
    listOpenVikingRelations.mockResolvedValueOnce([
      { uri: "viking://resources/docs/design", reason: "spec-link" },
    ]);

    await runMemoryCli(["relations", "viking://resources/docs/runbook", "--json"]);

    expect(listOpenVikingRelations).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        uri: "viking://resources/docs/runbook",
      }),
    );
  });

  it("relation-link and relation-unlink call relation helpers", async () => {
    linkOpenVikingRelation.mockResolvedValueOnce({
      from: "viking://resources/docs/a",
      to: ["viking://resources/docs/b", "viking://resources/docs/c"],
    });
    unlinkOpenVikingRelation.mockResolvedValueOnce({
      from: "viking://resources/docs/a",
      to: "viking://resources/docs/b",
    });

    await runMemoryCli([
      "relation-link",
      "viking://resources/docs/a",
      "viking://resources/docs/b",
      "viking://resources/docs/c",
      "--reason",
      "unit-test",
    ]);
    await runMemoryCli([
      "relation-unlink",
      "viking://resources/docs/a",
      "viking://resources/docs/b",
    ]);

    expect(linkOpenVikingRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        fromUri: "viking://resources/docs/a",
        toUris: ["viking://resources/docs/b", "viking://resources/docs/c"],
        reason: "unit-test",
      }),
    );
    expect(unlinkOpenVikingRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        fromUri: "viking://resources/docs/a",
        toUri: "viking://resources/docs/b",
      }),
    );
  });
});
