import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionSendPolicyConfig } from "../config/types.base.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
  OpenVikingCommitMode,
  OpenVikingSearchReadLayer,
  OpenVikingSearchStrategy,
  OpenVikingMemoryConfig,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdSearchMode,
} from "../config/types.memory.js";
import { resolveUserPath } from "../utils.js";
import { splitShellArgs } from "../utils/shell-argv.js";

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  qmd?: ResolvedQmdConfig;
  openviking?: ResolvedOpenVikingConfig;
};

export type ResolvedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ResolvedQmdUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  waitForBootSync: boolean;
  embedIntervalMs: number;
  commandTimeoutMs: number;
  updateTimeoutMs: number;
  embedTimeoutMs: number;
};

export type ResolvedQmdLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};

export type ResolvedQmdSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type ResolvedQmdConfig = {
  command: string;
  searchMode: MemoryQmdSearchMode;
  collections: ResolvedQmdCollection[];
  sessions: ResolvedQmdSessionConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: SessionSendPolicyConfig;
};

export type ResolvedOpenVikingCommitTriggers = {
  sessionEnd: boolean;
  reset: boolean;
  everyNMessages: number;
  everyNMinutes: number;
};

export type ResolvedOpenVikingCommitConfig = {
  mode: OpenVikingCommitMode;
  triggers: ResolvedOpenVikingCommitTriggers;
};

export type ResolvedOpenVikingOutboxConfig = {
  enabled: boolean;
  path?: string;
  flushIntervalMs: number;
  maxBatchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

export type ResolvedOpenVikingFsWriteConfig = {
  enabled: boolean;
  allowUriPrefixes: string[];
  denyUriPrefixes: string[];
  protectedUris: string[];
  allowRecursiveRm: boolean;
};

export type ResolvedOpenVikingSearchConfig = {
  limit: number;
  scoreThreshold?: number;
  targetUri: string;
  includeResources: boolean;
  includeSkills: boolean;
  explainability: boolean;
  strategy: OpenVikingSearchStrategy;
  readLayer: OpenVikingSearchReadLayer;
  maxEntries: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  relationExpansion: boolean;
  relationMaxDepth: number;
  relationMaxAnchors: number;
  relationMaxExpandedEntries: number;
  relationSeedAnchorScore: number;
  relationPriorityBudgetBoost: boolean;
  relationPriorityDepthBonus: number;
  relationPriorityAnchorsBonus: number;
  relationPriorityExpandedBonus: number;
};

export type ResolvedOpenVikingConfig = {
  endpoint: string;
  apiKey?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  targetUri: string;
  dualWrite: boolean;
  commit: ResolvedOpenVikingCommitConfig;
  outbox: ResolvedOpenVikingOutboxConfig;
  fsWrite?: ResolvedOpenVikingFsWriteConfig;
  search: ResolvedOpenVikingSearchConfig;
};

const DEFAULT_BACKEND: MemoryBackend = "builtin";
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";
const DEFAULT_QMD_INTERVAL = "5m";
const DEFAULT_QMD_DEBOUNCE_MS = 15_000;
const DEFAULT_QMD_TIMEOUT_MS = 4_000;
// Defaulting to `query` can be extremely slow on CPU-only systems (query expansion + rerank).
// Prefer a faster mode for interactive use; users can opt into `query` for best recall.
const DEFAULT_QMD_SEARCH_MODE: MemoryQmdSearchMode = "search";
const DEFAULT_QMD_EMBED_INTERVAL = "60m";
const DEFAULT_QMD_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_QMD_UPDATE_TIMEOUT_MS = 120_000;
const DEFAULT_QMD_EMBED_TIMEOUT_MS = 120_000;
const DEFAULT_OPENVIKING_ENDPOINT = "http://127.0.0.1:9432";
const DEFAULT_OPENVIKING_TIMEOUT_MS = 10_000;
// Keep target_uri empty by default so OpenViking can retrieve memory/resource/skill contexts.
const DEFAULT_OPENVIKING_TARGET_URI = "";
const DEFAULT_OPENVIKING_SEARCH_LIMIT = 10;
const DEFAULT_OPENVIKING_SEARCH_STRATEGY: OpenVikingSearchStrategy = "auto";
const DEFAULT_OPENVIKING_SEARCH_READ_LAYER: OpenVikingSearchReadLayer = "progressive";
const DEFAULT_OPENVIKING_SEARCH_MAX_ENTRIES = 6;
const DEFAULT_OPENVIKING_SEARCH_MAX_SNIPPET_CHARS = 560;
const DEFAULT_OPENVIKING_SEARCH_MAX_INJECTED_CHARS = 3_200;
const DEFAULT_OPENVIKING_RELATION_EXPANSION = false;
const DEFAULT_OPENVIKING_RELATION_MAX_DEPTH = 1;
const DEFAULT_OPENVIKING_RELATION_MAX_ANCHORS = 2;
const DEFAULT_OPENVIKING_RELATION_MAX_EXPANDED_ENTRIES = 4;
const DEFAULT_OPENVIKING_RELATION_SEED_ANCHOR_SCORE = 0.55;
const DEFAULT_OPENVIKING_RELATION_PRIORITY_BUDGET_BOOST = true;
const DEFAULT_OPENVIKING_RELATION_PRIORITY_DEPTH_BONUS = 1;
const DEFAULT_OPENVIKING_RELATION_PRIORITY_ANCHORS_BONUS = 1;
const DEFAULT_OPENVIKING_RELATION_PRIORITY_EXPANDED_BONUS = 2;
const DEFAULT_OPENVIKING_OUTBOX_FLUSH_MS = 2_000;
const DEFAULT_OPENVIKING_OUTBOX_BATCH_SIZE = 25;
const DEFAULT_OPENVIKING_RETRY_BASE_MS = 1_000;
const DEFAULT_OPENVIKING_RETRY_MAX_MS = 60_000;
const DEFAULT_OPENVIKING_COMMIT_EVERY_N_MESSAGES = 24;
const DEFAULT_OPENVIKING_COMMIT_EVERY_N_MINUTES = 12;
const DEFAULT_OPENVIKING_FSWRITE_ENABLED = false;
const DEFAULT_OPENVIKING_FSWRITE_ALLOW_RECURSIVE_RM = false;
const DEFAULT_OPENVIKING_FSWRITE_DENY_URI_PREFIXES = [
  "viking://session/",
  "viking://memories/",
  "viking://skills/",
];
const DEFAULT_OPENVIKING_FSWRITE_PROTECTED_URIS = [
  "viking://",
  "viking://resources",
  "viking://session",
  "viking://memories",
  "viking://skills",
];
const DEFAULT_QMD_LIMITS: ResolvedQmdLimitsConfig = {
  maxResults: 6,
  maxSnippetChars: 700,
  maxInjectedChars: 4_000,
  timeoutMs: DEFAULT_QMD_TIMEOUT_MS,
};
const DEFAULT_QMD_SCOPE: SessionSendPolicyConfig = {
  default: "deny",
  rules: [
    {
      action: "allow",
      match: { chatType: "direct" },
    },
  ],
};

function sanitizeName(input: string): string {
  const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "collection";
}

function scopeCollectionBase(base: string, agentId: string): string {
  return `${base}-${sanitizeName(agentId)}`;
}

function ensureUniqueName(base: string, existing: Set<string>): string {
  let name = sanitizeName(base);
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  let suffix = 2;
  while (existing.has(`${name}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${name}-${suffix}`;
  existing.add(unique);
  return unique;
}

function resolvePath(raw: string, workspaceDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("path required");
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

function resolveIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveEmbedIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveDebounceMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_QMD_DEBOUNCE_MS;
}

function resolveTimeoutMs(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolveOpenVikingSearchStrategy(raw: string | undefined): OpenVikingSearchStrategy {
  if (
    raw === "auto" ||
    raw === "memory_first" ||
    raw === "resource_first" ||
    raw === "skill_first"
  ) {
    return raw;
  }
  return DEFAULT_OPENVIKING_SEARCH_STRATEGY;
}

function resolveOpenVikingSearchReadLayer(raw: string | undefined): OpenVikingSearchReadLayer {
  if (raw === "l0" || raw === "l1" || raw === "l2" || raw === "progressive") {
    return raw;
  }
  return DEFAULT_OPENVIKING_SEARCH_READ_LAYER;
}

function resolvePositiveInt(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolveNonNegativeInt(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolvePositiveFloat(raw: number | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return undefined;
}

function resolveNonNegativeFloat(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return fallback;
}

function normalizeUriRuleList(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    out.push(normalized);
  }
  return [...new Set(out)];
}

function resolveLimits(raw?: MemoryQmdConfig["limits"]): ResolvedQmdLimitsConfig {
  const parsed: ResolvedQmdLimitsConfig = { ...DEFAULT_QMD_LIMITS };
  if (raw?.maxResults && raw.maxResults > 0) {
    parsed.maxResults = Math.floor(raw.maxResults);
  }
  if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) {
    parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
  }
  if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) {
    parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
  }
  if (raw?.timeoutMs && raw.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(raw.timeoutMs);
  }
  return parsed;
}

function resolveSearchMode(raw?: MemoryQmdConfig["searchMode"]): MemoryQmdSearchMode {
  if (raw === "search" || raw === "vsearch" || raw === "query") {
    return raw;
  }
  return DEFAULT_QMD_SEARCH_MODE;
}

function resolveSessionConfig(
  cfg: MemoryQmdConfig["sessions"],
  workspaceDir: string,
): ResolvedQmdSessionConfig {
  const enabled = Boolean(cfg?.enabled);
  const exportDirRaw = cfg?.exportDir?.trim();
  const exportDir = exportDirRaw ? resolvePath(exportDirRaw, workspaceDir) : undefined;
  const retentionDays =
    cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : undefined;
  return {
    enabled,
    exportDir,
    retentionDays,
  };
}

function resolveCustomPaths(
  rawPaths: MemoryQmdIndexPath[] | undefined,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedQmdCollection[] {
  if (!rawPaths?.length) {
    return [];
  }
  const collections: ResolvedQmdCollection[] = [];
  rawPaths.forEach((entry, index) => {
    const trimmedPath = entry?.path?.trim();
    if (!trimmedPath) {
      return;
    }
    let resolved: string;
    try {
      resolved = resolvePath(trimmedPath, workspaceDir);
    } catch {
      return;
    }
    const pattern = entry.pattern?.trim() || "**/*.md";
    const baseName = scopeCollectionBase(entry.name?.trim() || `custom-${index + 1}`, agentId);
    const name = ensureUniqueName(baseName, existing);
    collections.push({
      name,
      path: resolved,
      pattern,
      kind: "custom",
    });
  });
  return collections;
}

function resolveDefaultCollections(
  include: boolean,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedQmdCollection[] {
  if (!include) {
    return [];
  }
  const entries: Array<{ path: string; pattern: string; base: string }> = [
    { path: workspaceDir, pattern: "MEMORY.md", base: "memory-root" },
    { path: workspaceDir, pattern: "memory.md", base: "memory-alt" },
    { path: path.join(workspaceDir, "memory"), pattern: "**/*.md", base: "memory-dir" },
  ];
  return entries.map((entry) => ({
    name: ensureUniqueName(scopeCollectionBase(entry.base, agentId), existing),
    path: entry.path,
    pattern: entry.pattern,
    kind: "memory",
  }));
}

function resolveOpenVikingConfig(
  raw: OpenVikingMemoryConfig | undefined,
  workspaceDir: string,
): ResolvedOpenVikingConfig {
  const endpoint = (raw?.endpoint?.trim() || DEFAULT_OPENVIKING_ENDPOINT).replace(/\/+$/, "");
  const apiKey = raw?.apiKey?.trim() || undefined;
  const headers = raw?.headers ? { ...raw.headers } : {};
  const timeoutMs = resolveTimeoutMs(raw?.timeoutMs, DEFAULT_OPENVIKING_TIMEOUT_MS);
  const targetUri = raw?.targetUri?.trim() || DEFAULT_OPENVIKING_TARGET_URI;
  const dualWrite = raw?.dualWrite !== false;

  const commitMode: OpenVikingCommitMode = raw?.commit?.mode === "sync" ? "sync" : "async";
  const commitTriggers: ResolvedOpenVikingCommitTriggers = {
    sessionEnd: raw?.commit?.triggers?.sessionEnd !== false,
    reset: raw?.commit?.triggers?.reset !== false,
    everyNMessages: resolvePositiveInt(
      raw?.commit?.triggers?.everyNMessages,
      DEFAULT_OPENVIKING_COMMIT_EVERY_N_MESSAGES,
    ),
    everyNMinutes: resolvePositiveInt(
      raw?.commit?.triggers?.everyNMinutes,
      DEFAULT_OPENVIKING_COMMIT_EVERY_N_MINUTES,
    ),
  };

  const outboxPathRaw = raw?.outbox?.path?.trim();
  const outboxPath = outboxPathRaw ? resolvePath(outboxPathRaw, workspaceDir) : undefined;
  const outbox: ResolvedOpenVikingOutboxConfig = {
    enabled: raw?.outbox?.enabled !== false,
    path: outboxPath,
    flushIntervalMs: resolvePositiveInt(
      raw?.outbox?.flushIntervalMs,
      DEFAULT_OPENVIKING_OUTBOX_FLUSH_MS,
    ),
    maxBatchSize: resolvePositiveInt(
      raw?.outbox?.maxBatchSize,
      DEFAULT_OPENVIKING_OUTBOX_BATCH_SIZE,
    ),
    retryBaseMs: resolvePositiveInt(raw?.outbox?.retryBaseMs, DEFAULT_OPENVIKING_RETRY_BASE_MS),
    retryMaxMs: resolvePositiveInt(raw?.outbox?.retryMaxMs, DEFAULT_OPENVIKING_RETRY_MAX_MS),
  };
  const fsWriteAllowUriPrefixes = normalizeUriRuleList(raw?.fsWrite?.allowUriPrefixes);
  const fsWriteDenyUriPrefixesRaw = normalizeUriRuleList(raw?.fsWrite?.denyUriPrefixes);
  const fsWriteProtectedUrisRaw = normalizeUriRuleList(raw?.fsWrite?.protectedUris);
  const fsWrite: ResolvedOpenVikingFsWriteConfig = {
    enabled: raw?.fsWrite?.enabled === true ? true : DEFAULT_OPENVIKING_FSWRITE_ENABLED,
    allowUriPrefixes: fsWriteAllowUriPrefixes,
    denyUriPrefixes:
      fsWriteDenyUriPrefixesRaw.length > 0
        ? fsWriteDenyUriPrefixesRaw
        : DEFAULT_OPENVIKING_FSWRITE_DENY_URI_PREFIXES,
    protectedUris:
      fsWriteProtectedUrisRaw.length > 0
        ? fsWriteProtectedUrisRaw
        : DEFAULT_OPENVIKING_FSWRITE_PROTECTED_URIS,
    allowRecursiveRm:
      raw?.fsWrite?.allowRecursiveRm === true ? true : DEFAULT_OPENVIKING_FSWRITE_ALLOW_RECURSIVE_RM,
  };

  const search: ResolvedOpenVikingSearchConfig = {
    limit: resolvePositiveInt(raw?.search?.limit, DEFAULT_OPENVIKING_SEARCH_LIMIT),
    scoreThreshold: resolvePositiveFloat(raw?.search?.scoreThreshold),
    targetUri: raw?.search?.targetUri?.trim() || targetUri,
    includeResources: raw?.search?.includeResources === true,
    includeSkills: raw?.search?.includeSkills === true,
    explainability: raw?.search?.explainability === true,
    strategy: resolveOpenVikingSearchStrategy(raw?.search?.strategy),
    readLayer: resolveOpenVikingSearchReadLayer(raw?.search?.readLayer),
    maxEntries: resolvePositiveInt(raw?.search?.maxEntries, DEFAULT_OPENVIKING_SEARCH_MAX_ENTRIES),
    maxSnippetChars: resolvePositiveInt(
      raw?.search?.maxSnippetChars,
      DEFAULT_OPENVIKING_SEARCH_MAX_SNIPPET_CHARS,
    ),
    maxInjectedChars: resolvePositiveInt(
      raw?.search?.maxInjectedChars,
      DEFAULT_OPENVIKING_SEARCH_MAX_INJECTED_CHARS,
    ),
    relationExpansion:
      raw?.search?.relationExpansion === true ? true : DEFAULT_OPENVIKING_RELATION_EXPANSION,
    relationMaxDepth: resolvePositiveInt(
      raw?.search?.relationMaxDepth,
      DEFAULT_OPENVIKING_RELATION_MAX_DEPTH,
    ),
    relationMaxAnchors: resolvePositiveInt(
      raw?.search?.relationMaxAnchors,
      DEFAULT_OPENVIKING_RELATION_MAX_ANCHORS,
    ),
    relationMaxExpandedEntries: resolvePositiveInt(
      raw?.search?.relationMaxExpandedEntries,
      DEFAULT_OPENVIKING_RELATION_MAX_EXPANDED_ENTRIES,
    ),
    relationSeedAnchorScore: resolveNonNegativeFloat(
      raw?.search?.relationSeedAnchorScore,
      DEFAULT_OPENVIKING_RELATION_SEED_ANCHOR_SCORE,
    ),
    relationPriorityBudgetBoost:
      raw?.search?.relationPriorityBudgetBoost === false
        ? false
        : DEFAULT_OPENVIKING_RELATION_PRIORITY_BUDGET_BOOST,
    relationPriorityDepthBonus: resolveNonNegativeInt(
      raw?.search?.relationPriorityDepthBonus,
      DEFAULT_OPENVIKING_RELATION_PRIORITY_DEPTH_BONUS,
    ),
    relationPriorityAnchorsBonus: resolveNonNegativeInt(
      raw?.search?.relationPriorityAnchorsBonus,
      DEFAULT_OPENVIKING_RELATION_PRIORITY_ANCHORS_BONUS,
    ),
    relationPriorityExpandedBonus: resolveNonNegativeInt(
      raw?.search?.relationPriorityExpandedBonus,
      DEFAULT_OPENVIKING_RELATION_PRIORITY_EXPANDED_BONUS,
    ),
  };

  return {
    endpoint,
    apiKey,
    headers,
    timeoutMs,
    targetUri,
    dualWrite,
    commit: {
      mode: commitMode,
      triggers: commitTriggers,
    },
    outbox,
    fsWrite,
    search,
  };
}

export function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);

  if (backend === "openviking") {
    return {
      backend: "openviking",
      citations,
      openviking: resolveOpenVikingConfig(params.cfg.memory?.openviking, workspaceDir),
    };
  }
  if (backend !== "qmd") {
    return { backend: "builtin", citations };
  }

  const qmdCfg = params.cfg.memory?.qmd;
  const includeDefaultMemory = qmdCfg?.includeDefaultMemory !== false;
  const nameSet = new Set<string>();
  const collections = [
    ...resolveDefaultCollections(includeDefaultMemory, workspaceDir, nameSet, params.agentId),
    ...resolveCustomPaths(qmdCfg?.paths, workspaceDir, nameSet, params.agentId),
  ];

  const rawCommand = qmdCfg?.command?.trim() || "qmd";
  const parsedCommand = splitShellArgs(rawCommand);
  const command = parsedCommand?.[0] || rawCommand.split(/\s+/)[0] || "qmd";
  const resolved: ResolvedQmdConfig = {
    command,
    searchMode: resolveSearchMode(qmdCfg?.searchMode),
    collections,
    includeDefaultMemory,
    sessions: resolveSessionConfig(qmdCfg?.sessions, workspaceDir),
    update: {
      intervalMs: resolveIntervalMs(qmdCfg?.update?.interval),
      debounceMs: resolveDebounceMs(qmdCfg?.update?.debounceMs),
      onBoot: qmdCfg?.update?.onBoot !== false,
      waitForBootSync: qmdCfg?.update?.waitForBootSync === true,
      embedIntervalMs: resolveEmbedIntervalMs(qmdCfg?.update?.embedInterval),
      commandTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.commandTimeoutMs,
        DEFAULT_QMD_COMMAND_TIMEOUT_MS,
      ),
      updateTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.updateTimeoutMs,
        DEFAULT_QMD_UPDATE_TIMEOUT_MS,
      ),
      embedTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.embedTimeoutMs,
        DEFAULT_QMD_EMBED_TIMEOUT_MS,
      ),
    },
    limits: resolveLimits(qmdCfg?.limits),
    scope: qmdCfg?.scope ?? DEFAULT_QMD_SCOPE,
  };

  return {
    backend: "qmd",
    citations,
    qmd: resolved,
  };
}
