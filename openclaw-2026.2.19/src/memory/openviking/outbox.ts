import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenVikingSessionEvent } from "./client.js";

const log = createSubsystemLogger("memory/openviking/outbox");

type OpenVikingOutboxItem = {
  id: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  sessionKey: string;
  sessionId: string;
  events: OpenVikingSessionEvent[];
};

export type OpenVikingOutboxStats = {
  depth: number;
  oldestAgeMs?: number;
  readyNow?: number;
  nextReadyInMs?: number;
  lastFlushAt?: number;
  lastEnqueueAt?: number;
  lastSuccessAt?: number;
  lastFlushDurationMs?: number;
  lastFlushSent?: number;
  lastFlushErrors?: number;
  maxAttempts?: number;
  totalEnqueued?: number;
  totalSent?: number;
  totalFailed?: number;
  lastError?: string;
};

export class OpenVikingOutbox {
  private readonly filePath: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private loaded = false;
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private items: OpenVikingOutboxItem[] = [];
  private lastFlushAt?: number;
  private lastEnqueueAt?: number;
  private lastSuccessAt?: number;
  private lastFlushDurationMs?: number;
  private lastFlushSent = 0;
  private lastFlushErrors = 0;
  private totalEnqueued = 0;
  private totalSent = 0;
  private totalFailed = 0;
  private lastError?: string;

  constructor(params: {
    filePath: string;
    flushIntervalMs: number;
    maxBatchSize: number;
    retryBaseMs: number;
    retryMaxMs: number;
    sender: (payload: { sessionId: string; events: OpenVikingSessionEvent[] }) => Promise<void>;
  }) {
    this.filePath = path.resolve(params.filePath);
    this.flushIntervalMs = Math.max(500, params.flushIntervalMs);
    this.maxBatchSize = Math.max(1, params.maxBatchSize);
    this.retryBaseMs = Math.max(250, params.retryBaseMs);
    this.retryMaxMs = Math.max(this.retryBaseMs, params.retryMaxMs);
    this.sender = params.sender;
  }

  private readonly sender: (payload: {
    sessionId: string;
    events: OpenVikingSessionEvent[];
  }) => Promise<void>;

  async start(): Promise<void> {
    await this.load();
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async enqueue(params: {
    sessionKey: string;
    sessionId: string;
    events: OpenVikingSessionEvent[];
  }): Promise<number> {
    if (!params.events.length) {
      return this.items.length;
    }
    await this.load();
    const now = Date.now();
    const item: OpenVikingOutboxItem = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: now,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      events: params.events,
    };
    this.items.push(item);
    this.lastEnqueueAt = now;
    this.totalEnqueued += 1;
    await this.persist();
    return this.items.length;
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    await this.load();
    this.flushing = true;
    try {
      const flushStartedAt = Date.now();
      const now = Date.now();
      let sent = 0;
      let errors = 0;
      for (const item of this.items) {
        if (sent >= this.maxBatchSize) {
          break;
        }
        if (item.nextAttemptAt > now) {
          continue;
        }
        try {
          await this.sender({
            sessionId: item.sessionId,
            events: item.events,
          });
          item.attempts = -1;
          sent += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.lastError = message;
          errors += 1;
          this.totalFailed += 1;
          const attempts = item.attempts + 1;
          const retryDelay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attempts - 1));
          item.attempts = attempts;
          item.updatedAt = now;
          item.nextAttemptAt = now + retryDelay;
          log.warn(
            `flush failed: session=${item.sessionId} attempts=${attempts} retryInMs=${retryDelay} error=${message}`,
          );
        }
      }
      if (sent > 0) {
        this.items = this.items.filter((item) => item.attempts >= 0);
        this.totalSent += sent;
        this.lastSuccessAt = Date.now();
      }
      const flushEndedAt = Date.now();
      this.lastFlushAt = flushEndedAt;
      this.lastFlushDurationMs = flushEndedAt - flushStartedAt;
      this.lastFlushSent = sent;
      this.lastFlushErrors = errors;
      if (sent > 0 && errors === 0) {
        this.lastError = undefined;
      }
      await this.persist();
    } finally {
      this.flushing = false;
    }
  }

  getStats(): OpenVikingOutboxStats {
    const depth = this.items.length;
    const now = Date.now();
    const oldestCreatedAt = depth > 0 ? Math.min(...this.items.map((item) => item.createdAt)) : undefined;
    const readyNow = depth > 0 ? this.items.filter((item) => item.nextAttemptAt <= now).length : 0;
    const nextAttemptAt = depth > 0 ? Math.min(...this.items.map((item) => item.nextAttemptAt)) : undefined;
    const maxAttempts = depth > 0 ? Math.max(...this.items.map((item) => Math.max(0, item.attempts))) : 0;
    return {
      depth,
      oldestAgeMs: oldestCreatedAt ? now - oldestCreatedAt : undefined,
      readyNow,
      nextReadyInMs: nextAttemptAt !== undefined ? Math.max(0, nextAttemptAt - now) : undefined,
      lastFlushAt: this.lastFlushAt,
      lastEnqueueAt: this.lastEnqueueAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFlushDurationMs: this.lastFlushDurationMs,
      lastFlushSent: this.lastFlushSent,
      lastFlushErrors: this.lastFlushErrors,
      maxAttempts: maxAttempts > 0 ? maxAttempts : undefined,
      totalEnqueued: this.totalEnqueued,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      lastError: this.lastError,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: OpenVikingOutboxItem[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const item = JSON.parse(trimmed) as OpenVikingOutboxItem;
          if (!item?.id || !item.sessionId || !Array.isArray(item.events)) {
            continue;
          }
          parsed.push(item);
        } catch {
          // skip malformed lines
        }
      }
      this.items = parsed;
      if (this.totalEnqueued < parsed.length) {
        this.totalEnqueued = parsed.length;
      }
    } catch {
      this.items = [];
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const content =
      this.items.length > 0 ? `${this.items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
    await fs.writeFile(this.filePath, content, "utf8");
  }
}
