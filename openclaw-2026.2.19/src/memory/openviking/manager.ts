import type { OpenClawConfig } from "../../config/config.js";
import type {
  OpenVikingSearchReadLayer,
  OpenVikingSearchStrategy,
} from "../../config/types.memory.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  type ResolvedMemoryBackendConfig,
  type ResolvedOpenVikingConfig,
} from "../backend-config.js";
import type { MemorySource } from "../types.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
} from "../types.js";
import {
  getOpenVikingBridgeStats,
  getOpenVikingOutboxStats,
  resolveLinkedOpenVikingSessionId,
} from "./bridge.js";
import {
  OpenVikingClient,
  type OpenVikingMatchedContext,
  type OpenVikingSearchResult,
} from "./client.js";

const log = createSubsystemLogger("memory/openviking/manager");
const LAST_EXPLAINABILITY = new Map<string, OpenVikingExplainabilitySummary>();
const LAST_STRATEGY = new Map<string, OpenVikingSearchStrategySummary>();
const LAST_LAYERING = new Map<string, OpenVikingLayeringSummary>();
const LAST_RELATION_EXPANSION = new Map<string, OpenVikingRelationExpansionSummary>();
const LAST_RANKING = new Map<string, OpenVikingRankingSummary>();

type OpenVikingContextKind = "memory" | "resource" | "skill";
type OpenVikingReadLayer = "l0" | "l1" | "l2";
type OpenVikingRecallOrigin = "direct" | "relation";

type OpenVikingExplainabilitySummary = {
  at: number;
  query: string;
  sessionKey?: string;
  sessionId?: string;
  typedQueries: number;
  queryResults: number;
  memories: number;
  resources: number;
  skills: number;
  fallback: "none" | "find";
  fallbackHits: number;
  topQueries: Array<{ query: string; contextType: string; priority?: number }>;
};

type OpenVikingSearchStrategySummary = {
  at: number;
  strategy: OpenVikingSearchStrategy;
  reason: string;
  priority: OpenVikingContextKind;
  includeResources: boolean;
  includeSkills: boolean;
  sessionKey?: string;
};

type OpenVikingSearchDecision = {
  strategy: OpenVikingSearchStrategy;
  reason: string;
  priority: OpenVikingContextKind;
  includeResources: boolean;
  includeSkills: boolean;
};

type OpenVikingPlannerSignals = {
  source: "none" | "query_plan" | "query_results" | "combined";
  memory: number;
  resource: number;
  skill: number;
};

type OpenVikingLayeringSummary = {
  at: number;
  requestedLayer: OpenVikingSearchReadLayer;
  entries: number;
  snippetChars: number;
  injectedChars: number;
  l0: number;
  l1: number;
  l2: number;
  truncatedByBudget: boolean;
};

type OpenVikingSearchCandidate = {
  kind: OpenVikingContextKind;
  context: OpenVikingMatchedContext;
  score: number;
  rank: number;
  origin: OpenVikingRecallOrigin;
  relationFrom?: string;
  relationDepth?: number;
  relationReason?: string;
};

type OpenVikingRelationExpansionSummary = {
  at: number;
  enabled: boolean;
  priority: OpenVikingContextKind;
  boostApplied: boolean;
  baseMaxDepth: number;
  baseMaxAnchors: number;
  baseMaxExpandedEntries: number;
  maxDepth: number;
  maxAnchors: number;
  maxExpandedEntries: number;
  anchors: number;
  seedAnchors: number;
  relationQueries: number;
  discovered: number;
  selected: number;
  directSelected: number;
  relationSelected: number;
};

type OpenVikingRankingSummary = {
  at: number;
  priority: OpenVikingContextKind;
  minScore?: number;
  hardLimit: number;
  totalCandidates: number;
  directCandidates: number;
  relationCandidates: number;
  filteredCandidates: number;
  selectedCandidates: number;
  emittedCandidates: number;
  droppedByMaxEntries: number;
  droppedByBudget: number;
  skippedEmptySnippet: number;
};

const RESOURCE_SIGNALS = [
  "file",
  "files",
  "path",
  "paths",
  "readme",
  "markdown",
  "md",
  "resource",
  "resources",
  "code",
  "config",
  "api",
  "document",
  "docs",
];

const SKILL_SIGNALS = [
  "how",
  "plan",
  "steps",
  "workflow",
  "playbook",
  "guide",
  "guidance",
  "best practice",
  "template",
  "skill",
  "skills",
  "strategy",
  "process",
];

function resolveSourceFromUri(uri: string): MemorySource {
  const normalized = uri.toLowerCase();
  if (normalized.includes("viking://session/")) {
    return "sessions";
  }
  return "memory";
}

function resolveContextKindFromUri(uri: string): OpenVikingContextKind {
  const normalized = uri.toLowerCase();
  if (normalized.includes("/skills/")) {
    return "skill";
  }
  if (normalized.includes("/session/") || normalized.includes("/memories/")) {
    return "memory";
  }
  return "resource";
}

function contextToMemoryResult(
  context: OpenVikingMatchedContext,
  snippetOverride?: string,
): MemorySearchResult {
  const uri = typeof context.uri === "string" && context.uri.trim() ? context.uri : "viking://";
  const snippet =
    snippetOverride ?? context.overview ?? context.abstract ?? context.match_reason ?? "";
  return {
    path: uri,
    startLine: 1,
    endLine: 1,
    score: typeof context.score === "number" && Number.isFinite(context.score) ? context.score : 0,
    snippet,
    source: resolveSourceFromUri(uri),
  };
}

function normalizeRelationRows(rows: unknown): Array<{ uri: string; reason?: string }> {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => {
      const uri = typeof entry.uri === "string" ? entry.uri.trim() : "";
      if (!uri) {
        return null;
      }
      const reason =
        typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : undefined;
      return { uri, reason };
    })
    .filter((entry): entry is { uri: string; reason?: string } => Boolean(entry));
}

function normalizeUri(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("path required");
  }
  if (trimmed.startsWith("viking://")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return `viking://resource${trimmed}`;
  }
  return `viking://resource/${trimmed.replace(/^\.?\//, "")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizePlanQueries(
  plan: Record<string, unknown> | undefined,
): OpenVikingExplainabilitySummary["topQueries"] {
  const queries = plan?.queries;
  if (!Array.isArray(queries)) {
    return [];
  }
  return queries
    .map((entry) => {
      const row = asRecord(entry);
      if (!row) {
        return null;
      }
      const query = typeof row.query === "string" ? row.query.trim() : "";
      if (!query) {
        return null;
      }
      const contextType =
        typeof row.context_type === "string" && row.context_type.trim()
          ? row.context_type.trim()
          : "unknown";
      const priority =
        typeof row.priority === "number" && Number.isFinite(row.priority)
          ? row.priority
          : undefined;
      return {
        query: query.length > 160 ? `${query.slice(0, 160)}...` : query,
        contextType,
        priority,
      };
    })
    .filter((entry): entry is { query: string; contextType: string; priority?: number } =>
      Boolean(entry),
    )
    .slice(0, 5);
}

function collectPlanTargetDirectories(plan: Record<string, unknown> | undefined): string[] {
  const queries = plan?.queries;
  if (!Array.isArray(queries)) {
    return [];
  }
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const entry of queries) {
    const row = asRecord(entry);
    const targets = Array.isArray(row?.target_directories) ? row.target_directories : [];
    for (const target of targets) {
      if (typeof target !== "string") {
        continue;
      }
      const trimmed = target.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      uris.push(trimmed);
    }
  }
  return uris;
}

function summarizeExplainability(params: {
  query: string;
  sessionKey?: string;
  sessionId?: string;
  plan?: Record<string, unknown>;
  queryResults?: Array<Record<string, unknown>>;
  memories: number;
  resources: number;
  skills: number;
  fallback?: "none" | "find";
  fallbackHits?: number;
}): OpenVikingExplainabilitySummary {
  return {
    at: Date.now(),
    query: params.query.length > 200 ? `${params.query.slice(0, 200)}...` : params.query,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    typedQueries: Array.isArray(params.plan?.queries) ? params.plan.queries.length : 0,
    queryResults: Array.isArray(params.queryResults) ? params.queryResults.length : 0,
    memories: params.memories,
    resources: params.resources,
    skills: params.skills,
    fallback: params.fallback ?? "none",
    fallbackHits: params.fallbackHits ?? 0,
    topQueries: normalizePlanQueries(params.plan),
  };
}

function collectContextsFromSearchResult(params: {
  result: OpenVikingSearchResult;
  decision: OpenVikingSearchDecision;
}): Array<{ kind: OpenVikingContextKind; context: OpenVikingMatchedContext }> {
  const contexts: Array<{ kind: OpenVikingContextKind; context: OpenVikingMatchedContext }> = (
    params.result.memories ?? []
  ).map((context) => ({ kind: "memory" as const, context }));
  if (params.decision.includeResources) {
    contexts.push(
      ...(params.result.resources ?? []).map((context) => ({ kind: "resource" as const, context })),
    );
  }
  if (params.decision.includeSkills) {
    contexts.push(
      ...(params.result.skills ?? []).map((context) => ({ kind: "skill" as const, context })),
    );
  }
  return contexts;
}

function normalizeContextKind(value: unknown): OpenVikingContextKind | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "memory" || normalized === "memories") {
    return "memory";
  }
  if (normalized === "resource" || normalized === "resources") {
    return "resource";
  }
  if (normalized === "skill" || normalized === "skills") {
    return "skill";
  }
  return null;
}

function normalizePriorityWeight(priority: unknown): number {
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    return 2;
  }
  const normalized = Math.max(1, Math.floor(priority));
  if (normalized <= 1) {
    return 5;
  }
  if (normalized === 2) {
    return 4;
  }
  if (normalized === 3) {
    return 3;
  }
  if (normalized === 4) {
    return 2;
  }
  return 1;
}

function resolvePlannerSignals(params: {
  plan?: Record<string, unknown>;
  queryResults?: Array<Record<string, unknown>>;
}): OpenVikingPlannerSignals {
  const signals: OpenVikingPlannerSignals = {
    source: "none",
    memory: 0,
    resource: 0,
    skill: 0,
  };
  let usedPlan = false;
  let usedQueryResults = false;

  const planQueries = params.plan?.queries;
  if (Array.isArray(planQueries)) {
    for (const entry of planQueries) {
      const row = asRecord(entry);
      if (!row) {
        continue;
      }
      const kind = normalizeContextKind(row.context_type);
      if (!kind) {
        continue;
      }
      const weight = normalizePriorityWeight(row.priority);
      signals[kind] += weight;
      usedPlan = true;
    }
  }

  if (Array.isArray(params.queryResults)) {
    for (const entry of params.queryResults) {
      const row = asRecord(entry);
      if (!row) {
        continue;
      }
      const rowQuery = asRecord(row.query);
      const kind = normalizeContextKind(rowQuery?.context_type ?? row.context_type);
      if (!kind) {
        continue;
      }
      const matchedContexts = Array.isArray(row.matched_contexts) ? row.matched_contexts.length : 0;
      const weight = matchedContexts > 0 ? Math.min(5, matchedContexts) : 1;
      signals[kind] += weight;
      usedQueryResults = true;
    }
  }

  if (usedPlan && usedQueryResults) {
    signals.source = "combined";
  } else if (usedPlan) {
    signals.source = "query_plan";
  } else if (usedQueryResults) {
    signals.source = "query_results";
  }

  return signals;
}

function resolvePlannerPriority(signals: OpenVikingPlannerSignals): OpenVikingContextKind | null {
  const entries: Array<{ kind: OpenVikingContextKind; score: number }> = [
    { kind: "memory", score: signals.memory },
    { kind: "resource", score: signals.resource },
    { kind: "skill", score: signals.skill },
  ].toSorted((a, b) => b.score - a.score);
  const top = entries[0];
  const second = entries[1];
  if (!top || top.score <= 0) {
    return null;
  }
  if (second && second.score === top.score) {
    return null;
  }
  return top.kind;
}

function buildSignalTokenSet(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

function countSignalHits(query: string, signals: string[]): number {
  const tokenSet = buildSignalTokenSet(query);
  return signals.reduce((count, signal) => {
    if (signal.includes(" ")) {
      return query.includes(signal) ? count + 1 : count;
    }
    return tokenSet.has(signal) ? count + 1 : count;
  }, 0);
}

function resolveSearchDecision(params: {
  strategy: OpenVikingSearchStrategy;
  includeResources: boolean;
  includeSkills: boolean;
  query: string;
  sessionKey?: string;
  plan?: Record<string, unknown>;
  queryResults?: Array<Record<string, unknown>>;
}): OpenVikingSearchDecision {
  if (params.strategy === "memory_first") {
    return {
      strategy: params.strategy,
      reason: "configured-memory-first",
      priority: "memory",
      includeResources: params.includeResources,
      includeSkills: params.includeSkills,
    };
  }
  if (params.strategy === "resource_first") {
    return {
      strategy: params.strategy,
      reason: "configured-resource-first",
      priority: "resource",
      includeResources: true,
      includeSkills: params.includeSkills,
    };
  }
  if (params.strategy === "skill_first") {
    return {
      strategy: params.strategy,
      reason: "configured-skill-first",
      priority: "skill",
      includeResources: params.includeResources,
      includeSkills: true,
    };
  }

  const normalized = params.query.toLowerCase();
  const resourceHits = countSignalHits(normalized, RESOURCE_SIGNALS);
  const skillHits = countSignalHits(normalized, SKILL_SIGNALS);
  const plannerSignals = resolvePlannerSignals({
    plan: params.plan,
    queryResults: params.queryResults,
  });
  const plannerPriority = resolvePlannerPriority(plannerSignals);
  const hasSessionKey = Boolean(params.sessionKey?.trim());
  const includeResources =
    params.includeResources || resourceHits > 0 || plannerSignals.resource > 0;
  const includeSkills = params.includeSkills || skillHits > 0 || plannerSignals.skill > 0;

  if (plannerPriority) {
    return {
      strategy: "auto",
      reason:
        plannerSignals.source === "query_plan"
          ? hasSessionKey
            ? "auto-planner-plan-session"
            : "auto-planner-plan"
          : plannerSignals.source === "query_results"
            ? hasSessionKey
              ? "auto-planner-results-session"
              : "auto-planner-results"
            : hasSessionKey
              ? "auto-planner-combined-session"
              : "auto-planner-combined",
      priority: plannerPriority,
      includeResources,
      includeSkills,
    };
  }

  if (resourceHits > skillHits) {
    return {
      strategy: "auto",
      reason: hasSessionKey ? "auto-resource-signals-session" : "auto-resource-signals",
      priority: "resource",
      includeResources,
      includeSkills,
    };
  }
  if (skillHits > resourceHits) {
    return {
      strategy: "auto",
      reason: hasSessionKey ? "auto-skill-signals-session" : "auto-skill-signals",
      priority: "skill",
      includeResources,
      includeSkills,
    };
  }
  if (resourceHits > 0 && skillHits > 0) {
    return {
      strategy: "auto",
      reason: "auto-mixed-signals",
      priority: "resource",
      includeResources,
      includeSkills,
    };
  }

  return {
    strategy: "auto",
    reason: hasSessionKey ? "auto-session-memory" : "auto-memory",
    priority: "memory",
    includeResources,
    includeSkills,
  };
}

function contextRankBonus(params: {
  kind: OpenVikingContextKind;
  decision: OpenVikingSearchDecision;
}): number {
  if (params.kind === params.decision.priority) {
    return 0.15;
  }
  if (params.kind === "memory") {
    return 0.05;
  }
  return 0;
}

function summarizeStrategy(params: {
  decision: OpenVikingSearchDecision;
  sessionKey?: string;
}): OpenVikingSearchStrategySummary {
  return {
    at: Date.now(),
    strategy: params.decision.strategy,
    reason: params.decision.reason,
    priority: params.decision.priority,
    includeResources: params.decision.includeResources,
    includeSkills: params.decision.includeSkills,
    sessionKey: params.sessionKey,
  };
}

function normalizeSnippetText(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.trim();
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function decorateSnippetForRecall(
  snippet: string,
  candidate: OpenVikingSearchCandidate,
  relationExpansionEnabled: boolean,
): string {
  if (!relationExpansionEnabled) {
    return snippet;
  }
  if (candidate.origin === "relation") {
    const from = candidate.relationFrom ?? "unknown";
    const depth = candidate.relationDepth ?? 1;
    return `[relation-expanded d${depth} from ${from}] ${snippet}`;
  }
  return `[direct-hit] ${snippet}`;
}

export class OpenVikingMemoryManager implements MemorySearchManager {
  private readonly client: OpenVikingClient;
  private readonly explainabilityKey: string;

  private constructor(
    private readonly cfg: OpenClawConfig,
    private readonly agentId: string,
    private readonly resolved: ResolvedOpenVikingConfig,
  ) {
    this.client = new OpenVikingClient(resolved);
    this.explainabilityKey = `${agentId}:${resolved.endpoint}`;
  }

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<OpenVikingMemoryManager> {
    if (!params.resolved.openviking) {
      throw new Error("openviking backend config missing");
    }
    return new OpenVikingMemoryManager(params.cfg, params.agentId, params.resolved.openviking);
  }

  private async expandRelationCandidates(params: {
    directCandidates: OpenVikingSearchCandidate[];
    decision: OpenVikingSearchDecision;
    seedUris?: string[];
  }): Promise<{
    candidates: OpenVikingSearchCandidate[];
    summary: OpenVikingRelationExpansionSummary;
  }> {
    const baseMaxDepth = Math.max(1, this.resolved.search.relationMaxDepth);
    const baseMaxAnchors = Math.max(1, this.resolved.search.relationMaxAnchors);
    const baseMaxExpandedEntries = Math.max(1, this.resolved.search.relationMaxExpandedEntries);
    const boostApplied =
      this.resolved.search.relationPriorityBudgetBoost && params.decision.priority !== "memory";
    const maxDepth = boostApplied
      ? baseMaxDepth + this.resolved.search.relationPriorityDepthBonus
      : baseMaxDepth;
    const maxAnchors = boostApplied
      ? baseMaxAnchors + this.resolved.search.relationPriorityAnchorsBonus
      : baseMaxAnchors;
    const maxExpandedEntries = boostApplied
      ? baseMaxExpandedEntries + this.resolved.search.relationPriorityExpandedBonus
      : baseMaxExpandedEntries;
    const summary: OpenVikingRelationExpansionSummary = {
      at: Date.now(),
      enabled: this.resolved.search.relationExpansion,
      priority: params.decision.priority,
      boostApplied,
      baseMaxDepth,
      baseMaxAnchors,
      baseMaxExpandedEntries,
      maxDepth,
      maxAnchors,
      maxExpandedEntries,
      anchors: 0,
      seedAnchors: 0,
      relationQueries: 0,
      discovered: 0,
      selected: 0,
      directSelected: 0,
      relationSelected: 0,
    };
    if (!this.resolved.search.relationExpansion) {
      return { candidates: [], summary };
    }
    const lookupBudget = Math.max(maxAnchors, maxExpandedEntries * maxDepth);

    const sortedDirect = params.directCandidates.toSorted(
      (a, b) => b.rank - a.rank || b.score - a.score,
    );
    const seenAnchorUris = new Set<string>();
    const anchors = sortedDirect
      .filter((entry) => {
        const uri = entry.context.uri?.trim() ?? "";
        if (!uri || seenAnchorUris.has(uri)) {
          return false;
        }
        seenAnchorUris.add(uri);
        return true;
      })
      .slice(0, maxAnchors);
    const seedUris = Array.isArray(params.seedUris) ? params.seedUris : [];
    const anchorBaseScore = Math.max(0, this.resolved.search.relationSeedAnchorScore);
    for (const seedUriRaw of seedUris) {
      if (anchors.length >= maxAnchors) {
        break;
      }
      const seedUri = seedUriRaw.trim();
      if (!seedUri || seenAnchorUris.has(seedUri)) {
        continue;
      }
      seenAnchorUris.add(seedUri);
      summary.seedAnchors += 1;
      anchors.push({
        kind: resolveContextKindFromUri(seedUri),
        context: {
          uri: seedUri,
          score: anchorBaseScore,
          match_reason: "planner-target-directory",
        },
        score: anchorBaseScore,
        rank: anchorBaseScore,
        origin: "direct",
      });
    }
    summary.anchors = anchors.length;
    if (anchors.length === 0) {
      return { candidates: [], summary };
    }

    const directUriSet = new Set(
      params.directCandidates
        .map((entry) => entry.context.uri?.trim() ?? "")
        .filter((uri) => Boolean(uri)),
    );
    const relationCandidateByUri = new Map<string, OpenVikingSearchCandidate>();

    for (const anchor of anchors) {
      const anchorUri = anchor.context.uri?.trim() ?? "";
      if (!anchorUri) {
        continue;
      }
      const queue: Array<{ uri: string; depth: number }> = [{ uri: anchorUri, depth: 0 }];
      const visited = new Set<string>([anchorUri]);
      while (
        queue.length > 0 &&
        relationCandidateByUri.size < maxExpandedEntries &&
        summary.relationQueries < lookupBudget
      ) {
        const current = queue.shift();
        if (!current) {
          break;
        }
        if (current.depth >= maxDepth) {
          continue;
        }

        let relationRows: Array<{ uri: string; reason?: string }> = [];
        try {
          summary.relationQueries += 1;
          relationRows = normalizeRelationRows(await this.client.relations(current.uri));
        } catch (error) {
          log.debug(
            `[relation-expand] read failed uri=${current.uri} error=${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        for (const relation of relationRows) {
          const relationUri = relation.uri.trim();
          if (!relationUri || directUriSet.has(relationUri) || relationUri === current.uri) {
            continue;
          }
          const nextDepth = current.depth + 1;
          if (!visited.has(relationUri)) {
            visited.add(relationUri);
            if (nextDepth < maxDepth) {
              queue.push({ uri: relationUri, depth: nextDepth });
            }
          }

          const kind = resolveContextKindFromUri(relationUri);
          const relationScore = Math.max(0, anchor.score - nextDepth * 0.12 - 0.08);
          const relationRank =
            relationScore +
            contextRankBonus({ kind, decision: params.decision }) -
            0.25 -
            nextDepth * 0.05;
          const currentBest = relationCandidateByUri.get(relationUri);
          if (currentBest && currentBest.rank >= relationRank) {
            continue;
          }

          relationCandidateByUri.set(relationUri, {
            kind,
            context: {
              uri: relationUri,
              score: relationScore,
              match_reason: relation.reason ?? `relation from ${anchorUri}`,
            },
            score: relationScore,
            rank: relationRank,
            origin: "relation",
            relationFrom: anchorUri,
            relationDepth: nextDepth,
            relationReason: relation.reason,
          });
          if (relationCandidateByUri.size >= maxExpandedEntries) {
            break;
          }
        }
      }
    }

    const candidates = [...relationCandidateByUri.values()];
    summary.discovered = candidates.length;
    return { candidates, summary };
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const maxResults =
      typeof opts?.maxResults === "number" && opts.maxResults > 0
        ? Math.floor(opts.maxResults)
        : this.resolved.search.limit;
    const scoreThreshold =
      typeof opts?.minScore === "number" ? opts.minScore : this.resolved.search.scoreThreshold;
    const sessionId = resolveLinkedOpenVikingSessionId({
      cfg: this.cfg,
      agentId: this.agentId,
      sessionKey: opts?.sessionKey,
    });
    let result = await this.client.search({
      query: trimmed,
      sessionId,
      targetUri: this.resolved.search.targetUri,
      limit: maxResults,
      scoreThreshold,
    });
    const plan = asRecord(result.query_plan) ?? undefined;
    const queryResults = Array.isArray(result.query_results)
      ? result.query_results.map((entry) => asRecord(entry) ?? {})
      : undefined;
    const decision = resolveSearchDecision({
      strategy: this.resolved.search.strategy,
      includeResources: this.resolved.search.includeResources,
      includeSkills: this.resolved.search.includeSkills,
      query: trimmed,
      sessionKey: opts?.sessionKey,
      plan,
      queryResults,
    });
    LAST_STRATEGY.set(
      this.explainabilityKey,
      summarizeStrategy({
        decision,
        sessionKey: opts?.sessionKey,
      }),
    );

    let contexts = collectContextsFromSearchResult({ result, decision });
    let fallback: "none" | "find" = "none";
    let fallbackHits = 0;
    if (contexts.length === 0) {
      try {
        const findResult = await this.client.find({
          query: trimmed,
          targetUri: this.resolved.search.targetUri,
          limit: maxResults,
          scoreThreshold,
        });
        const fallbackContexts = collectContextsFromSearchResult({
          result: findResult,
          decision,
        });
        if (fallbackContexts.length > 0) {
          result = {
            ...result,
            memories: findResult.memories,
            resources: findResult.resources,
            skills: findResult.skills,
          };
          contexts = fallbackContexts;
          fallback = "find";
          fallbackHits = fallbackContexts.length;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`find fallback failed: query="${trimmed}" error=${message}`);
      }
    }

    if (this.resolved.search.explainability) {
      const summary = summarizeExplainability({
        query: trimmed,
        sessionKey: opts?.sessionKey,
        sessionId,
        plan,
        queryResults,
        memories: Array.isArray(result.memories) ? result.memories.length : 0,
        resources: Array.isArray(result.resources) ? result.resources.length : 0,
        skills: Array.isArray(result.skills) ? result.skills.length : 0,
        fallback,
        fallbackHits,
      });
      LAST_EXPLAINABILITY.set(this.explainabilityKey, summary);
      log.info(
        `[search-explain] query="${summary.query}" typed=${summary.typedQueries} results=${summary.queryResults} memory=${summary.memories} resource=${summary.resources} skill=${summary.skills} fallback=${summary.fallback}:${summary.fallbackHits}`,
      );
    }

    const directCandidates: OpenVikingSearchCandidate[] = contexts.map((entry) => {
      const score =
        typeof entry.context.score === "number" && Number.isFinite(entry.context.score)
          ? entry.context.score
          : 0;
      return {
        kind: entry.kind,
        context: entry.context,
        score,
        rank: score + contextRankBonus({ kind: entry.kind, decision }),
        origin: "direct",
      };
    });
    const relationExpansion = await this.expandRelationCandidates({
      directCandidates,
      decision,
      seedUris: collectPlanTargetDirectories(plan),
    });
    const rankedRows = [...directCandidates, ...relationExpansion.candidates];
    const minScore = typeof opts?.minScore === "number" ? opts.minScore : undefined;
    const filtered =
      minScore != null ? rankedRows.filter((entry) => entry.score >= minScore) : rankedRows;
    filtered.sort((a, b) => b.rank - a.rank || b.score - a.score);
    const hardLimit = Math.max(1, Math.min(maxResults, this.resolved.search.maxEntries));
    const selected = filtered.slice(0, hardLimit);
    const rows: MemorySearchResult[] = [];
    const layerCounts: Record<OpenVikingReadLayer, number> = { l0: 0, l1: 0, l2: 0 };
    let remainingChars = Math.max(1, this.resolved.search.maxInjectedChars);
    let snippetChars = 0;
    let truncatedByBudget = false;
    let droppedByBudget = 0;
    let skippedEmptySnippet = 0;
    let directSelected = 0;
    let relationSelected = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const candidate = selected[index];
      if (!candidate) {
        continue;
      }
      const snippet = await this.resolveContextSnippet({
        context: candidate.context,
        requestedLayer: this.resolved.search.readLayer,
        maxSnippetChars: this.resolved.search.maxSnippetChars,
      });
      if (!snippet.text) {
        skippedEmptySnippet += 1;
        continue;
      }
      if (remainingChars <= 0) {
        truncatedByBudget = true;
        droppedByBudget = selected.length - index;
        break;
      }
      const decoratedSnippet = trimToMaxChars(
        decorateSnippetForRecall(snippet.text, candidate, this.resolved.search.relationExpansion),
        this.resolved.search.maxSnippetChars,
      );
      const finalSnippet =
        decoratedSnippet.length > remainingChars
          ? trimToMaxChars(decoratedSnippet, remainingChars)
          : decoratedSnippet;
      if (!finalSnippet) {
        truncatedByBudget = true;
        droppedByBudget = selected.length - index;
        break;
      }
      rows.push(contextToMemoryResult(candidate.context, finalSnippet));
      if (candidate.origin === "relation") {
        relationSelected += 1;
      } else {
        directSelected += 1;
      }
      layerCounts[snippet.layer] += 1;
      snippetChars += finalSnippet.length;
      remainingChars -= finalSnippet.length;
      if (remainingChars <= 0) {
        truncatedByBudget = true;
        droppedByBudget = selected.length - (index + 1);
        break;
      }
    }
    LAST_LAYERING.set(this.explainabilityKey, {
      at: Date.now(),
      requestedLayer: this.resolved.search.readLayer,
      entries: rows.length,
      snippetChars,
      injectedChars: this.resolved.search.maxInjectedChars - Math.max(0, remainingChars),
      l0: layerCounts.l0,
      l1: layerCounts.l1,
      l2: layerCounts.l2,
      truncatedByBudget,
    });
    LAST_RANKING.set(this.explainabilityKey, {
      at: Date.now(),
      priority: decision.priority,
      minScore,
      hardLimit,
      totalCandidates: rankedRows.length,
      directCandidates: directCandidates.length,
      relationCandidates: relationExpansion.candidates.length,
      filteredCandidates: filtered.length,
      selectedCandidates: selected.length,
      emittedCandidates: rows.length,
      droppedByMaxEntries: Math.max(0, filtered.length - selected.length),
      droppedByBudget,
      skippedEmptySnippet,
    });
    LAST_RELATION_EXPANSION.set(this.explainabilityKey, {
      ...relationExpansion.summary,
      at: Date.now(),
      selected: rows.length,
      directSelected,
      relationSelected,
    });
    return rows;
  }

  private async resolveContextSnippet(params: {
    context: OpenVikingMatchedContext;
    requestedLayer: OpenVikingSearchReadLayer;
    maxSnippetChars: number;
  }): Promise<{ text: string; layer: OpenVikingReadLayer }> {
    const uri = typeof params.context.uri === "string" ? params.context.uri.trim() : "";
    const inlineL1 = normalizeSnippetText(params.context.overview);
    const inlineL0 =
      normalizeSnippetText(params.context.abstract) ||
      normalizeSnippetText(params.context.match_reason);
    const usefulMinChars = Math.max(40, Math.floor(params.maxSnippetChars / 6));

    const readL2 = async (): Promise<string> => {
      if (!uri) {
        return "";
      }
      try {
        return normalizeSnippetText(await this.client.read(uri));
      } catch {
        return "";
      }
    };

    const readL1 = async (): Promise<string> => {
      if (inlineL1) {
        return inlineL1;
      }
      if (!uri) {
        return "";
      }
      try {
        return normalizeSnippetText(await this.client.overview(uri));
      } catch {
        return "";
      }
    };

    const readL0 = async (): Promise<string> => {
      if (inlineL0) {
        return inlineL0;
      }
      if (!uri) {
        return "";
      }
      try {
        return normalizeSnippetText(await this.client.abstract(uri));
      } catch {
        return "";
      }
    };

    const finalize = (
      layer: OpenVikingReadLayer,
      text: string,
    ): { text: string; layer: OpenVikingReadLayer } => {
      return { layer, text: trimToMaxChars(text, params.maxSnippetChars) };
    };

    if (params.requestedLayer === "l2") {
      const l2 = await readL2();
      if (l2) {
        return finalize("l2", l2);
      }
      const l1 = await readL1();
      if (l1) {
        return finalize("l1", l1);
      }
      const l0 = await readL0();
      return finalize("l0", l0);
    }

    if (params.requestedLayer === "l1") {
      const l1 = await readL1();
      if (l1) {
        return finalize("l1", l1);
      }
      const l0 = await readL0();
      if (l0) {
        return finalize("l0", l0);
      }
      const l2 = await readL2();
      return finalize("l2", l2);
    }

    if (params.requestedLayer === "l0") {
      const l0 = await readL0();
      if (l0) {
        return finalize("l0", l0);
      }
      const l1 = await readL1();
      if (l1) {
        return finalize("l1", l1);
      }
      const l2 = await readL2();
      return finalize("l2", l2);
    }

    const l1 = await readL1();
    if (l1 && l1.length >= usefulMinChars) {
      return finalize("l1", l1);
    }
    const l0 = await readL0();
    if (l0 && l0.length >= usefulMinChars) {
      return finalize("l0", l0);
    }
    const l2 = await readL2();
    if (l2) {
      return finalize("l2", l2);
    }
    if (l1) {
      return finalize("l1", l1);
    }
    return finalize("l0", l0);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const uri = normalizeUri(params.relPath);
    const text = await this.client.read(uri);
    if (!params.from && !params.lines) {
      return { text, path: uri };
    }
    const allLines = text.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? allLines.length);
    const slice = allLines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: uri };
  }

  status() {
    const lastExplain = LAST_EXPLAINABILITY.get(this.explainabilityKey);
    const lastStrategy = LAST_STRATEGY.get(this.explainabilityKey);
    const lastLayering = LAST_LAYERING.get(this.explainabilityKey);
    const lastRelationExpansion = LAST_RELATION_EXPANSION.get(this.explainabilityKey);
    const lastRanking = LAST_RANKING.get(this.explainabilityKey);
    const searchStatus: Record<string, unknown> = { ...this.resolved.search };
    if (lastExplain) {
      searchStatus.lastExplain = {
        at: lastExplain.at,
        typedQueries: lastExplain.typedQueries,
        queryResults: lastExplain.queryResults,
        fallback: lastExplain.fallback,
        fallbackHits: lastExplain.fallbackHits,
        topQueries: lastExplain.topQueries,
      };
    }
    if (lastStrategy) {
      searchStatus.lastStrategy = {
        at: lastStrategy.at,
        strategy: lastStrategy.strategy,
        reason: lastStrategy.reason,
        priority: lastStrategy.priority,
        includeResources: lastStrategy.includeResources,
        includeSkills: lastStrategy.includeSkills,
      };
    }
    if (lastLayering) {
      searchStatus.lastLayering = {
        at: lastLayering.at,
        requestedLayer: lastLayering.requestedLayer,
        entries: lastLayering.entries,
        snippetChars: lastLayering.snippetChars,
        injectedChars: lastLayering.injectedChars,
        l0: lastLayering.l0,
        l1: lastLayering.l1,
        l2: lastLayering.l2,
        truncatedByBudget: lastLayering.truncatedByBudget,
      };
    }
    if (lastRelationExpansion) {
      searchStatus.lastRelations = {
        at: lastRelationExpansion.at,
        enabled: lastRelationExpansion.enabled,
        priority: lastRelationExpansion.priority,
        boostApplied: lastRelationExpansion.boostApplied,
        baseMaxDepth: lastRelationExpansion.baseMaxDepth,
        baseMaxAnchors: lastRelationExpansion.baseMaxAnchors,
        baseMaxExpandedEntries: lastRelationExpansion.baseMaxExpandedEntries,
        maxDepth: lastRelationExpansion.maxDepth,
        maxAnchors: lastRelationExpansion.maxAnchors,
        maxExpandedEntries: lastRelationExpansion.maxExpandedEntries,
        anchors: lastRelationExpansion.anchors,
        seedAnchors: lastRelationExpansion.seedAnchors,
        relationQueries: lastRelationExpansion.relationQueries,
        discovered: lastRelationExpansion.discovered,
        selected: lastRelationExpansion.selected,
        directSelected: lastRelationExpansion.directSelected,
        relationSelected: lastRelationExpansion.relationSelected,
      };
    }
    if (lastRanking) {
      searchStatus.lastRanking = {
        at: lastRanking.at,
        priority: lastRanking.priority,
        minScore: lastRanking.minScore,
        hardLimit: lastRanking.hardLimit,
        totalCandidates: lastRanking.totalCandidates,
        directCandidates: lastRanking.directCandidates,
        relationCandidates: lastRanking.relationCandidates,
        filteredCandidates: lastRanking.filteredCandidates,
        selectedCandidates: lastRanking.selectedCandidates,
        emittedCandidates: lastRanking.emittedCandidates,
        droppedByMaxEntries: lastRanking.droppedByMaxEntries,
        droppedByBudget: lastRanking.droppedByBudget,
        skippedEmptySnippet: lastRanking.skippedEmptySnippet,
      };
    }
    return {
      backend: "openviking" as const,
      provider: "openviking",
      model: "context-os",
      requestedProvider: "openviking",
      custom: {
        endpoint: this.resolved.endpoint,
        targetUri: this.resolved.targetUri,
        dualWrite: this.resolved.dualWrite,
        commit: this.resolved.commit,
        search: searchStatus,
        outbox: getOpenVikingOutboxStats({
          cfg: this.cfg,
          agentId: this.agentId,
        }),
        timeliness: {
          commitMode: this.resolved.commit.mode,
          triggerEveryNMessages: this.resolved.commit.triggers.everyNMessages,
          triggerEveryNMinutes: this.resolved.commit.triggers.everyNMinutes,
          outboxFlushIntervalMs: this.resolved.outbox.flushIntervalMs,
          bridge: getOpenVikingBridgeStats({
            cfg: this.cfg,
            agentId: this.agentId,
          }),
        },
      },
    };
  }

  async sync(_params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    return;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return await this.client.health();
  }

  async close(): Promise<void> {
    return;
  }
}
