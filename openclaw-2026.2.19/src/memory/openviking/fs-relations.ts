import type { OpenClawConfig } from "../../config/config.js";
import { resolveMemoryBackendConfig, type ResolvedOpenVikingConfig } from "../backend-config.js";
import {
  OpenVikingClient,
  type OpenVikingSearchResult,
  type OpenVikingFsOutputMode,
} from "./client.js";

export type OpenVikingFsLsQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
  simple?: boolean;
  recursive?: boolean;
  output?: OpenVikingFsOutputMode;
  absLimit?: number;
  showAllHidden?: boolean;
};

export type OpenVikingFsTreeQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
  output?: OpenVikingFsOutputMode;
  absLimit?: number;
  showAllHidden?: boolean;
};

export type OpenVikingFsStatQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
};

export type OpenVikingFsMkdirQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
};

export type OpenVikingFsRmQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
  recursive?: boolean;
};

export type OpenVikingFsMvQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  fromUri: string;
  toUri: string;
};

export type OpenVikingRelationsQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
};

export type OpenVikingRelationLinkParams = {
  cfg: OpenClawConfig;
  agentId: string;
  fromUri: string;
  toUris: string | string[];
  reason?: string;
};

export type OpenVikingRelationUnlinkParams = {
  cfg: OpenClawConfig;
  agentId: string;
  fromUri: string;
  toUri: string;
};

export type OpenVikingFindQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  targetUri?: string;
  limit?: number;
  scoreThreshold?: number;
};

export type OpenVikingGrepQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
  pattern: string;
  caseInsensitive?: boolean;
};

export type OpenVikingGlobQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  pattern: string;
  uri?: string;
};

export type OpenVikingSessionsListQuery = {
  cfg: OpenClawConfig;
  agentId: string;
};

export type OpenVikingSessionQuery = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
};

export type OpenVikingSessionMessageParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
};

export type OpenVikingPackExportParams = {
  cfg: OpenClawConfig;
  agentId: string;
  uri: string;
  to: string;
};

export type OpenVikingPackImportParams = {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
  parent: string;
  force?: boolean;
  vectorize?: boolean;
};

function resolveOpenVikingContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): {
  client: OpenVikingClient;
  resolved: ResolvedOpenVikingConfig;
} {
  const resolved = resolveMemoryBackendConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (resolved.backend !== "openviking" || !resolved.openviking) {
    throw new Error(`memory backend is ${resolved.backend}; openviking backend required`);
  }
  return {
    client: new OpenVikingClient(resolved.openviking),
    resolved: resolved.openviking,
  };
}

function normalizePolicyUri(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  if (!trimmed.startsWith("viking://")) {
    throw new Error(`${label} must start with "viking://"`);
  }
  if (trimmed === "viking://") {
    return trimmed;
  }
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized || "viking://";
}

function uriMatchesPrefix(uri: string, prefix: string): boolean {
  if (prefix === "viking://") {
    return true;
  }
  return uri === prefix || uri.startsWith(`${prefix}/`);
}

function normalizePolicyRuleList(values: string[] | undefined, label: string): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => normalizePolicyUri(value, label));
}

export function enforceOpenVikingFsWritePolicy(params: {
  resolved: ResolvedOpenVikingConfig;
  uri: string;
  operation: "mkdir" | "rm" | "mv";
  recursive?: boolean;
}): string {
  const fsWrite = params.resolved.fsWrite;
  if (!fsWrite?.enabled) {
    throw new Error(
      "OpenViking fs write is disabled by policy. Set memory.openviking.fsWrite.enabled=true to enable.",
    );
  }
  if (params.operation === "rm" && params.recursive === true && fsWrite.allowRecursiveRm !== true) {
    throw new Error(
      "OpenViking fs-rm --recursive is disabled by policy. Set memory.openviking.fsWrite.allowRecursiveRm=true to enable.",
    );
  }

  const uri = normalizePolicyUri(params.uri, "uri");
  const allowUriPrefixes = normalizePolicyRuleList(
    fsWrite.allowUriPrefixes,
    "memory.openviking.fsWrite.allowUriPrefixes",
  );
  if (allowUriPrefixes.length === 0) {
    throw new Error(
      "OpenViking fs write policy requires memory.openviking.fsWrite.allowUriPrefixes to be configured.",
    );
  }

  const denyUriPrefixes = normalizePolicyRuleList(
    fsWrite.denyUriPrefixes,
    "memory.openviking.fsWrite.denyUriPrefixes",
  );
  const protectedUris = normalizePolicyRuleList(
    fsWrite.protectedUris,
    "memory.openviking.fsWrite.protectedUris",
  );

  if (protectedUris.includes(uri)) {
    throw new Error(`OpenViking fs write denied for protected uri: ${uri}`);
  }
  if (denyUriPrefixes.some((prefix) => uriMatchesPrefix(uri, prefix))) {
    throw new Error(`OpenViking fs write denied by denyUriPrefixes: ${uri}`);
  }
  if (!allowUriPrefixes.some((prefix) => uriMatchesPrefix(uri, prefix))) {
    throw new Error(`OpenViking fs write denied (uri not in allowUriPrefixes): ${uri}`);
  }
  return uri;
}

export async function listOpenVikingFs(params: OpenVikingFsLsQuery): Promise<unknown> {
  const { client } = resolveOpenVikingContext(params);
  return await client.fsLs({
    uri: params.uri,
    simple: params.simple,
    recursive: params.recursive,
    output: params.output,
    absLimit: params.absLimit,
    showAllHidden: params.showAllHidden,
  });
}

export async function treeOpenVikingFs(params: OpenVikingFsTreeQuery): Promise<unknown> {
  const { client } = resolveOpenVikingContext(params);
  return await client.fsTree({
    uri: params.uri,
    output: params.output,
    absLimit: params.absLimit,
    showAllHidden: params.showAllHidden,
  });
}

export async function statOpenVikingFs(params: OpenVikingFsStatQuery): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.fsStat(params.uri);
}

export async function mkdirOpenVikingFs(params: OpenVikingFsMkdirQuery): Promise<Record<string, unknown>> {
  const { client, resolved } = resolveOpenVikingContext(params);
  const uri = enforceOpenVikingFsWritePolicy({
    resolved,
    uri: params.uri,
    operation: "mkdir",
  });
  return await client.fsMkdir(uri);
}

export async function rmOpenVikingFs(params: OpenVikingFsRmQuery): Promise<Record<string, unknown>> {
  const { client, resolved } = resolveOpenVikingContext(params);
  const uri = enforceOpenVikingFsWritePolicy({
    resolved,
    uri: params.uri,
    operation: "rm",
    recursive: params.recursive,
  });
  return await client.fsRm({
    uri,
    recursive: params.recursive === true,
  });
}

export async function mvOpenVikingFs(params: OpenVikingFsMvQuery): Promise<Record<string, unknown>> {
  const { client, resolved } = resolveOpenVikingContext(params);
  const fromUri = enforceOpenVikingFsWritePolicy({
    resolved,
    uri: params.fromUri,
    operation: "mv",
  });
  const toUri = enforceOpenVikingFsWritePolicy({
    resolved,
    uri: params.toUri,
    operation: "mv",
  });
  if (fromUri === toUri) {
    throw new Error("fromUri and toUri must be different");
  }
  return await client.fsMv({
    fromUri,
    toUri,
  });
}

export async function listOpenVikingRelations(
  params: OpenVikingRelationsQuery,
): Promise<Array<{ uri?: string; reason?: string }>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.relations(params.uri);
}

export async function linkOpenVikingRelation(
  params: OpenVikingRelationLinkParams,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.linkRelation({
    fromUri: params.fromUri,
    toUris: params.toUris,
    reason: params.reason ?? "",
  });
}

export async function unlinkOpenVikingRelation(
  params: OpenVikingRelationUnlinkParams,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.unlinkRelation({
    fromUri: params.fromUri,
    toUri: params.toUri,
  });
}

export async function findOpenVikingContext(params: OpenVikingFindQuery): Promise<OpenVikingSearchResult> {
  const { client } = resolveOpenVikingContext(params);
  return await client.find({
    query: params.query,
    targetUri: params.targetUri,
    limit: params.limit,
    scoreThreshold: params.scoreThreshold,
  });
}

export async function grepOpenVikingContext(params: OpenVikingGrepQuery): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.grep({
    uri: params.uri,
    pattern: params.pattern,
    caseInsensitive: params.caseInsensitive,
  });
}

export async function globOpenVikingContext(params: OpenVikingGlobQuery): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.glob({
    pattern: params.pattern,
    uri: params.uri,
  });
}

export async function listOpenVikingSessions(
  params: OpenVikingSessionsListQuery,
): Promise<Array<Record<string, unknown>>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.listSessions();
}

export async function getOpenVikingSession(
  params: OpenVikingSessionQuery,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.getSession(params.sessionId);
}

export async function deleteOpenVikingSession(
  params: OpenVikingSessionQuery,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.deleteSession(params.sessionId);
}

export async function extractOpenVikingSession(
  params: OpenVikingSessionQuery,
): Promise<unknown> {
  const { client } = resolveOpenVikingContext(params);
  return await client.extractSession(params.sessionId);
}

export async function addOpenVikingSessionMessage(
  params: OpenVikingSessionMessageParams,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.addSessionMessage({
    sessionId: params.sessionId,
    role: params.role,
    content: params.content,
  });
}

export async function exportOpenVikingPack(
  params: OpenVikingPackExportParams,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.exportPack({
    uri: params.uri,
    to: params.to,
  });
}

export async function importOpenVikingPack(
  params: OpenVikingPackImportParams,
): Promise<Record<string, unknown>> {
  const { client } = resolveOpenVikingContext(params);
  return await client.importPack({
    filePath: params.filePath,
    parent: params.parent,
    force: params.force,
    vectorize: params.vectorize,
  });
}
