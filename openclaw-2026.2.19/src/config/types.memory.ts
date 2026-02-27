import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd" | "openviking";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
export type OpenVikingCommitMode = "sync" | "async";
export type OpenVikingSearchStrategy = "auto" | "memory_first" | "resource_first" | "skill_first";
export type OpenVikingSearchReadLayer = "l0" | "l1" | "l2" | "progressive";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  openviking?: OpenVikingMemoryConfig;
};

export type MemoryQmdConfig = {
  command?: string;
  searchMode?: MemoryQmdSearchMode;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};

export type OpenVikingMemoryConfig = {
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  targetUri?: string;
  dualWrite?: boolean;
  commit?: OpenVikingCommitConfig;
  outbox?: OpenVikingOutboxConfig;
  search?: OpenVikingSearchConfig;
  fsWrite?: OpenVikingFsWriteConfig;
};

export type OpenVikingCommitConfig = {
  mode?: OpenVikingCommitMode;
  triggers?: OpenVikingCommitTriggerConfig;
};

export type OpenVikingCommitTriggerConfig = {
  sessionEnd?: boolean;
  reset?: boolean;
  everyNMessages?: number;
  everyNMinutes?: number;
};

export type OpenVikingOutboxConfig = {
  enabled?: boolean;
  path?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

export type OpenVikingFsWriteConfig = {
  enabled?: boolean;
  allowUriPrefixes?: string[];
  denyUriPrefixes?: string[];
  protectedUris?: string[];
  allowRecursiveRm?: boolean;
};

export type OpenVikingSearchConfig = {
  limit?: number;
  scoreThreshold?: number;
  targetUri?: string;
  includeResources?: boolean;
  includeSkills?: boolean;
  explainability?: boolean;
  strategy?: OpenVikingSearchStrategy;
  readLayer?: OpenVikingSearchReadLayer;
  maxEntries?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  relationExpansion?: boolean;
  relationMaxDepth?: number;
  relationMaxAnchors?: number;
  relationMaxExpandedEntries?: number;
  relationSeedAnchorScore?: number;
  relationPriorityBudgetBoost?: boolean;
  relationPriorityDepthBonus?: number;
  relationPriorityAnchorsBonus?: number;
  relationPriorityExpandedBonus?: number;
};
