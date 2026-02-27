import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import {
  enqueueOpenVikingMessage,
  enqueueOpenVikingToolEvent,
} from "../memory/openviking/bridge.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
};

function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text);
      }
    }
  }
  return texts.join("\n\n");
}

function toOpenVikingMessage(message: AgentMessage): { role: "user" | "assistant"; text: string } | null {
  const role = (message as { role?: string }).role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    return null;
  }
  const text = extractTextBlocks((message as { content?: unknown }).content);
  if (!text.trim()) {
    return null;
  }
  return {
    role: role === "user" ? "user" : "assistant",
    text,
  };
}

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const shouldQueueOpenViking = Boolean(opts?.sessionKey);
  const hasBeforeWriteHook = hookRunner?.hasHooks("before_message_write") === true;
  const beforeMessageWrite =
    shouldQueueOpenViking || hasBeforeWriteHook
      ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
        const payload = toOpenVikingMessage(event.message);
        if (payload && opts?.sessionKey) {
          void enqueueOpenVikingMessage({
            agentId: opts.agentId,
            sessionKey: opts.sessionKey,
            role: payload.role,
            content: payload.text,
            eventType: "before_message_write",
          }).catch(() => {});
        }
        if (!hasBeforeWriteHook) {
          return undefined;
        }
        return hookRunner?.runBeforeMessageWrite(event, {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
        });
      }
      : undefined;

  const hasToolPersistHook = hookRunner?.hasHooks("tool_result_persist") === true;
  const transform =
    shouldQueueOpenViking || hasToolPersistHook
      ? // oxlint-disable-next-line typescript/no-explicit-any
        (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
        if (opts?.sessionKey) {
          void enqueueOpenVikingToolEvent({
            agentId: opts.agentId,
            sessionKey: opts.sessionKey,
            toolName: meta.toolName ?? "unknown",
            toolCallId: meta.toolCallId,
            result: message,
            isError: false,
          }).catch(() => {});
        }
        if (!hasToolPersistHook) {
          return message;
        }
        const out = hookRunner?.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
      : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    beforeMessageWriteHook: beforeMessageWrite,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
