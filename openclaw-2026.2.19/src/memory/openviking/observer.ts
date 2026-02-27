import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "../backend-config.js";
import {
  OpenVikingClient,
  type OpenVikingObserverComponentStatus,
  type OpenVikingObserverSystemStatus,
} from "./client.js";

const log = createSubsystemLogger("memory/openviking/observer");
const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

type ObserverRiskSeverity = "warn" | "critical";

export type OpenVikingObserverAlert = {
  code: string;
  severity: ObserverRiskSeverity;
  message: string;
};

export type OpenVikingObserverSnapshot = {
  available: boolean;
  fetchedAt: number;
  endpoint: string;
  timeoutMs: number;
  system?: OpenVikingObserverSystemStatus;
  queue?: OpenVikingObserverComponentStatus;
  vikingdb?: OpenVikingObserverComponentStatus;
  vlm?: OpenVikingObserverComponentStatus;
  transaction?: OpenVikingObserverComponentStatus;
  componentsHealthy: number;
  componentsTotal: number;
  degradedComponents: string[];
  alerts: OpenVikingObserverAlert[];
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asComponentStatus(value: unknown, fallbackName: string): OpenVikingObserverComponentStatus {
  const row = asRecord(value);
  if (!row) {
    return { name: fallbackName, status: "unknown", is_healthy: false };
  }
  return {
    name:
      typeof row.name === "string" && row.name.trim().length > 0
        ? row.name.trim()
        : fallbackName,
    is_healthy: row.is_healthy === true,
    has_errors: row.has_errors === true,
    status: typeof row.status === "string" ? row.status : undefined,
  };
}

function asSystemStatus(value: unknown): OpenVikingObserverSystemStatus | undefined {
  const row = asRecord(value);
  if (!row) {
    return undefined;
  }
  const errors = Array.isArray(row.errors)
    ? row.errors.filter((item): item is string => typeof item === "string")
    : undefined;
  const componentsRow = asRecord(row.components);
  const components = componentsRow
    ? Object.fromEntries(
        Object.entries(componentsRow).map(([key, component]) => [key, asComponentStatus(component, key)]),
      )
    : undefined;
  return {
    is_healthy: row.is_healthy === true,
    errors,
    components,
  };
}

function isHealthy(component: OpenVikingObserverComponentStatus | undefined): boolean {
  if (!component) {
    return false;
  }
  return component.is_healthy === true && component.has_errors !== true;
}

function resolveTimeoutMs(input: number | undefined, fallback: number): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  return fallback;
}

export async function fetchOpenVikingObserverSnapshot(params: {
  cfg: OpenClawConfig;
  agentId: string;
  outboxDepth?: number;
  timeoutMs?: number;
}): Promise<OpenVikingObserverSnapshot> {
  const resolved = resolveMemoryBackendConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (resolved.backend !== "openviking" || !resolved.openviking) {
    throw new Error(`memory backend is ${resolved.backend}; openviking backend required`);
  }

  const timeoutMs = Math.min(
    resolveTimeoutMs(params.timeoutMs, DEFAULT_STATUS_TIMEOUT_MS),
    resolved.openviking.timeoutMs,
  );
  const client = new OpenVikingClient({
    ...resolved.openviking,
    timeoutMs,
  });

  const [
    systemResult,
    queueResult,
    vikingdbResult,
    vlmResult,
    transactionResult,
  ] = await Promise.allSettled([
    client.observerSystem(),
    client.observerQueue(),
    client.observerVikingdb(),
    client.observerVlm(),
    client.observerTransaction(),
  ]);

  const extractError = (result: PromiseSettledResult<unknown>): string | undefined => {
    if (result.status === "fulfilled") {
      return undefined;
    }
    return result.reason instanceof Error ? result.reason.message : String(result.reason);
  };

  const errors = [systemResult, queueResult, vikingdbResult, vlmResult, transactionResult]
    .map((result) => extractError(result))
    .filter((item): item is string => Boolean(item));
  const system = systemResult.status === "fulfilled" ? asSystemStatus(systemResult.value) : undefined;
  const queue = queueResult.status === "fulfilled" ? asComponentStatus(queueResult.value, "queue") : undefined;
  const vikingdb =
    vikingdbResult.status === "fulfilled"
      ? asComponentStatus(vikingdbResult.value, "vikingdb")
      : undefined;
  const vlm = vlmResult.status === "fulfilled" ? asComponentStatus(vlmResult.value, "vlm") : undefined;
  const transaction =
    transactionResult.status === "fulfilled"
      ? asComponentStatus(transactionResult.value, "transaction")
      : undefined;

  const components = [
    { key: "queue", value: queue },
    { key: "vikingdb", value: vikingdb },
    { key: "vlm", value: vlm },
    { key: "transaction", value: transaction },
  ];
  const componentsTotal = components.length;
  const componentsHealthy = components.filter((component) => isHealthy(component.value)).length;
  const degradedComponents = components
    .filter((component) => !isHealthy(component.value))
    .map((component) => component.key);
  const outboxDepth =
    typeof params.outboxDepth === "number" && Number.isFinite(params.outboxDepth) && params.outboxDepth > 0
      ? Math.floor(params.outboxDepth)
      : 0;
  const alerts: OpenVikingObserverAlert[] = [];
  if (system && system.is_healthy === false) {
    alerts.push({
      code: "observer_system_unhealthy",
      severity: "critical",
      message: "OpenViking observer system reported unhealthy state.",
    });
  }
  if (degradedComponents.length > 0) {
    alerts.push({
      code: "observer_component_degraded",
      severity: "warn",
      message: `OpenViking components degraded: ${degradedComponents.join(", ")}`,
    });
  }
  if (outboxDepth >= 100) {
    alerts.push({
      code: "openviking_outbox_high_depth",
      severity: "warn",
      message: `OpenViking outbox depth is high (${outboxDepth}).`,
    });
  }
  if (outboxDepth > 0 && !isHealthy(queue)) {
    alerts.push({
      code: "openviking_outbox_queue_risk",
      severity: "warn",
      message: `OpenViking outbox depth=${outboxDepth} while observer queue is degraded.`,
    });
  }

  if (errors.length > 0) {
    log.warn(`[observer] partial failure: ${errors.join(" | ")}`);
  }

  return {
    available: errors.length < componentsTotal + 1,
    fetchedAt: Date.now(),
    endpoint: client.endpoint,
    timeoutMs,
    system,
    queue,
    vikingdb,
    vlm,
    transaction,
    componentsHealthy,
    componentsTotal,
    degradedComponents,
    alerts,
    error: errors.length > 0 ? errors[0] : undefined,
  };
}
