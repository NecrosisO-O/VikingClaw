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
    const effectivePath = `/tmp/oc_ov_itest/ov.effective.pressure.${params.port}.conf`;
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

describe("manual openclaw x openviking pressure smoke", () => {
  it("flushes burst outbox after prolonged outage", async () => {
    const clientTimeoutMs = Number.parseInt(process.env.OPENCLAW_OV_CLIENT_TIMEOUT_MS ?? "1500", 10);
    const pressureFlushTimeoutMs = Number.parseInt(
      process.env.OPENCLAW_OV_PRESSURE_FLUSH_TIMEOUT_MS ?? "90000",
      10,
    );
    const ports = JSON.parse(await fs.readFile("/tmp/oc_ov_itest/ports.json", "utf8")) as {
      server_port: number;
    };

    const root = "/tmp/oc_ov_itest/openclaw_pressure_runtime";
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    const storePath = path.join(root, "sessions.json");
    const configPath = process.env.OPENCLAW_OV_CONFIG_PATH ?? "/tmp/oc_ov_itest/ov.conf";
    const port = Number.parseInt(process.env.OPENCLAW_OV_PORT ?? String(ports.server_port + 12), 10);
    const burstCount = 200;

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
            maxBatchSize: 20,
            retryBaseMs: 100,
            retryMaxMs: 1000,
          },
          commit: {
            mode: "async",
            triggers: {
              sessionEnd: true,
              reset: true,
              everyNMessages: 1000,
              everyNMinutes: 1000,
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

    const sessionKey = "main:pressure-smoke";
    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = {
          sessionId: "session-pressure",
          updatedAt: Date.now(),
          sessionFile: "session-pressure.jsonl",
        };
      },
      { activeSessionKey: sessionKey },
    );

    let server = await startServer({ configPath, port });
    try {
      const linked = await ensureOpenVikingSessionLink({ cfg, agentId: "main", sessionKey });
      expect(linked).toBeTruthy();

      const baselineReady = await waitFor(async () => {
        const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
        return (stats?.depth ?? 0) === 0;
      }, 10_000);
      expect(baselineReady).toBe(true);

      await stopServer(server.proc);

      for (let i = 0; i < burstCount; i += 1) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const ok = await enqueueOpenVikingMessage({
          cfg,
          agentId: "main",
          sessionKey,
          role,
          content: `pressure burst message ${i}`,
        });
        expect(ok).toBe(true);
      }
      expect(
        await enqueueOpenVikingCommit({
          cfg,
          agentId: "main",
          sessionKey,
          cause: "session_end",
          source: "pressure-smoke",
        }),
      ).toBe(true);

      const queued = await waitFor(async () => {
        const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
        return (stats?.depth ?? 0) >= burstCount;
      }, 15_000);
      expect(queued).toBe(true);

      const queuedDepth = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey })?.depth ?? 0;
      expect(queuedDepth).toBeGreaterThanOrEqual(burstCount);

      server = await startServer({ configPath, port });
      const recoverStartedAt = Date.now();
      let peakDepth = queuedDepth;

      const flushed = await waitFor(async () => {
        const stats = getOpenVikingOutboxStats({ cfg, agentId: "main", sessionKey });
        const depth = stats?.depth ?? 0;
        if (depth > peakDepth) {
          peakDepth = depth;
        }
        return depth === 0;
      }, pressureFlushTimeoutMs, 250);
      expect(flushed).toBe(true);

      const flushDurationMs = Date.now() - recoverStartedAt;
      const eventsTotal = burstCount + 1; // +1 for commit
      const throughput = Number(((eventsTotal * 1000) / Math.max(1, flushDurationMs)).toFixed(2));

      await fs.writeFile(
        "/tmp/oc_ov_itest/stage_pressure_report.json",
        JSON.stringify(
          {
            endpoint: server.endpoint,
            sessionKey,
            burstCount,
            queuedDepth,
            peakDepth,
            flushDurationMs,
            eventsTotal,
            throughputEventsPerSec: throughput,
            checks: {
              outage_enqueue_burst: "pass",
              recovery_flush_to_zero: "pass",
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
  }, 120_000);
});
