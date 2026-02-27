import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenVikingSessionEvent } from "./client.js";
import { OpenVikingOutbox } from "./outbox.js";

function createMessageEvent(id: string): OpenVikingSessionEvent {
  return {
    event_id: id,
    event_type: "message",
    role: "user",
    content: "hello",
  };
}

describe("openviking outbox stats", () => {
  it("tracks retry and flush timing metrics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openviking-outbox-test-"));
    const outboxPath = path.join(tempDir, "main.jsonl");
    let attempts = 0;
    const outbox = new OpenVikingOutbox({
      filePath: outboxPath,
      flushIntervalMs: 500,
      maxBatchSize: 5,
      retryBaseMs: 1,
      retryMaxMs: 10,
      sender: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    try {
      await outbox.enqueue({
        sessionKey: "agent:main:main",
        sessionId: "ov-session",
        events: [createMessageEvent("evt-1")],
      });
      const queued = outbox.getStats();
      expect(queued.depth).toBe(1);
      expect(queued.readyNow).toBe(1);
      expect(queued.totalEnqueued).toBe(1);
      expect(typeof queued.lastEnqueueAt).toBe("number");

      await outbox.flush();
      const failed = outbox.getStats();
      expect(failed.depth).toBe(1);
      expect(failed.totalFailed).toBe(1);
      expect(failed.lastFlushErrors).toBe(1);
      expect(failed.lastError).toContain("temporary failure");
      expect(typeof failed.nextReadyInMs).toBe("number");

      const waitMs = Math.max(25, (failed.nextReadyInMs ?? 0) + 20);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      await outbox.flush();
      const recovered = outbox.getStats();
      expect(recovered.depth).toBe(0);
      expect(recovered.totalSent).toBe(1);
      expect(recovered.lastFlushSent).toBe(1);
      expect(recovered.lastFlushErrors).toBe(0);
      expect(typeof recovered.lastSuccessAt).toBe("number");
      expect(recovered.lastError).toBeUndefined();
    } finally {
      outbox.stop();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
