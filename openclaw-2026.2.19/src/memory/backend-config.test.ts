import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("resolveMemoryBackendConfig", () => {
  it("defaults to builtin backend when config missing", () => {
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("builtin");
    expect(resolved.citations).toBe("auto");
    expect(resolved.qmd).toBeUndefined();
  });

  it("resolves qmd backend with default collections", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("qmd");
    expect(resolved.qmd?.collections.length).toBeGreaterThanOrEqual(3);
    expect(resolved.qmd?.command).toBe("qmd");
    expect(resolved.qmd?.searchMode).toBe("search");
    expect(resolved.qmd?.update.intervalMs).toBeGreaterThan(0);
    expect(resolved.qmd?.update.waitForBootSync).toBe(false);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(30_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(120_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(120_000);
    const names = new Set((resolved.qmd?.collections ?? []).map((collection) => collection.name));
    expect(names.has("memory-root-main")).toBe(true);
    expect(names.has("memory-alt-main")).toBe(true);
    expect(names.has("memory-dir-main")).toBe(true);
  });

  it("parses quoted qmd command paths", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          command: '"/Applications/QMD Tools/qmd" --flag',
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.command).toBe("/Applications/QMD Tools/qmd");
  });

  it("resolves custom paths relative to workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [{ id: "main", workspace: "/workspace/root" }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          paths: [
            {
              path: "notes",
              name: "custom-notes",
              pattern: "**/*.md",
            },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const custom = resolved.qmd?.collections.find((c) => c.name.startsWith("custom-notes"));
    expect(custom).toBeDefined();
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, "main");
    expect(custom?.path).toBe(path.resolve(workspaceRoot, "notes"));
  });

  it("scopes qmd collection names per agent", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [
          { id: "main", default: true, workspace: "/workspace/root" },
          { id: "dev", workspace: "/workspace/dev" },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          paths: [{ path: "notes", name: "workspace", pattern: "**/*.md" }],
        },
      },
    } as OpenClawConfig;
    const mainResolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const devResolved = resolveMemoryBackendConfig({ cfg, agentId: "dev" });
    const mainNames = new Set(
      (mainResolved.qmd?.collections ?? []).map((collection) => collection.name),
    );
    const devNames = new Set(
      (devResolved.qmd?.collections ?? []).map((collection) => collection.name),
    );
    expect(mainNames.has("memory-dir-main")).toBe(true);
    expect(devNames.has("memory-dir-dev")).toBe(true);
    expect(mainNames.has("workspace-main")).toBe(true);
    expect(devNames.has("workspace-dev")).toBe(true);
  });

  it("resolves qmd update timeout overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          update: {
            waitForBootSync: true,
            commandTimeoutMs: 12_000,
            updateTimeoutMs: 480_000,
            embedTimeoutMs: 360_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.update.waitForBootSync).toBe(true);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(12_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(480_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(360_000);
  });

  it("resolves qmd search mode override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "vsearch",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.searchMode).toBe("vsearch");
  });

  it("resolves openviking defaults with all-scope target URI", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "openviking",
        openviking: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("openviking");
    expect(resolved.openviking?.targetUri).toBe("");
    expect(resolved.openviking?.search.targetUri).toBe("");
    expect(resolved.openviking?.search.includeResources).toBe(false);
    expect(resolved.openviking?.search.includeSkills).toBe(false);
    expect(resolved.openviking?.search.explainability).toBe(false);
    expect(resolved.openviking?.search.strategy).toBe("auto");
    expect(resolved.openviking?.search.readLayer).toBe("progressive");
    expect(resolved.openviking?.search.maxEntries).toBe(6);
    expect(resolved.openviking?.search.maxSnippetChars).toBe(560);
    expect(resolved.openviking?.search.maxInjectedChars).toBe(3_200);
    expect(resolved.openviking?.search.relationExpansion).toBe(false);
    expect(resolved.openviking?.search.relationMaxDepth).toBe(1);
    expect(resolved.openviking?.search.relationMaxAnchors).toBe(2);
    expect(resolved.openviking?.search.relationMaxExpandedEntries).toBe(4);
    expect(resolved.openviking?.search.relationSeedAnchorScore).toBe(0.55);
    expect(resolved.openviking?.search.relationPriorityBudgetBoost).toBe(true);
    expect(resolved.openviking?.search.relationPriorityDepthBonus).toBe(1);
    expect(resolved.openviking?.search.relationPriorityAnchorsBonus).toBe(1);
    expect(resolved.openviking?.search.relationPriorityExpandedBonus).toBe(2);
    expect(resolved.openviking?.fsWrite.enabled).toBe(false);
    expect(resolved.openviking?.fsWrite.allowUriPrefixes).toEqual([]);
    expect(resolved.openviking?.fsWrite.allowRecursiveRm).toBe(false);
    expect(resolved.openviking?.fsWrite.denyUriPrefixes).toEqual([
      "viking://session/",
      "viking://memories/",
      "viking://skills/",
    ]);
    expect(resolved.openviking?.fsWrite.protectedUris).toEqual([
      "viking://",
      "viking://resources",
      "viking://session",
      "viking://memories",
      "viking://skills",
    ]);
  });

  it("keeps explicit openviking target URI overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "openviking",
        openviking: {
          targetUri: "viking://user/memories",
          search: {
            targetUri: "viking://resources",
            explainability: true,
            strategy: "resource_first",
            readLayer: "l1",
            maxEntries: 4,
            maxSnippetChars: 320,
            maxInjectedChars: 900,
            relationExpansion: true,
            relationMaxDepth: 2,
            relationMaxAnchors: 3,
            relationMaxExpandedEntries: 5,
            relationSeedAnchorScore: 0.72,
            relationPriorityBudgetBoost: false,
            relationPriorityDepthBonus: 0,
            relationPriorityAnchorsBonus: 2,
            relationPriorityExpandedBonus: 4,
          },
          fsWrite: {
            enabled: true,
            allowUriPrefixes: ["viking://resources/docs", "viking://resources/tmp"],
            denyUriPrefixes: ["viking://resources/docs/sealed"],
            protectedUris: ["viking://resources/docs/protected"],
            allowRecursiveRm: true,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("openviking");
    expect(resolved.openviking?.targetUri).toBe("viking://user/memories");
    expect(resolved.openviking?.search.targetUri).toBe("viking://resources");
    expect(resolved.openviking?.search.explainability).toBe(true);
    expect(resolved.openviking?.search.strategy).toBe("resource_first");
    expect(resolved.openviking?.search.readLayer).toBe("l1");
    expect(resolved.openviking?.search.maxEntries).toBe(4);
    expect(resolved.openviking?.search.maxSnippetChars).toBe(320);
    expect(resolved.openviking?.search.maxInjectedChars).toBe(900);
    expect(resolved.openviking?.search.relationExpansion).toBe(true);
    expect(resolved.openviking?.search.relationMaxDepth).toBe(2);
    expect(resolved.openviking?.search.relationMaxAnchors).toBe(3);
    expect(resolved.openviking?.search.relationMaxExpandedEntries).toBe(5);
    expect(resolved.openviking?.search.relationSeedAnchorScore).toBe(0.72);
    expect(resolved.openviking?.search.relationPriorityBudgetBoost).toBe(false);
    expect(resolved.openviking?.search.relationPriorityDepthBonus).toBe(0);
    expect(resolved.openviking?.search.relationPriorityAnchorsBonus).toBe(2);
    expect(resolved.openviking?.search.relationPriorityExpandedBonus).toBe(4);
    expect(resolved.openviking?.fsWrite.enabled).toBe(true);
    expect(resolved.openviking?.fsWrite.allowUriPrefixes).toEqual([
      "viking://resources/docs",
      "viking://resources/tmp",
    ]);
    expect(resolved.openviking?.fsWrite.denyUriPrefixes).toEqual([
      "viking://resources/docs/sealed",
    ]);
    expect(resolved.openviking?.fsWrite.protectedUris).toEqual([
      "viking://resources/docs/protected",
    ]);
    expect(resolved.openviking?.fsWrite.allowRecursiveRm).toBe(true);
  });
});
