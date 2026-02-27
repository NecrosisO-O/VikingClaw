import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import {
  ingestOpenVikingResource,
  ingestOpenVikingSkill,
  type OpenVikingIngestReceipt,
} from "../memory/openviking/ingest.js";
import {
  addOpenVikingSessionMessage,
  deleteOpenVikingSession,
  exportOpenVikingPack,
  extractOpenVikingSession,
  findOpenVikingContext,
  getOpenVikingSession,
  globOpenVikingContext,
  grepOpenVikingContext,
  importOpenVikingPack,
  linkOpenVikingRelation,
  listOpenVikingFs,
  listOpenVikingSessions,
  listOpenVikingRelations,
  mkdirOpenVikingFs,
  mvOpenVikingFs,
  rmOpenVikingFs,
  statOpenVikingFs,
  treeOpenVikingFs,
  unlinkOpenVikingRelation,
} from "../memory/openviking/fs-relations.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";
import { withProgress, withProgressTotals } from "./progress.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

type MemoryIngestBaseOptions = {
  agent?: string;
  wait?: boolean;
  timeout?: number;
  retries?: number;
  json?: boolean;
};

type MemoryIngestResourceOptions = MemoryIngestBaseOptions & {
  target?: string;
  reason?: string;
  instruction?: string;
};

type MemoryIngestSkillOptions = MemoryIngestBaseOptions & {
  data?: string;
  file?: string;
};

type MemoryOpenVikingQueryOptions = {
  agent?: string;
  json?: boolean;
};

type MemoryOpenVikingFsOptions = MemoryOpenVikingQueryOptions & {
  output?: string;
  absLimit?: number;
  showAllHidden?: boolean;
};

type MemoryOpenVikingFsLsOptions = MemoryOpenVikingFsOptions & {
  simple?: boolean;
  recursive?: boolean;
};

type MemoryOpenVikingFsRmOptions = MemoryOpenVikingQueryOptions & {
  recursive?: boolean;
  yes?: boolean;
};

type MemoryOpenVikingRelationLinkOptions = MemoryOpenVikingQueryOptions & {
  reason?: string;
};

type MemoryOpenVikingFindOptions = MemoryOpenVikingQueryOptions & {
  targetUri?: string;
  limit?: number;
  scoreThreshold?: number;
};

type MemoryOpenVikingGlobOptions = MemoryOpenVikingQueryOptions & {
  uri?: string;
};

type MemoryOpenVikingGrepOptions = MemoryOpenVikingQueryOptions & {
  caseInsensitive?: boolean;
};

type MemoryOpenVikingPackImportOptions = MemoryOpenVikingQueryOptions & {
  force?: boolean;
  vectorize?: boolean;
};

type MemorySearchTraceOptions = MemoryOpenVikingQueryOptions & {
  save?: string;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];

type MemorySourceName = "memory" | "sessions";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function resolvePositiveNumberOption(value: number | undefined, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function resolveNonNegativeIntOption(value: number | undefined, label: string, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Math.floor(value);
}

function resolveFsOutputOption(raw: string | undefined): "agent" | "original" {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized || normalized === "agent") {
    return "agent";
  }
  if (normalized === "original") {
    return "original";
  }
  throw new Error('output must be "agent" or "original"');
}

function resolveSessionMessageRole(raw: string): "user" | "assistant" {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "user" || normalized === "assistant") {
    return normalized;
  }
  throw new Error('role must be "user" or "assistant"');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function renderOpenVikingSearchTraceSummary(search: Record<string, unknown>): string {
  const lines: string[] = ["OpenViking search trace (latest)", "Decision path:"];
  let sectionCount = 0;
  const strategy = asRecord(search.lastStrategy);
  if (strategy) {
    const strategyName =
      typeof strategy.strategy === "string" && strategy.strategy.trim() ? strategy.strategy : "unknown";
    const priority =
      typeof strategy.priority === "string" && strategy.priority.trim() ? strategy.priority : "unknown";
    const includeTypes = [
      strategy.includeResources === true ? "resources" : "",
      strategy.includeSkills === true ? "skills" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`${++sectionCount}) Strategy`);
    lines.push(`   - mode: ${strategyName}`);
    lines.push(`   - priority: ${priority}`);
    lines.push(`   - include: ${includeTypes || "none"}`);
  }
  const explain = asRecord(search.lastExplain);
  if (explain) {
    const typed = typeof explain.typedQueries === "number" ? explain.typedQueries : "n/a";
    const results = typeof explain.queryResults === "number" ? explain.queryResults : "n/a";
    const fallback = typeof explain.fallback === "string" ? explain.fallback : "none";
    const fallbackHits = typeof explain.fallbackHits === "number" ? explain.fallbackHits : 0;
    lines.push(`${++sectionCount}) Query plan`);
    lines.push(`   - typed queries: ${typed}`);
    lines.push(`   - query hits: ${results}`);
    lines.push(`   - fallback: ${fallback} (hits=${fallbackHits})`);
  }
  const layering = asRecord(search.lastLayering);
  if (layering) {
    const requested =
      typeof layering.requestedLayer === "string" && layering.requestedLayer.trim()
        ? layering.requestedLayer
        : "unknown";
    const l0 = typeof layering.l0 === "number" ? layering.l0 : 0;
    const l1 = typeof layering.l1 === "number" ? layering.l1 : 0;
    const l2 = typeof layering.l2 === "number" ? layering.l2 : 0;
    const truncated = layering.truncatedByBudget === true ? "yes" : "no";
    lines.push(`${++sectionCount}) Layering`);
    lines.push(`   - requested: ${requested}`);
    lines.push(`   - hits: L0=${l0}, L1=${l1}, L2=${l2}`);
    lines.push(`   - budget truncated: ${truncated}`);
  }
  const relations = asRecord(search.lastRelations);
  if (relations) {
    const direct = typeof relations.directSelected === "number" ? relations.directSelected : 0;
    const expanded = typeof relations.relationSelected === "number" ? relations.relationSelected : 0;
    const discovered = typeof relations.discovered === "number" ? relations.discovered : 0;
    lines.push(`${++sectionCount}) Relation expansion`);
    lines.push(`   - direct selected: ${direct}`);
    lines.push(`   - relation selected: ${expanded}`);
    lines.push(`   - discovered: ${discovered}`);
  }
  const ranking = asRecord(search.lastRanking);
  if (ranking) {
    const total = typeof ranking.totalCandidates === "number" ? ranking.totalCandidates : 0;
    const selected = typeof ranking.selectedCandidates === "number" ? ranking.selectedCandidates : 0;
    const emitted = typeof ranking.emittedCandidates === "number" ? ranking.emittedCandidates : 0;
    const droppedBudget = typeof ranking.droppedByBudget === "number" ? ranking.droppedByBudget : 0;
    lines.push(`${++sectionCount}) Ranking`);
    lines.push(`   - total candidates: ${total}`);
    lines.push(`   - selected candidates: ${selected}`);
    lines.push(`   - emitted candidates: ${emitted}`);
    lines.push(`   - dropped by budget: ${droppedBudget}`);
    lines.push(
      `Result: emitted ${emitted}/${total} candidates after ranking${droppedBudget > 0 ? ` (budget dropped ${droppedBudget})` : ""}.`,
    );
  }
  if (sectionCount === 0) {
    lines.push("No trace sections captured yet.");
  }
  return lines.join("\n");
}

function renderOpenVikingResult(result: unknown, asJson: boolean | undefined): void {
  if (asJson) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  if (Array.isArray(result) && result.every((entry) => typeof entry === "string")) {
    defaultRuntime.log(result.join("\n"));
    return;
  }
  defaultRuntime.log(JSON.stringify(result, null, 2));
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("payload cannot be empty");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "null" || trimmed === "true" || trimmed === "false") {
    return JSON.parse(trimmed);
  }
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && String(asNumber) === trimmed) {
    return asNumber;
  }
  return value;
}

async function resolveSkillPayload(opts: MemoryIngestSkillOptions): Promise<unknown> {
  const data = opts.data?.trim();
  const file = opts.file?.trim();
  if (!data && !file) {
    throw new Error("provide --data or --file for skill ingest");
  }
  if (data && file) {
    throw new Error("use either --data or --file, not both");
  }
  if (file) {
    const raw = await fs.readFile(file, "utf-8");
    return tryParseJson(raw);
  }
  return tryParseJson(data ?? "");
}

function renderIngestReceipt(params: {
  receipt: OpenVikingIngestReceipt;
  agentId: string;
  targetHint?: string;
}): string {
  const kindLabel = params.receipt.kind === "resource" ? "resource" : "skill";
  const suffix = params.targetHint ? ` · ${params.targetHint}` : "";
  const waitLabel = params.receipt.waited ? "processed" : "queued";
  return `OpenViking ${kindLabel} ingest (${params.agentId}) · ${waitLabel} · attempts ${params.receipt.attempts}${suffix}`;
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

async function withMemoryManagerForAgent(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: params.cfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: params.run,
  });
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  if (alt.issue) {
    issues.push(alt.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
      if (alt.exists) {
        files.add(altMemoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function summarizeQmdIndexArtifact(manager: MemoryManager): Promise<string | null> {
  const status = manager.status?.();
  if (!status || status.backend !== "qmd") {
    return null;
  }
  const dbPath = status.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
    }
    throw new Error(
      `QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`,
      { cause: err },
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
  }
  return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "default" : "status";
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: managerPurpose,
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            })
          : undefined;
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Search, inspect, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw memory status", "Show index and provider status."],
          ["openclaw memory index --force", "Force a full reindex."],
          ['openclaw memory search --query "deployment notes"', "Search indexed memory entries."],
          ["openclaw memory ingest-resource ./docs/runbook.md --wait", "Ingest a resource into OpenViking."],
          ['openclaw memory ingest-skill --data \'{"name":"incident-playbook"}\' --wait', "Ingest a skill payload."],
          ["openclaw memory find \"deploy config path\" --limit 8", "Semantic find without session context."],
          [
            "openclaw memory grep viking://resources \"OPENAI_API_KEY\" --case-insensitive",
            "Keyword grep over OpenViking FS.",
          ],
          ["openclaw memory glob \"**/*.md\" --uri viking://resources", "Glob match over OpenViking FS."],
          ["openclaw memory sessions-list --json", "List OpenViking sessions."],
          [
            "openclaw memory sessions-message sid-123 user \"remember this preference\"",
            "Append a user/assistant message into an OpenViking session.",
          ],
          [
            "openclaw memory search-trace --save /tmp/openviking-trace.json",
            "Show and export the latest OpenViking retrieval trace snapshot.",
          ],
          [
            "openclaw memory pack-export viking://resources/docs /tmp/docs.ovpack",
            "Export OpenViking context to an ovpack file.",
          ],
          [
            "openclaw memory pack-import /tmp/docs.ovpack viking://resources --force",
            "Import an ovpack file into OpenViking.",
          ],
          ["openclaw memory fs-ls viking://resources --recursive", "List OpenViking filesystem entries."],
          ["openclaw memory fs-mkdir viking://resources/docs/new-folder", "Create a directory in OpenViking FS (policy gated)."],
          [
            "openclaw memory fs-rm viking://resources/docs/old-folder --yes",
            "Remove a path in OpenViking FS (policy gated).",
          ],
          [
            "openclaw memory fs-mv viking://resources/docs/draft viking://resources/docs/archive/draft",
            "Move a path in OpenViking FS (policy gated).",
          ],
          ["openclaw memory relations viking://resources/docs/guide", "Inspect OpenViking relations."],
          ["openclaw memory status --json", "Output machine-readable JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            try {
              const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = (status.sources ?? []).map((source) =>
                  formatSourceLabel(source, status.workspaceDir ?? "", agentId),
                );
                const extraPaths = status.workspaceDir
                  ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
                  : [];
                const requestedProvider = status.requestedProvider ?? status.provider;
                const modelLabel = status.model ?? status.provider;
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(modelLabel)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) {
                  return null;
                }
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) {
                  return null;
                }
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              if (!syncFn) {
                defaultRuntime.log("Memory backend does not support manual reindex.");
                return;
              }
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await syncFn({
                      reason: "cli",
                      force: Boolean(opts.force),
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) {
                          lastLabel = syncUpdate.label;
                        }
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
              if (qmdIndexSummary) {
                defaultRuntime.log(qmdIndexSummary);
              }
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        query: string,
        opts: MemoryCommandOptions & {
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );

  memory
    .command("search-trace")
    .description("Show latest OpenViking retrieval trace snapshot")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--save <path>", "Write trace snapshot JSON to file")
    .option("--json", "Print JSON")
    .action(async (opts: MemorySearchTraceOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      await withMemoryManagerForAgent({
        cfg,
        agentId,
        run: async (manager) => {
          const status = manager.status();
          const custom = asRecord(status.custom);
          const search = asRecord(custom?.search);
          const payload = {
            agentId,
            backend: status.backend,
            capturedAt: new Date().toISOString(),
            search,
          };
          if (opts.save?.trim()) {
            const savePath = path.resolve(opts.save.trim());
            await fs.mkdir(path.dirname(savePath), { recursive: true });
            await fs.writeFile(savePath, JSON.stringify(payload, null, 2), "utf-8");
            if (!opts.json) {
              defaultRuntime.log(`OpenViking trace saved: ${shortenHomePath(savePath)}`);
            }
          }
          if (!search) {
            if (opts.json) {
              defaultRuntime.log(JSON.stringify(payload, null, 2));
              return;
            }
            defaultRuntime.log("No OpenViking search trace available yet.");
            return;
          }
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(payload, null, 2));
            return;
          }
          defaultRuntime.log(renderOpenVikingSearchTraceSummary(search));
        },
      });
    });

  memory
    .command("find")
    .description("Semantic find via OpenViking search/find (without session context)")
    .argument("<query>", "Find query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--target-uri <uri>", "Optional OpenViking target URI")
    .option("--limit <n>", "Max results", (value: string) => Number(value))
    .option("--score-threshold <n>", "Minimum score threshold", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (query: string, opts: MemoryOpenVikingFindOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const limit = resolvePositiveNumberOption(opts.limit, "limit");
        const scoreThreshold = opts.scoreThreshold;
        if (scoreThreshold != null && !Number.isFinite(scoreThreshold)) {
          throw new Error("score-threshold must be a number");
        }
        const result = await findOpenVikingContext({
          cfg,
          agentId,
          query,
          targetUri: opts.targetUri?.trim() || undefined,
          limit: limit == null ? undefined : Math.floor(limit),
          scoreThreshold: scoreThreshold == null ? undefined : scoreThreshold,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking find failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("grep")
    .description("Pattern grep via OpenViking search/grep")
    .argument("<uri>", "Viking URI to grep in")
    .argument("<pattern>", "Pattern to grep")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--case-insensitive", "Case-insensitive grep")
    .option("--json", "Print JSON")
    .action(async (uri: string, pattern: string, opts: MemoryOpenVikingGrepOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await grepOpenVikingContext({
          cfg,
          agentId,
          uri,
          pattern,
          caseInsensitive: opts.caseInsensitive === true,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking grep failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("glob")
    .description("Glob match via OpenViking search/glob")
    .argument("<pattern>", "Glob pattern (for example: **/*.md)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--uri <uri>", "Base URI (default: viking://)")
    .option("--json", "Print JSON")
    .action(async (pattern: string, opts: MemoryOpenVikingGlobOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await globOpenVikingContext({
          cfg,
          agentId,
          pattern,
          uri: opts.uri?.trim() || "viking://",
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking glob failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("sessions-list")
    .description("List OpenViking sessions")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await listOpenVikingSessions({
          cfg,
          agentId,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking sessions-list failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("sessions-get")
    .description("Get OpenViking session details")
    .argument("<sessionId>", "OpenViking session id")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await getOpenVikingSession({
          cfg,
          agentId,
          sessionId,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking sessions-get failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("sessions-delete")
    .description("Delete an OpenViking session")
    .argument("<sessionId>", "OpenViking session id")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await deleteOpenVikingSession({
          cfg,
          agentId,
          sessionId,
        });
        if (opts.json) {
          renderOpenVikingResult(result, true);
          return;
        }
        defaultRuntime.log(`OpenViking session deleted (${agentId}) · ${sessionId}`);
      } catch (err) {
        defaultRuntime.error(`OpenViking sessions-delete failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("sessions-extract")
    .description("Extract memories from an OpenViking session")
    .argument("<sessionId>", "OpenViking session id")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await extractOpenVikingSession({
          cfg,
          agentId,
          sessionId,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking sessions-extract failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("sessions-message")
    .description("Append a user/assistant message to an OpenViking session")
    .argument("<sessionId>", "OpenViking session id")
    .argument("<role>", 'Message role: "user" or "assistant"')
    .argument("<content>", "Message content")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(
      async (
        sessionId: string,
        role: string,
        content: string,
        opts: MemoryOpenVikingQueryOptions,
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        try {
          const result = await addOpenVikingSessionMessage({
            cfg,
            agentId,
            sessionId,
            role: resolveSessionMessageRole(role),
            content,
          });
          if (opts.json) {
            renderOpenVikingResult(result, true);
            return;
          }
          defaultRuntime.log(`OpenViking session message appended (${agentId}) · ${sessionId}`);
        } catch (err) {
          defaultRuntime.error(`OpenViking sessions-message failed: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
        }
      },
    );

  memory
    .command("pack-export")
    .description("Export OpenViking context to an ovpack file")
    .argument("<uri>", "OpenViking URI to export")
    .argument("<to>", "Output ovpack file path")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (uri: string, to: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await exportOpenVikingPack({
          cfg,
          agentId,
          uri,
          to,
        });
        if (opts.json) {
          renderOpenVikingResult(result, true);
          return;
        }
        const file = typeof result.file === "string" ? result.file : to;
        defaultRuntime.log(`OpenViking pack exported (${agentId}) · ${uri} -> ${file}`);
      } catch (err) {
        defaultRuntime.error(`OpenViking pack-export failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("pack-import")
    .description("Import an ovpack file into OpenViking")
    .argument("<filePath>", "Input ovpack file path")
    .argument("<parent>", "Target parent URI")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Overwrite existing content when supported")
    .option("--no-vectorize", "Skip vectorization after import")
    .option("--json", "Print JSON")
    .action(
      async (
        filePath: string,
        parent: string,
        opts: MemoryOpenVikingPackImportOptions,
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        try {
          const result = await importOpenVikingPack({
            cfg,
            agentId,
            filePath,
            parent,
            force: opts.force === true,
            vectorize: opts.vectorize !== false,
          });
          if (opts.json) {
            renderOpenVikingResult(result, true);
            return;
          }
          const uri = typeof result.uri === "string" ? result.uri : parent;
          defaultRuntime.log(`OpenViking pack imported (${agentId}) · ${filePath} -> ${uri}`);
        } catch (err) {
          defaultRuntime.error(`OpenViking pack-import failed: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
        }
      },
    );

  memory
    .command("ingest-resource")
    .description("Ingest a resource into OpenViking memory backend")
    .argument("<path>", "Resource file path or URL")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--target <uri>", "Optional OpenViking target URI")
    .option("--reason <text>", "Ingest reason", "cli memory ingest-resource")
    .option("--instruction <text>", "Optional ingest instruction")
    .option("--no-wait", "Do not wait for processing completion")
    .option("--timeout <sec>", "Wait timeout in seconds", (value: string) => Number(value))
    .option("--retries <n>", "Retry count for transient failures", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (resourcePath: string, opts: MemoryIngestResourceOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const timeoutSec = resolvePositiveNumberOption(opts.timeout, "timeout");
        const retries = resolveNonNegativeIntOption(opts.retries, "retries", 2);
        const receipt = await ingestOpenVikingResource({
          cfg,
          agentId,
          path: resourcePath,
          target: opts.target?.trim() || undefined,
          reason: opts.reason ?? "cli memory ingest-resource",
          instruction: opts.instruction ?? "",
          wait: opts.wait !== false,
          timeoutSec,
          retries,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(receipt, null, 2));
          return;
        }
        const uri = typeof receipt.payload.uri === "string" ? receipt.payload.uri : undefined;
        defaultRuntime.log(
          renderIngestReceipt({
            receipt,
            agentId,
            targetHint: uri,
          }),
        );
      } catch (err) {
        defaultRuntime.error(`OpenViking resource ingest failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("ingest-skill")
    .description("Ingest a skill payload into OpenViking memory backend")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--data <value>", "Skill payload (JSON string, plain string, or number)")
    .option("--file <path>", "Read skill payload from file")
    .option("--no-wait", "Do not wait for processing completion")
    .option("--timeout <sec>", "Wait timeout in seconds", (value: string) => Number(value))
    .option("--retries <n>", "Retry count for transient failures", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (opts: MemoryIngestSkillOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const data = await resolveSkillPayload(opts);
        const timeoutSec = resolvePositiveNumberOption(opts.timeout, "timeout");
        const retries = resolveNonNegativeIntOption(opts.retries, "retries", 2);
        const receipt = await ingestOpenVikingSkill({
          cfg,
          agentId,
          data,
          wait: opts.wait !== false,
          timeoutSec,
          retries,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(receipt, null, 2));
          return;
        }
        const uri = typeof receipt.payload.uri === "string" ? receipt.payload.uri : undefined;
        defaultRuntime.log(
          renderIngestReceipt({
            receipt,
            agentId,
            targetHint: uri,
          }),
        );
      } catch (err) {
        defaultRuntime.error(`OpenViking skill ingest failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("fs-ls")
    .description("List OpenViking filesystem entries")
    .argument("<uri>", "Viking URI to list")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--simple", "Return only relative path list")
    .option("--recursive", "List recursively")
    .option("--output <mode>", 'Output format: "agent" or "original"', "agent")
    .option("--abs-limit <n>", "Abstract limit for agent output", (value: string) => Number(value))
    .option("--show-all-hidden", "Include hidden files")
    .option("--json", "Print JSON")
    .action(async (uri: string, opts: MemoryOpenVikingFsLsOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const absLimit = resolvePositiveNumberOption(opts.absLimit, "abs-limit");
        const result = await listOpenVikingFs({
          cfg,
          agentId,
          uri,
          simple: opts.simple === true,
          recursive: opts.recursive === true,
          output: resolveFsOutputOption(opts.output),
          absLimit: absLimit == null ? undefined : Math.floor(absLimit),
          showAllHidden: opts.showAllHidden === true,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking fs-ls failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("fs-tree")
    .description("Show OpenViking filesystem tree")
    .argument("<uri>", "Viking URI to inspect")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--output <mode>", 'Output format: "agent" or "original"', "agent")
    .option("--abs-limit <n>", "Abstract limit for agent output", (value: string) => Number(value))
    .option("--show-all-hidden", "Include hidden files")
    .option("--json", "Print JSON")
    .action(async (uri: string, opts: MemoryOpenVikingFsOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const absLimit = resolvePositiveNumberOption(opts.absLimit, "abs-limit");
        const result = await treeOpenVikingFs({
          cfg,
          agentId,
          uri,
          output: resolveFsOutputOption(opts.output),
          absLimit: absLimit == null ? undefined : Math.floor(absLimit),
          showAllHidden: opts.showAllHidden === true,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking fs-tree failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("fs-stat")
    .description("Read OpenViking filesystem stat for a URI")
    .argument("<uri>", "Viking URI")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (uri: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await statOpenVikingFs({
          cfg,
          agentId,
          uri,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking fs-stat failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("fs-mkdir")
    .description("Create OpenViking filesystem directory (policy gated)")
    .argument("<uri>", "Viking URI to create")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (uri: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await mkdirOpenVikingFs({
          cfg,
          agentId,
          uri,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`OpenViking fs mkdir (${agentId}) · ${uri}`);
      } catch (err) {
        defaultRuntime.error(`OpenViking fs-mkdir failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("fs-rm")
    .description("Remove OpenViking filesystem path (policy gated)")
    .argument("<uri>", "Viking URI to remove")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--recursive", "Remove recursively")
    .option("--yes", "Confirm removal")
    .option("--json", "Print JSON")
    .action(async (uri: string, opts: MemoryOpenVikingFsRmOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        if (opts.yes !== true) {
          throw new Error("fs-rm requires --yes confirmation");
        }
        const result = await rmOpenVikingFs({
          cfg,
          agentId,
          uri,
          recursive: opts.recursive === true,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`OpenViking fs rm (${agentId}) · ${uri}`);
      } catch (err) {
        defaultRuntime.error(`OpenViking fs-rm failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("fs-mv")
    .description("Move OpenViking filesystem path (policy gated)")
    .argument("<fromUri>", "Source Viking URI")
    .argument("<toUri>", "Target Viking URI")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (fromUri: string, toUri: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await mvOpenVikingFs({
          cfg,
          agentId,
          fromUri,
          toUri,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`OpenViking fs mv (${agentId}) · ${fromUri} -> ${toUri}`);
      } catch (err) {
        defaultRuntime.error(`OpenViking fs-mv failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("relations")
    .description("List OpenViking relations for a URI")
    .argument("<uri>", "Viking URI")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (uri: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await listOpenVikingRelations({
          cfg,
          agentId,
          uri,
        });
        renderOpenVikingResult(result, opts.json);
      } catch (err) {
        defaultRuntime.error(`OpenViking relations failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("relation-link")
    .description("Create OpenViking relation link(s)")
    .argument("<fromUri>", "Source Viking URI")
    .argument("<toUris...>", "Target Viking URI(s)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--reason <text>", "Reason for relation link")
    .option("--json", "Print JSON")
    .action(async (fromUri: string, toUris: string[], opts: MemoryOpenVikingRelationLinkOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        if (!toUris.length) {
          throw new Error("at least one toUri is required");
        }
        const result = await linkOpenVikingRelation({
          cfg,
          agentId,
          fromUri,
          toUris: toUris.length === 1 ? toUris[0] ?? "" : toUris,
          reason: opts.reason ?? "",
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(
          `OpenViking relation linked (${agentId}) · ${fromUri} -> ${toUris.length} target(s)`,
        );
      } catch (err) {
        defaultRuntime.error(`OpenViking relation-link failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("relation-unlink")
    .description("Remove an OpenViking relation link")
    .argument("<fromUri>", "Source Viking URI")
    .argument("<toUri>", "Target Viking URI to unlink")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (fromUri: string, toUri: string, opts: MemoryOpenVikingQueryOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      try {
        const result = await unlinkOpenVikingRelation({
          cfg,
          agentId,
          fromUri,
          toUri,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`OpenViking relation unlinked (${agentId}) · ${fromUri} -> ${toUri}`);
      } catch (err) {
        defaultRuntime.error(`OpenViking relation-unlink failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });
}
