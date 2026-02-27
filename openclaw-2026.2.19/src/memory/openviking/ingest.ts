import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "../backend-config.js";
import { OpenVikingClient } from "./client.js";

const log = createSubsystemLogger("memory/openviking/ingest");

type OpenVikingIngestKind = "resource" | "skill";

export type OpenVikingIngestReceipt = {
  kind: OpenVikingIngestKind;
  endpoint: string;
  attempts: number;
  waited: boolean;
  payload: Record<string, unknown>;
  waitStatus?: Record<string, unknown>;
};

export type OpenVikingResourceIngestParams = {
  cfg: OpenClawConfig;
  agentId: string;
  path: string;
  target?: string;
  reason?: string;
  instruction?: string;
  wait?: boolean;
  timeoutSec?: number;
  retries?: number;
  retryBaseMs?: number;
};

export type OpenVikingSkillIngestParams = {
  cfg: OpenClawConfig;
  agentId: string;
  data: unknown;
  wait?: boolean;
  timeoutSec?: number;
  retries?: number;
  retryBaseMs?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function resolveOpenVikingClient(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): OpenVikingClient {
  const resolved = resolveMemoryBackendConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (resolved.backend !== "openviking" || !resolved.openviking) {
    throw new Error(`memory backend is ${resolved.backend}; openviking backend required for ingest`);
  }
  return new OpenVikingClient(resolved.openviking);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAdditionalRetries(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveRetryBaseMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 10) {
    return 300;
  }
  return Math.floor(raw);
}

function isRetriableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /request failed \(5\d\d\)/i.test(message)
    || /ECONNREFUSED/i.test(message)
    || /ETIMEDOUT/i.test(message)
    || /timed out/i.test(message)
    || /fetch failed/i.test(message)
    || /network/i.test(message)
    || /abort/i.test(message)
  );
}

async function withRetry<T>(params: {
  label: string;
  retries?: number;
  retryBaseMs?: number;
  op: () => Promise<T>;
}): Promise<{ value: T; attempts: number }> {
  const extraRetries = resolveAdditionalRetries(params.retries);
  const maxAttempts = 1 + extraRetries;
  const retryBaseMs = resolveRetryBaseMs(params.retryBaseMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await params.op();
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetriableError(error);
      if (!canRetry) {
        throw error;
      }
      const delayMs = Math.min(retryBaseMs * 2 ** (attempt - 1), 4_000);
      log.warn(
        `${params.label} failed (attempt ${attempt}/${maxAttempts}): ${error instanceof Error ? error.message : String(error)}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ingestOpenVikingResource(
  params: OpenVikingResourceIngestParams,
): Promise<OpenVikingIngestReceipt> {
  const client = resolveOpenVikingClient(params);
  const wait = params.wait !== false;
  const { value: payloadRaw, attempts } = await withRetry({
    label: "openviking add_resource",
    retries: params.retries,
    retryBaseMs: params.retryBaseMs,
    op: async () =>
      await client.addResource({
        path: params.path,
        target: params.target,
        reason: params.reason ?? "",
        instruction: params.instruction ?? "",
        wait,
        timeout: params.timeoutSec,
      }),
  });
  const payload = asRecord(payloadRaw);
  let waitStatus: Record<string, unknown> | undefined;
  if (wait) {
    const queueStatus = asRecord(payload.queue_status);
    if (Object.keys(queueStatus).length > 0) {
      waitStatus = queueStatus;
    } else {
      const waited = await withRetry({
        label: "openviking wait_processed",
        retries: params.retries,
        retryBaseMs: params.retryBaseMs,
        op: async () =>
          await client.waitProcessed({
            timeout: params.timeoutSec,
          }),
      });
      waitStatus = asRecord(waited.value);
    }
  }

  return {
    kind: "resource",
    endpoint: client.endpoint,
    attempts,
    waited: wait,
    payload,
    waitStatus,
  };
}

export async function ingestOpenVikingSkill(
  params: OpenVikingSkillIngestParams,
): Promise<OpenVikingIngestReceipt> {
  const client = resolveOpenVikingClient(params);
  const wait = params.wait !== false;
  const { value: payloadRaw, attempts } = await withRetry({
    label: "openviking add_skill",
    retries: params.retries,
    retryBaseMs: params.retryBaseMs,
    op: async () =>
      await client.addSkill({
        data: params.data,
        wait,
        timeout: params.timeoutSec,
      }),
  });
  const payload = asRecord(payloadRaw);
  let waitStatus: Record<string, unknown> | undefined;
  if (wait) {
    const queueStatus = asRecord(payload.queue_status);
    if (Object.keys(queueStatus).length > 0) {
      waitStatus = queueStatus;
    } else {
      const waited = await withRetry({
        label: "openviking wait_processed",
        retries: params.retries,
        retryBaseMs: params.retryBaseMs,
        op: async () =>
          await client.waitProcessed({
            timeout: params.timeoutSec,
          }),
      });
      waitStatus = asRecord(waited.value);
    }
  }

  return {
    kind: "skill",
    endpoint: client.endpoint,
    attempts,
    waited: wait,
    payload,
    waitStatus,
  };
}
