import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ensureOpenVikingSessionLink,
  enqueueOpenVikingCommit,
  enqueueOpenVikingMessage,
  getOpenVikingOutboxStats,
} from "./bridge.js";
import { updateSessionStore } from "../../config/sessions.js";

type RunningServer = {
  proc: ChildProcessWithoutNullStreams;
  endpoint: string;
};

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await fn();
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function waitForHealth(endpoint: string, timeoutMs = 10_000): Promise<boolean> {
  return await waitFor(async () => {
    try {
      const resp = await fetch(`${endpoint}/health`);
      return resp.ok;
    } catch {
      return false;
    }
  }, timeoutMs, 200);
}

async function materializeServerConfig(params: { configPath: string; port: number }): Promise<string> {
  try {
    const raw = await fs.readFile(params.configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, any>;
    const storage = (parsed.storage ??= {});
    const dataPath = `/tmp/oc_ov_itest/data-port-${params.port}`;

    if (typeof storage.vectordb === "object" && storage.vectordb) {
      storage.vectordb.path = dataPath;
    }
    if (typeof storage.agfs === "object" && storage.agfs) {
      storage.agfs.path = dataPath;
      storage.agfs.port = params.port + 1000;
    }

    await fs.mkdir(dataPath, { recursive: true });
    const effectivePath = `/tmp/oc_ov_itest/ov.effective.recovery.${params.port}.conf`;
    await fs.writeFile(effectivePath, JSON.stringify(parsed, null, 2), "utf8");
    return effectivePath;
  } catch {
    return params.configPath;
  }
}

function resolveOpenVikingPaths() {
  const openVikingDir =
    process.env.OPENCLAW_OV_ROOT_DIR?.trim() || path.resolve(process.cwd(), "../OpenViking-0.1.17");
  const defaultPythonBin = path.join(openVikingDir, ".venv", "bin", "python");
  const serverCwd = process.env.OPENCLAW_OV_SERVER_CWD?.trim() || openVikingDir;
  return { defaultPythonBin, serverCwd };
}

async function startServer(params: { configPath: string; port: number }): Promise<RunningServer> {
  const paths = resolveOpenVikingPaths();
  const pythonBin = process.env.OPENCLAW_OV_PYTHON_BIN ?? paths.defaultPythonBin;
  const serverScript = process.env.OPENCLAW_OV_SERVER_SCRIPT ?? "/tmp/oc_ov_itest/run_mock_server.py";
  const stdioMode = process.env.OPENCLAW_OV_SERVER_STDIO === "inherit" ? "inherit" : "pipe";
  const effectiveConfigPath = await materializeServerConfig(params);
  const proc = spawn(
    pythonBin,
    [
      serverScript,
      "--config",
      effectiveConfigPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(params.port),
      "--log-level",
      "warning",
    ],
    {
      cwd: paths.serverCwd,
      stdio: stdioMode,
    },
  );

  const endpoint = `http://127.0.0.1:${params.port}`;
  const healthy = await waitForHealth(endpoint, 15_000);
  if (!healthy) {
    try {
      proc.kill("SIGINT");
    } catch {
      // ignore
    }
    throw new Error(`mock openviking server failed to start at ${endpoint}`);
  }
  return { proc, endpoint };
}

async function stopServer(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.killed) {
    return;
  }
  proc.kill("SIGINT");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 5000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

describe("manual openclaw x openviking recovery smoke", () => {
  it("keeps queueing during outage and flushes after recovery", async () => {
    const clientTimeoutMs = Number.parseInt(process.env.OPENCLAW_OV_CLIENT_TIMEOUT_MS ?? "1500", 10);
    const baselineFlushTimeoutMs = Number.parseInt(
      process.env.OPENCLAW_OV_BASELINE_FLUSH_TIMEOUT_MS ?? "10000",
      10,
    );
    const recoveryFlushTimeoutMs = Number.parseInt(
      process.env.OPENCLAW_OV_RECOVERY_FLUSH_TIMEOUT_MS ?? "20000",
      10,
    );
    const ports = JSON.parse(await fs.readFile("/tmp/oc_ov_itest/ports.json", "utf8")) as {
      server_port: number;
    };

    const root = "/tmp/oc_ov_itest/openclaw_recovery_runtime";
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    const storePath = path.join(root, "sessions.json");
    const configPath = process.env.OPENCLAW_OV_CONFIG_PATH ?? "/tmp/oc_ov_itest/ov.conf";
    const port = Number.parseInt(process.env.OPENCLAW_OV_PORT ?? String(ports.server_port + 11), 10);

    const cfg: any = {
      session: { store: storePath },
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
          endpoint: `http://127.0.0.1:${port}`,
          dualWrite: true,
          timeoutMs: clientTimeoutMs,
          outbox: {
            enabled: true,
            path: path.join(root, "ov-outbox"),
            flushIntervalMs: 200,
            maxBatchSize: 10,
            retryBaseMs: 100,
            retryMaxMs: 1000,
          },
          commit: {
            mode: "async",
            triggers: {
              sessionEnd: true,
              reset: true,
              everyNMessages: 100,
              everyNMinutes: 100,
            },
          },
          search: {
            limit: 5,
            scoreThreshold: 0,
            targetUri: "",
            includeResources: true,
            includeSkills: false,
          },
        },
      },
    };

    const sessionKey = "main:recovery-smoke";
    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = {
          sessionId: "session-recovery",
          updatedAt: Date.now(),
          sessionFile: "session-recovery.jsonl",
        };
      },
      { activeSessionKey: sessionKey },
    );

    let server = await startServer({ configPath, port });
    try {
      const linked = await ensureOpenVikingSessionLink({ cfg, agentId: "main", sessionKey });
      expect(linked).toBeTruthy();

      expect(
        await enqueueOpenVikingMessage({
          cfg,
          agentId: "main",
          sessionKey,
          role: "user",
          content: "recovery baseline message",
        }),
      ).toBe(true);

      const baselineFlushed = await waitFor(async () => {
        const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
        return (stats?.depth ?? 0) === 0;
      }, baselineFlushTimeoutMs);
      expect(baselineFlushed).toBe(true);

      await stopServer(server.proc);

      expect(
        await enqueueOpenVikingMessage({
          cfg,
          agentId: "main",
          sessionKey,
          role: "user",
          content: "offline queued message 1",
        }),
      ).toBe(true);
      expect(
        await enqueueOpenVikingMessage({
          cfg,
          agentId: "main",
          sessionKey,
          role: "assistant",
          content: "offline queued message 2",
        }),
      ).toBe(true);
      expect(
        await enqueueOpenVikingCommit({
          cfg,
          agentId: "main",
          sessionKey,
          cause: "session_end",
          source: "recovery-smoke",
        }),
      ).toBe(true);

      const queued = await waitFor(async () => {
        const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
        return (stats?.depth ?? 0) >= 3;
      }, 5_000);
      expect(queued).toBe(true);

      server = await startServer({ configPath, port });

      const recovered = await waitFor(async () => {
        const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
        return (stats?.depth ?? 0) === 0;
      }, recoveryFlushTimeoutMs);
      expect(recovered).toBe(true);

      await fs.writeFile(
        "/tmp/oc_ov_itest/stage2_report.json",
        JSON.stringify(
          {
            endpoint: server.endpoint,
            sessionKey,
            checks: {
              T6_outage_non_blocking_enqueue: "pass",
              T6_recovery_outbox_flush: "pass",
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    } finally {
      await stopServer(server.proc).catch(() => undefined);
    }
  }, Number.parseInt(process.env.OPENCLAW_OV_RECOVERY_TEST_TIMEOUT_MS ?? "150000", 10));
});
