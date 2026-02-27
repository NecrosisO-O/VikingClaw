import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureOpenVikingSessionLink,
  enqueueOpenVikingCommit,
  enqueueOpenVikingMessage,
  enqueueOpenVikingToolEvent,
  getOpenVikingOutboxStats,
  resolveLinkedOpenVikingSessionId,
} from "./bridge.js";
import { getMemorySearchManager } from "../search-manager.js";
import { resolveMemoryBackendConfig } from "../backend-config.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await fn();
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe("manual openclaw x openviking runtime smoke", () => {
  it("covers T1/T2/T3/T4/T8 in a real runtime flow", async () => {
    const clientTimeoutMs = Number.parseInt(
      process.env.OPENCLAW_OV_CLIENT_TIMEOUT_MS ?? "30000",
      10,
    );
    const flushTimeoutMs = Number.parseInt(process.env.OPENCLAW_OV_FLUSH_TIMEOUT_MS ?? "40000", 10);
    const addResourceTimeoutSec = Number.parseInt(
      process.env.OPENCLAW_OV_ADD_RESOURCE_TIMEOUT_SEC ?? "25",
      10,
    );
    const searchScoreThreshold = Number.parseFloat(
      process.env.OPENCLAW_OV_SEARCH_SCORE_THRESHOLD ?? "-1",
    );

    const ports = JSON.parse(await fs.readFile("/tmp/oc_ov_itest/ports.json", "utf8")) as {
      server_port: number;
    };

    const root = "/tmp/oc_ov_itest/openclaw_runtime";
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    const storePath = path.join(root, "sessions.json");

    const cfg: any = {
      session: {
        store: storePath,
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            workspace: root,
          },
        ],
      },
      memory: {
        backend: "openviking",
        openviking: {
          endpoint: `http://127.0.0.1:${ports.server_port}`,
          dualWrite: true,
          timeoutMs: clientTimeoutMs,
          commit: {
            mode: "async",
            triggers: {
              sessionEnd: true,
              reset: true,
              everyNMessages: 2,
              everyNMinutes: 1,
            },
          },
          outbox: {
            enabled: true,
            path: path.join(root, "ov-outbox"),
            flushIntervalMs: 200,
            maxBatchSize: 10,
            retryBaseMs: 100,
            retryMaxMs: 1000,
          },
          search: {
            limit: 8,
            scoreThreshold: searchScoreThreshold,
            targetUri: "",
            includeResources: true,
            includeSkills: false,
          },
        },
      },
    };

    const sessionKey = "main:integration-smoke";

    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = {
          sessionId: "session-smoke",
          updatedAt: Date.now(),
          sessionFile: "session-smoke.jsonl",
        };
      },
      { activeSessionKey: sessionKey },
    );

    const linked = await ensureOpenVikingSessionLink({ cfg, agentId: "main", sessionKey });
    expect(linked && linked.length > 0).toBe(true);
    const linkedFromStore = loadSessionStore(storePath)[sessionKey]?.openvikingSessionId;
    expect(linkedFromStore).toBe(linked);

    expect(
      await enqueueOpenVikingMessage({
        cfg,
        agentId: "main",
        sessionKey,
        role: "user",
        content: "integration alpha question",
      }),
    ).toBe(true);
    expect(
      await enqueueOpenVikingMessage({
        cfg,
        agentId: "main",
        sessionKey,
        role: "assistant",
        content: "integration alpha answer with context",
      }),
    ).toBe(true);
    expect(
      await enqueueOpenVikingToolEvent({
        cfg,
        agentId: "main",
        sessionKey,
        toolName: "memory_search",
        result: { ok: true, note: "tool event integration" },
      }),
    ).toBe(true);
    expect(
      await enqueueOpenVikingCommit({
        cfg,
        agentId: "main",
        sessionKey,
        cause: "session_end",
        source: "smoke-test",
      }),
    ).toBe(true);

    const flushed = await waitFor(async () => {
      const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
      return (stats?.depth ?? 0) === 0;
    }, flushTimeoutMs);
    expect(flushed).toBe(true);

    const resourcePath = path.join(root, "integration-resource.md");
    await fs.writeFile(
      resourcePath,
      "# Integration Resource\n\nintegration alpha knowledge for runtime smoke validation.\n",
      "utf8",
    );
    const addResourceResp = await fetch(`http://127.0.0.1:${ports.server_port}/api/v1/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: resourcePath,
        reason: "runtime smoke",
        instruction: "index this resource",
        wait: true,
        timeout: addResourceTimeoutSec,
      }),
    });
    const addResourceJson = (await addResourceResp.json()) as {
      status?: string;
      error?: { message?: string };
    };
    expect(addResourceResp.ok).toBe(true);
    expect(addResourceJson.status).toBe("ok");

    const managerResult = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(managerResult.manager).toBeTruthy();
    const hits = await managerResult.manager!.search("integration alpha runtime smoke validation", {
      sessionKey,
      maxResults: 5,
    });
    expect(Array.isArray(hits)).toBe(true);
    const readBack = await managerResult.manager!.readFile({
      relPath: "viking://resources/integration-resource/integration-resource.md",
    });
    expect(readBack.path).toContain("viking://resources/integration-resource/integration-resource.md");
    expect(readBack.text).toContain("integration alpha knowledge");

    const builtinResolved = resolveMemoryBackendConfig({
      cfg: { ...cfg, memory: { backend: "builtin" } },
      agentId: "main",
    });
    expect(builtinResolved.backend).toBe("builtin");

    const qmdResolved = resolveMemoryBackendConfig({
      cfg: {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            command: "qmd",
          },
        },
      },
      agentId: "main",
    });
    expect(qmdResolved.backend).toBe("qmd");

    expect(resolveLinkedOpenVikingSessionId({ cfg, agentId: "main", sessionKey })).toBe(linked);

    await fs.writeFile(
      "/tmp/oc_ov_itest/stage1_report.json",
      JSON.stringify(
        {
          endpoint: `http://127.0.0.1:${ports.server_port}`,
          sessionKey,
          linkedSessionId: linked,
          searchHits: hits.length,
          topHit: hits[0],
          readBackPath: readBack.path,
          readBackPreview: readBack.text.slice(0, 160),
          outboxDepth: getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey })?.depth ?? null,
          clientTimeoutMs,
          flushTimeoutMs,
          addResourceTimeoutSec,
          searchScoreThreshold,
          checks: {
            T1_session_link: "pass",
            T2_read_path_memory_search: "pass",
            T3_dual_write: "pass",
            T4_commit_trigger_async: "pass",
            T8_backend_fallback_resolution: "pass",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }, 120_000);
});
