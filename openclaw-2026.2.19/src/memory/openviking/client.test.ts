import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedOpenVikingConfig } from "../backend-config.js";
import { OpenVikingClient } from "./client.js";

function createConfig(): ResolvedOpenVikingConfig {
  return {
    endpoint: "http://127.0.0.1:9432",
    headers: {},
    timeoutMs: 1_000,
    targetUri: "viking://",
    dualWrite: false,
    commit: {
      mode: "sync",
      triggers: {
        sessionEnd: true,
        reset: true,
        everyNMessages: 40,
        everyNMinutes: 20,
      },
    },
    outbox: {
      enabled: false,
      flushIntervalMs: 3_000,
      maxBatchSize: 25,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
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
}

describe("openviking client error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to HTTP status text when error response body is empty", async () => {
    const fetchMock = vi.fn(
      async () => new Response("", { status: 503, statusText: "Service Unavailable" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(client.search({ query: "hello" })).rejects.toThrow(
      "openviking request failed (503): Service Unavailable",
    );
  });

  it("prefers API error message over raw response text when available", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: "error", error: { message: "backend unavailable" } }),
          {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(client.search({ query: "hello" })).rejects.toThrow(
      "openviking request failed (500): backend unavailable",
    );
  });

  it("calls abstract and overview content endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/content/abstract")) {
        return new Response(JSON.stringify({ status: "ok", result: "l0-summary" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/content/overview")) {
        return new Response(JSON.stringify({ status: "ok", result: "l1-overview" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "ok", result: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(client.abstract("viking://session/demo")).resolves.toBe("l0-summary");
    await expect(client.overview("viking://session/demo")).resolves.toBe("l1-overview");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/content/abstract?uri=viking%3A%2F%2Fsession%2Fdemo"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/content/overview?uri=viking%3A%2F%2Fsession%2Fdemo"),
      expect.any(Object),
    );
  });

  it("calls resource, skill and wait endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/resources")) {
        return new Response(
          JSON.stringify({ status: "ok", result: { uri: "viking://resources/demo/readme.md" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/skills")) {
        return new Response(
          JSON.stringify({ status: "ok", result: { uri: "viking://skills/demo" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/system/wait")) {
        return new Response(
          JSON.stringify({ status: "ok", result: { resource: { processed: 1 } } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(
      client.addResource({
        path: "/tmp/demo.md",
        reason: "test",
        instruction: "index",
        wait: true,
        timeout: 10,
      }),
    ).resolves.toMatchObject({ uri: "viking://resources/demo/readme.md" });
    await expect(client.addSkill({ data: { name: "demo" }, wait: false })).resolves.toMatchObject({
      uri: "viking://skills/demo",
    });
    await expect(client.waitProcessed({ timeout: 5 })).resolves.toMatchObject({
      resource: { processed: 1 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/resources"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/skills"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/system/wait"),
      expect.any(Object),
    );
  });

  it("calls fs and relation endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/fs/ls")) {
        return new Response(JSON.stringify({ status: "ok", result: ["docs/readme.md"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/fs/tree")) {
        return new Response(JSON.stringify({ status: "ok", result: [{ name: "docs" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/fs/stat")) {
        return new Response(
          JSON.stringify({ status: "ok", result: { uri: "viking://resources/docs", isDir: true } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/fs/mkdir")) {
        return new Response(
          JSON.stringify({ status: "ok", result: { uri: "viking://resources/docs/newdir" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/fs?")) {
        return new Response(
          JSON.stringify({ status: "ok", result: { uri: "viking://resources/docs/old", recursive: true } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/fs/mv")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              from: "viking://resources/docs/old",
              to: "viking://resources/docs/new",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/relations?")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: [{ uri: "viking://resources/docs/spec", reason: "linked" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/relations/link")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { from: "viking://resources/docs", to: "viking://resources/docs/spec" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(
      client.fsLs({
        uri: "viking://resources/docs",
        simple: true,
        recursive: true,
        output: "agent",
        absLimit: 128,
      }),
    ).resolves.toEqual(["docs/readme.md"]);
    await expect(
      client.fsTree({
        uri: "viking://resources/docs",
        output: "original",
      }),
    ).resolves.toEqual([{ name: "docs" }]);
    await expect(client.fsStat("viking://resources/docs")).resolves.toMatchObject({
      uri: "viking://resources/docs",
      isDir: true,
    });
    await expect(client.fsMkdir("viking://resources/docs/newdir")).resolves.toMatchObject({
      uri: "viking://resources/docs/newdir",
    });
    await expect(
      client.fsRm({
        uri: "viking://resources/docs/old",
        recursive: true,
      }),
    ).resolves.toMatchObject({
      uri: "viking://resources/docs/old",
    });
    await expect(
      client.fsMv({
        fromUri: "viking://resources/docs/old",
        toUri: "viking://resources/docs/new",
      }),
    ).resolves.toMatchObject({
      from: "viking://resources/docs/old",
    });
    await expect(client.relations("viking://resources/docs")).resolves.toEqual([
      { uri: "viking://resources/docs/spec", reason: "linked" },
    ]);
    await expect(
      client.linkRelation({
        fromUri: "viking://resources/docs",
        toUris: "viking://resources/docs/spec",
        reason: "link",
      }),
    ).resolves.toMatchObject({
      from: "viking://resources/docs",
    });
    await expect(
      client.unlinkRelation({
        fromUri: "viking://resources/docs",
        toUri: "viking://resources/docs/spec",
      }),
    ).resolves.toMatchObject({
      from: "viking://resources/docs",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fs/ls?"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fs/tree?"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fs/stat?uri=viking%3A%2F%2Fresources%2Fdocs"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fs/mkdir"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fs?uri=viking%3A%2F%2Fresources%2Fdocs%2Fold&recursive=true"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fs/mv"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/relations?uri=viking%3A%2F%2Fresources%2Fdocs"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/relations/link"),
      expect.any(Object),
    );
  });

  it("calls find, grep and glob search endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/search/find")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              memories: [{ uri: "viking://session/demo", score: 0.87, abstract: "memory-hit" }],
              resources: [],
              skills: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/search/grep")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              matches: [{ uri: "viking://resources/docs/readme.md", line: 2, content: "hello grep" }],
              count: 1,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/search/glob")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              matches: ["viking://resources/docs/readme.md"],
              count: 1,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(
      client.find({
        query: "deploy config path",
        targetUri: "viking://resources",
        limit: 8,
        scoreThreshold: 0.35,
      }),
    ).resolves.toMatchObject({
      memories: [{ uri: "viking://session/demo" }],
    });
    await expect(
      client.grep({
        uri: "viking://resources/docs",
        pattern: "hello",
        caseInsensitive: true,
      }),
    ).resolves.toMatchObject({
      count: 1,
    });
    await expect(
      client.glob({
        pattern: "**/*.md",
        uri: "viking://resources/docs",
      }),
    ).resolves.toMatchObject({
      count: 1,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/search/find"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/search/grep"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/search/glob"),
      expect.any(Object),
    );
  });

  it("calls pack export and import endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/pack/export")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { file: "/tmp/demo.ovpack" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/pack/import")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { uri: "viking://resources/demo" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(
      client.exportPack({
        uri: "viking://resources/demo",
        to: "/tmp/demo.ovpack",
      }),
    ).resolves.toMatchObject({
      file: "/tmp/demo.ovpack",
    });
    await expect(
      client.importPack({
        filePath: "/tmp/demo.ovpack",
        parent: "viking://resources",
        force: true,
        vectorize: false,
      }),
    ).resolves.toMatchObject({
      uri: "viking://resources/demo",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/pack/export"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/pack/import"),
      expect.any(Object),
    );
  });

  it("calls session management endpoints", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v1/sessions") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: [{ session_id: "sid-1", uri: "viking://session/sid-1", is_dir: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/sessions/sid-1") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { session_id: "sid-1", message_count: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/sessions/sid-1/extract")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: [{ uri: "viking://user/memories/pref", abstract: "pref extracted" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/sessions/sid-1/messages")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { session_id: "sid-1", message_count: 3 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/sessions/sid-1") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { session_id: "sid-1" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(client.listSessions()).resolves.toEqual([
      { session_id: "sid-1", uri: "viking://session/sid-1", is_dir: true },
    ]);
    await expect(client.getSession("sid-1")).resolves.toMatchObject({
      session_id: "sid-1",
      message_count: 2,
    });
    await expect(client.extractSession("sid-1")).resolves.toEqual([
      { uri: "viking://user/memories/pref", abstract: "pref extracted" },
    ]);
    await expect(
      client.addSessionMessage({
        sessionId: "sid-1",
        role: "user",
        content: "remember this",
      }),
    ).resolves.toMatchObject({
      session_id: "sid-1",
      message_count: 3,
    });
    await expect(client.deleteSession("sid-1")).resolves.toMatchObject({
      session_id: "sid-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/sessions"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/sessions/sid-1"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/sessions/sid-1/extract"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/sessions/sid-1/messages"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/sessions/sid-1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("calls observer endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/observer/queue")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { name: "queue", is_healthy: true, has_errors: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/observer/vikingdb")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { name: "vikingdb", is_healthy: true, has_errors: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/observer/vlm")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { name: "vlm", is_healthy: true, has_errors: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/observer/transaction")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { name: "transaction", is_healthy: true, has_errors: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/observer/system")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              is_healthy: true,
              errors: [],
              components: {
                queue: { name: "queue", is_healthy: true, has_errors: false },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenVikingClient(createConfig());

    await expect(client.observerQueue()).resolves.toMatchObject({
      name: "queue",
      is_healthy: true,
    });
    await expect(client.observerVikingdb()).resolves.toMatchObject({
      name: "vikingdb",
      is_healthy: true,
    });
    await expect(client.observerVlm()).resolves.toMatchObject({ name: "vlm", is_healthy: true });
    await expect(client.observerTransaction()).resolves.toMatchObject({
      name: "transaction",
      is_healthy: true,
    });
    await expect(client.observerSystem()).resolves.toMatchObject({
      is_healthy: true,
      components: { queue: { name: "queue" } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/observer/queue"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/observer/vikingdb"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/observer/vlm"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/observer/transaction"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/observer/system"),
      expect.any(Object),
    );
  });
});
