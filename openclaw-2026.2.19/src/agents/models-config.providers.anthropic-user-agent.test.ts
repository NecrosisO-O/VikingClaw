import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProviders } from "./models-config.providers.js";

function makeAnthropicProvider(baseUrl: string, headers?: Record<string, string>) {
  return {
    baseUrl,
    api: "anthropic-messages" as const,
    models: [
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
    ...(headers ? { headers } : {}),
  };
}

describe("normalizeProviders anthropic proxy User-Agent", () => {
  it("adds default User-Agent for anthropic provider on non-official base URLs", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      anthropic: makeAnthropicProvider("https://tiger.bookapi.cc"),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.anthropic?.headers?.["User-Agent"]).toBe("openclaw/bridge");
  });

  it("keeps explicit user-agent header when already configured", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      anthropic: makeAnthropicProvider("https://tiger.bookapi.cc", {
        "user-agent": "custom-client/1.0",
      }),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.anthropic?.headers?.["user-agent"]).toBe("custom-client/1.0");
    expect(normalized?.anthropic?.headers?.["User-Agent"]).toBeUndefined();
  });

  it("does not inject User-Agent for official Anthropic API host", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      anthropic: makeAnthropicProvider("https://api.anthropic.com"),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.anthropic?.headers).toBeUndefined();
  });
});
