import { Type } from "@sinclair/typebox";
import { isRestartEnabled } from "../../config/commands.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfigSnapshotHash } from "../../config/io.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;

type ConfigWriteMethod = "config.apply" | "config.patch";

type ConfigWritePayload = {
  raw: string;
  baseHash: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
};

function jsonResultWithDetails(visible: unknown, details: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(visible, null, 2),
      },
    ],
    details,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function summarizeGatewayConfigWriteResult(result: unknown): Record<string, unknown> {
  const row = asRecord(result);
  if (!row) {
    return { ok: true };
  }
  const summary: Record<string, unknown> = {};
  if ("ok" in row) {
    summary.ok = row.ok;
  }
  if (typeof row.path === "string" && row.path.trim()) {
    summary.path = row.path.trim();
  }
  if ("restart" in row) {
    summary.restart = row.restart;
  }
  if ("sentinel" in row) {
    summary.sentinel = row.sentinel;
  }
  const config = asRecord(row.config);
  if (config) {
    const topLevelKeys = Object.keys(config);
    summary.configSummary = {
      topLevelKeys: topLevelKeys.slice(0, 20),
      topLevelKeyCount: topLevelKeys.length,
    };
    summary.configOmitted = true;
  }
  return Object.keys(summary).length > 0 ? summary : { ok: true };
}

function normalizeGatewayErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function classifyConfigWriteError(message: string): "baseHash" | "patch" | "schema" | "auth" | "other" {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("config changed since last load") ||
    normalized.includes("config base hash required") ||
    normalized.includes("config base hash unavailable")
  ) {
    return "baseHash";
  }
  if (
    normalized.includes("config.patch raw must be an object") ||
    normalized.includes("invalid config.patch params")
  ) {
    return "patch";
  }
  if (
    normalized.includes("missing scope") ||
    normalized.includes("forbidden") ||
    normalized.includes("unauthorized") ||
    normalized.includes("policy violation") ||
    normalized.includes("permission denied")
  ) {
    return "auth";
  }
  if (normalized.includes("invalid config")) {
    return "schema";
  }
  return "other";
}

function formatConfigWriteError(method: ConfigWriteMethod, error: unknown): Error {
  const message = normalizeGatewayErrorMessage(error);
  const category = classifyConfigWriteError(message);
  if (category === "baseHash") {
    return new Error(
      `${method} failed because config hash changed during write. Auto-retry already attempted once. Re-run config.get and retry. Gateway error: ${message}`,
      { cause: error },
    );
  }
  if (category === "patch") {
    return new Error(
      `${method} rejected patch payload shape. For config.patch, raw must be an object merge-patch. Gateway error: ${message}`,
      { cause: error },
    );
  }
  if (category === "schema") {
    return new Error(
      `${method} failed schema validation. Fix invalid config fields and retry. Gateway error: ${message}`,
      { cause: error },
    );
  }
  if (category === "auth") {
    return new Error(
      `${method} was rejected by gateway auth/permissions. Check gateway token and operator scopes. Gateway error: ${message}`,
      { cause: error },
    );
  }
  return new Error(`${method} failed: ${message}`, { cause: error });
}

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: typeof hashValue === "string" ? hashValue : undefined,
    raw: typeof rawValue === "string" ? rawValue : undefined,
  });
  return hash ?? undefined;
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema",
  "config.apply",
  "config.patch",
  "update.run",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: true,
    description:
      "Restart, apply config, or update the gateway in-place (SIGUSR1). Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Both trigger restart after writing. Always pass a human-readable completion message via the `note` parameter so the system can deliver it to the user after restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        // Extract channel + threadId for routing after restart
        // Supports both :thread: (most channels) and :topic: (Telegram)
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        console.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, ...resolveGatewayWriteMeta() };
      };

      const refreshBaseHash = async (): Promise<string> => {
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
        const baseHash = resolveBaseHashFromSnapshot(snapshot);
        if (!baseHash) {
          throw new Error("config base hash unavailable; re-run config.get and retry");
        }
        return baseHash;
      };

      const callConfigWriteWithRetry = async (
        method: ConfigWriteMethod,
        payload: ConfigWritePayload,
      ) => {
        try {
          return await callGatewayTool(method, gatewayOpts, payload);
        } catch (error) {
          const firstMessage = normalizeGatewayErrorMessage(error);
          if (classifyConfigWriteError(firstMessage) !== "baseHash") {
            throw formatConfigWriteError(method, error);
          }
          let nextBaseHash: string;
          try {
            nextBaseHash = await refreshBaseHash();
          } catch (refreshError) {
            throw new Error(
              `${method} failed due to stale/missing baseHash, and auto-refresh failed. Original error: ${firstMessage}. Refresh error: ${normalizeGatewayErrorMessage(refreshError)}`,
              { cause: refreshError },
            );
          }
          try {
            return await callGatewayTool(method, gatewayOpts, {
              ...payload,
              baseHash: nextBaseHash,
            });
          } catch (retryError) {
            throw formatConfigWriteError(method, retryError);
          }
        }
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema") {
        const result = await callGatewayTool("config.schema", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const { raw, baseHash, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        const result = await callConfigWriteWithRetry("config.apply", {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        const visible = { ok: true, result: summarizeGatewayConfigWriteResult(result) };
        const details = { ok: true, result };
        return jsonResultWithDetails(visible, details);
      }
      if (action === "config.patch") {
        const { raw, baseHash, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        const result = await callConfigWriteWithRetry("config.patch", {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        const visible = { ok: true, result: summarizeGatewayConfigWriteResult(result) };
        const details = { ok: true, result };
        return jsonResultWithDetails(visible, details);
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
