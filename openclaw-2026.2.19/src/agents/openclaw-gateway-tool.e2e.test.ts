import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async (method: string) => {
    if (method === "config.get") {
      return { hash: "hash-1" };
    }
    return { ok: true };
  }),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe("gateway tool", () => {
  it("marks gateway as owner-only", async () => {
    const tool = createOpenClawTools({
      config: { commands: { restart: true } },
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE"]);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_PROFILE = "isolated";

    try {
      const tool = createOpenClawTools({
        config: { commands: { restart: true } },
      }).find((candidate) => candidate.name === "gateway");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing gateway tool");
      }

      const result = await tool.execute("call1", {
        action: "restart",
        delayMs: 0,
      });
      expect(result.details).toMatchObject({
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: 0,
      });

      const sentinelPath = path.join(stateDir, "restart-sentinel.json");
      const raw = await fs.readFile(sentinelPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        payload?: { kind?: string; doctorHint?: string | null };
      };
      expect(parsed.payload?.kind).toBe("restart");
      expect(parsed.payload?.doctorHint).toBe(
        "Run: openclaw --profile isolated doctor --non-interactive",
      );

      expect(kill).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    const raw = '{\n  agents: { defaults: { workspace: "~/openclaw" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.objectContaining({
        raw: raw.trim(),
        baseHash: "hash-1",
        sessionKey: "agent:main:whatsapp:dm:+15555550123",
      }),
    );
  });

  it("passes config.patch through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.objectContaining({
        raw: raw.trim(),
        baseHash: "hash-1",
        sessionKey: "agent:main:whatsapp:dm:+15555550123",
      }),
    );
  });

  it("returns compact visible output while preserving full config details for config.apply", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.apply") {
        return {
          ok: true,
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              auth: {
                token: "super-secret-token",
              },
            },
            agents: {
              defaults: {
                workspace: "~/openclaw",
              },
            },
          },
          restart: {
            signal: "SIGUSR1",
          },
        };
      }
      return { ok: true };
    });
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    const result = await tool.execute("call-compact", {
      action: "config.apply",
      raw: "{ gateway: { bind: 'loopback' } }",
    });

    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("\"configSummary\"");
    expect(text).toContain("\"configOmitted\": true");
    expect(text).not.toContain("super-secret-token");

    const details = result.details as {
      result?: {
        config?: {
          gateway?: {
            auth?: {
              token?: string;
            };
          };
        };
      };
    };
    expect(details.result?.config?.gateway?.auth?.token).toBe("super-secret-token");
  });

  it("passes update.run through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey: "agent:main:whatsapp:dm:+15555550123",
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("retries config.patch once when baseHash is stale", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockImplementation(
      async (method: string, _opts: unknown, payload: unknown) => {
        if (method === "config.get") {
          const configGetCalls = vi
            .mocked(callGatewayTool)
            .mock.calls.filter((call) => call[0] === "config.get").length;
          return { hash: configGetCalls === 1 ? "hash-1" : "hash-2" };
        }
        if (method === "config.patch") {
          const patchCalls = vi
            .mocked(callGatewayTool)
            .mock.calls.filter((call) => call[0] === "config.patch").length;
          if (patchCalls === 1) {
            throw new Error("config changed since last load; re-run config.get and retry");
          }
          return { ok: true, payload };
        }
        return { ok: true };
      },
    );
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    await tool.execute("call-retry", {
      action: "config.patch",
      raw: '{ agents: { defaults: { workspace: "~/patched" } } }',
    });

    const patchCalls = vi
      .mocked(callGatewayTool)
      .mock.calls.filter((call) => call[0] === "config.patch");
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]?.[2]).toMatchObject({ baseHash: "hash-1" });
    expect(patchCalls[1]?.[2]).toMatchObject({ baseHash: "hash-2" });
  });

  it("classifies config.patch shape errors", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.patch") {
        throw new Error("config.patch raw must be an object");
      }
      return { ok: true };
    });
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    await expect(
      tool.execute("call-shape", {
        action: "config.patch",
        raw: "{ not-an-object }",
      }),
    ).rejects.toThrow("rejected patch payload shape");
    const patchCalls = vi
      .mocked(callGatewayTool)
      .mock.calls.filter((call) => call[0] === "config.patch");
    expect(patchCalls).toHaveLength(1);
  });

  it("classifies config.apply schema validation errors", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.apply") {
        throw new Error("invalid config");
      }
      return { ok: true };
    });
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    await expect(
      tool.execute("call-schema", {
        action: "config.apply",
        raw: "{ bad: true }",
      }),
    ).rejects.toThrow("failed schema validation");
  });

  it("classifies config.apply auth/permission errors", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.apply") {
        throw new Error("missing scope: operator.config.write");
      }
      return { ok: true };
    });
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    await expect(
      tool.execute("call-auth", {
        action: "config.apply",
        raw: "{ gateway: { bind: \"loopback\" } }",
      }),
    ).rejects.toThrow("auth/permissions");
  });
});
