import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedOpenVikingConfig } from "../backend-config.js";

const log = createSubsystemLogger("memory/openviking/client");

type ApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type ApiResponse<T> = {
  status: "ok" | "error";
  result?: T;
  error?: ApiError;
};

export type OpenVikingMatchedContext = {
  uri: string;
  context_type: string;
  abstract?: string;
  overview?: string;
  score?: number;
  match_reason?: string;
};

export type OpenVikingSearchResult = {
  memories?: OpenVikingMatchedContext[];
  resources?: OpenVikingMatchedContext[];
  skills?: OpenVikingMatchedContext[];
  query_plan?: Record<string, unknown>;
  query_results?: Array<Record<string, unknown>>;
  total?: number;
};

export type OpenVikingFindParams = {
  query: string;
  targetUri?: string;
  limit?: number;
  scoreThreshold?: number;
  filter?: Record<string, unknown>;
};

export type OpenVikingGrepParams = {
  uri: string;
  pattern: string;
  caseInsensitive?: boolean;
};

export type OpenVikingGlobParams = {
  pattern: string;
  uri?: string;
};

export type OpenVikingSessionInfo = {
  session_id: string;
};

export type OpenVikingSessionEvent = {
  event_id: string;
  event_type: string;
  role?: string;
  content?: string;
  cause?: string;
  metadata?: Record<string, unknown>;
};

export type OpenVikingSessionMessageRole = "user" | "assistant";

export type OpenVikingPackExportParams = {
  uri: string;
  to: string;
};

export type OpenVikingPackImportParams = {
  filePath: string;
  parent: string;
  force?: boolean;
  vectorize?: boolean;
};

export type OpenVikingAddResourceParams = {
  path: string;
  target?: string;
  reason?: string;
  instruction?: string;
  wait?: boolean;
  timeout?: number;
};

export type OpenVikingAddSkillParams = {
  data: unknown;
  wait?: boolean;
  timeout?: number;
};

export type OpenVikingFsOutputMode = "agent" | "original";

export type OpenVikingFsLsParams = {
  uri: string;
  simple?: boolean;
  recursive?: boolean;
  output?: OpenVikingFsOutputMode;
  absLimit?: number;
  showAllHidden?: boolean;
};

export type OpenVikingFsTreeParams = {
  uri: string;
  output?: OpenVikingFsOutputMode;
  absLimit?: number;
  showAllHidden?: boolean;
};

export type OpenVikingFsRmParams = {
  uri: string;
  recursive?: boolean;
};

export type OpenVikingFsMvParams = {
  fromUri: string;
  toUri: string;
};

export type OpenVikingRelationEntry = {
  uri?: string;
  reason?: string;
};

export type OpenVikingLinkRelationParams = {
  fromUri: string;
  toUris: string | string[];
  reason?: string;
};

export type OpenVikingUnlinkRelationParams = {
  fromUri: string;
  toUri: string;
};

export type OpenVikingObserverComponentStatus = {
  name?: string;
  is_healthy?: boolean;
  has_errors?: boolean;
  status?: string;
};

export type OpenVikingObserverSystemStatus = {
  is_healthy?: boolean;
  errors?: string[];
  components?: Record<string, OpenVikingObserverComponentStatus>;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveHeaders(params: {
  config: ResolvedOpenVikingConfig;
  initHeaders?: HeadersInit;
  hasJsonBody?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const initHeaders = params.initHeaders;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, initHeaders);
    }
  }
  if (params.hasJsonBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (params.config.apiKey && !headers["X-API-Key"]) {
    headers["X-API-Key"] = params.config.apiKey;
  }
  Object.assign(headers, params.config.headers ?? {});
  return headers;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    query.set(key, String(value));
  });
  return query.toString();
}

export class OpenVikingClient {
  readonly endpoint: string;

  constructor(private readonly config: ResolvedOpenVikingConfig) {
    this.endpoint = trimTrailingSlash(config.endpoint);
  }

  async health(): Promise<boolean> {
    try {
      await this.request<unknown>("/health", { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  async createSession(): Promise<OpenVikingSessionInfo> {
    return await this.request<OpenVikingSessionInfo>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return await this.request<Array<Record<string, unknown>>>("/api/v1/sessions", {
      method: "GET",
    });
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
      },
    );
  }

  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
      },
    );
  }

  async extractSession(sessionId: string): Promise<unknown> {
    return await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/extract`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  async addSessionMessage(params: {
    sessionId: string;
    role: OpenVikingSessionMessageRole;
    content: string;
  }): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(params.sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          role: params.role,
          content: params.content,
        }),
      },
    );
  }

  async search(params: {
    query: string;
    sessionId?: string;
    targetUri?: string;
    limit?: number;
    scoreThreshold?: number;
  }): Promise<OpenVikingSearchResult> {
    return await this.request<OpenVikingSearchResult>("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify({
        query: params.query,
        target_uri: params.targetUri ?? "",
        session_id: params.sessionId,
        limit: params.limit,
        score_threshold: params.scoreThreshold,
      }),
    });
  }

  async find(params: OpenVikingFindParams): Promise<OpenVikingSearchResult> {
    return await this.request<OpenVikingSearchResult>("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify({
        query: params.query,
        target_uri: params.targetUri ?? "",
        limit: params.limit,
        score_threshold: params.scoreThreshold,
        filter: params.filter,
      }),
    });
  }

  async grep(params: OpenVikingGrepParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/search/grep", {
      method: "POST",
      body: JSON.stringify({
        uri: params.uri,
        pattern: params.pattern,
        case_insensitive: params.caseInsensitive === true,
      }),
    });
  }

  async glob(params: OpenVikingGlobParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/search/glob", {
      method: "POST",
      body: JSON.stringify({
        pattern: params.pattern,
        uri: params.uri ?? "viking://",
      }),
    });
  }

  async exportPack(params: OpenVikingPackExportParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/pack/export", {
      method: "POST",
      body: JSON.stringify({
        uri: params.uri,
        to: params.to,
      }),
    });
  }

  async importPack(params: OpenVikingPackImportParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/pack/import", {
      method: "POST",
      body: JSON.stringify({
        file_path: params.filePath,
        parent: params.parent,
        force: params.force === true,
        vectorize: params.vectorize !== false,
      }),
    });
  }

  async read(uri: string): Promise<string> {
    const query = new URLSearchParams({ uri }).toString();
    return await this.request<string>(`/api/v1/content/read?${query}`, {
      method: "GET",
    });
  }

  async abstract(uri: string): Promise<string> {
    const query = new URLSearchParams({ uri }).toString();
    return await this.request<string>(`/api/v1/content/abstract?${query}`, {
      method: "GET",
    });
  }

  async overview(uri: string): Promise<string> {
    const query = new URLSearchParams({ uri }).toString();
    return await this.request<string>(`/api/v1/content/overview?${query}`, {
      method: "GET",
    });
  }

  async addResource(params: OpenVikingAddResourceParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/resources", {
      method: "POST",
      body: JSON.stringify({
        path: params.path,
        target: params.target,
        reason: params.reason ?? "",
        instruction: params.instruction ?? "",
        wait: params.wait === true,
        timeout: params.timeout,
      }),
    });
  }

  async addSkill(params: OpenVikingAddSkillParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/skills", {
      method: "POST",
      body: JSON.stringify({
        data: params.data,
        wait: params.wait === true,
        timeout: params.timeout,
      }),
    });
  }

  async waitProcessed(params?: { timeout?: number }): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/system/wait", {
      method: "POST",
      body: JSON.stringify({
        timeout: params?.timeout,
      }),
    });
  }

  async fsLs(params: OpenVikingFsLsParams): Promise<unknown> {
    const query = buildQuery({
      uri: params.uri,
      simple: params.simple === true,
      recursive: params.recursive === true,
      output: params.output ?? "agent",
      abs_limit: params.absLimit,
      show_all_hidden: params.showAllHidden === true,
    });
    return await this.request<unknown>(`/api/v1/fs/ls?${query}`, {
      method: "GET",
    });
  }

  async fsTree(params: OpenVikingFsTreeParams): Promise<unknown> {
    const query = buildQuery({
      uri: params.uri,
      output: params.output ?? "agent",
      abs_limit: params.absLimit,
      show_all_hidden: params.showAllHidden === true,
    });
    return await this.request<unknown>(`/api/v1/fs/tree?${query}`, {
      method: "GET",
    });
  }

  async fsStat(uri: string): Promise<Record<string, unknown>> {
    const query = buildQuery({ uri });
    return await this.request<Record<string, unknown>>(`/api/v1/fs/stat?${query}`, {
      method: "GET",
    });
  }

  async fsMkdir(uri: string): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ uri }),
    });
  }

  async fsRm(params: OpenVikingFsRmParams): Promise<Record<string, unknown>> {
    const query = buildQuery({
      uri: params.uri,
      recursive: params.recursive === true,
    });
    return await this.request<Record<string, unknown>>(`/api/v1/fs?${query}`, {
      method: "DELETE",
    });
  }

  async fsMv(params: OpenVikingFsMvParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/fs/mv", {
      method: "POST",
      body: JSON.stringify({
        from_uri: params.fromUri,
        to_uri: params.toUri,
      }),
    });
  }

  async relations(uri: string): Promise<OpenVikingRelationEntry[]> {
    const query = buildQuery({ uri });
    return await this.request<OpenVikingRelationEntry[]>(`/api/v1/relations?${query}`, {
      method: "GET",
    });
  }

  async linkRelation(params: OpenVikingLinkRelationParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/relations/link", {
      method: "POST",
      body: JSON.stringify({
        from_uri: params.fromUri,
        to_uris: params.toUris,
        reason: params.reason ?? "",
      }),
    });
  }

  async unlinkRelation(params: OpenVikingUnlinkRelationParams): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("/api/v1/relations/link", {
      method: "DELETE",
      body: JSON.stringify({
        from_uri: params.fromUri,
        to_uri: params.toUri,
      }),
    });
  }

  async observerQueue(): Promise<OpenVikingObserverComponentStatus> {
    return await this.request<OpenVikingObserverComponentStatus>("/api/v1/observer/queue", {
      method: "GET",
    });
  }

  async observerVikingdb(): Promise<OpenVikingObserverComponentStatus> {
    return await this.request<OpenVikingObserverComponentStatus>("/api/v1/observer/vikingdb", {
      method: "GET",
    });
  }

  async observerVlm(): Promise<OpenVikingObserverComponentStatus> {
    return await this.request<OpenVikingObserverComponentStatus>("/api/v1/observer/vlm", {
      method: "GET",
    });
  }

  async observerTransaction(): Promise<OpenVikingObserverComponentStatus> {
    return await this.request<OpenVikingObserverComponentStatus>("/api/v1/observer/transaction", {
      method: "GET",
    });
  }

  async observerSystem(): Promise<OpenVikingObserverSystemStatus> {
    return await this.request<OpenVikingObserverSystemStatus>("/api/v1/observer/system", {
      method: "GET",
    });
  }

  async addEventsBatch(params: {
    sessionId: string;
    events: OpenVikingSessionEvent[];
  }): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(params.sessionId)}/events/batch`,
      {
        method: "POST",
        body: JSON.stringify({ events: params.events }),
      },
    );
  }

  async commitSession(params: {
    sessionId: string;
    cause?: string;
  }): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(params.sessionId)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({ cause: params.cause ?? "manual" }),
      },
    );
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const hasJsonBody = typeof init.body === "string";
      const headers = resolveHeaders({
        config: this.config,
        initHeaders: init.headers,
        hasJsonBody,
      });
      const response = await fetch(`${this.endpoint}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: ApiResponse<T> | null = null;
      if (text.trim().length > 0) {
        try {
          payload = JSON.parse(text) as ApiResponse<T>;
        } catch (err) {
          throw new Error(`openviking response is not valid JSON (${String(err)})`, {
            cause: err,
          });
        }
      }

      if (!response.ok) {
        const detail = payload?.error?.message ?? (text || response.statusText);
        throw new Error(`openviking request failed (${response.status}): ${detail}`);
      }
      if (!payload || payload.status !== "ok") {
        const detail = payload?.error?.message ?? "unknown error";
        throw new Error(`openviking returned error: ${detail}`);
      }
      return payload.result ?? ({} as T);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`request failed: path=${path} error=${message}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
