import path from "node:path";
import { OpenVikingOutbox } from "../../src/memory/openviking/outbox.js";

async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main(): Promise<void> {
  const outDir = process.env.OPENCLAW_OV_ITEST_DIR ?? "/tmp/oc_ov_itest";
  const roundId = process.env.OPENCLAW_OV_RESTART_ROUND_ID ?? String(Date.now());
  const timeoutMs = Number.parseInt(process.env.OPENCLAW_OV_RESTART_TIMEOUT_MS ?? "8000", 10);
  const filePath = path.join(outDir, `outbox-restart-${roundId}.jsonl`);
  const sessionId = `sid-${roundId}`;
  const eventId = `evt-${roundId}`;

  const outboxBeforeRestart = new OpenVikingOutbox({
    filePath,
    flushIntervalMs: 500,
    maxBatchSize: 10,
    retryBaseMs: 100,
    retryMaxMs: 500,
    sender: async () => {
      throw new Error("simulated_server_outage");
    },
  });

  await outboxBeforeRestart.start();
  await outboxBeforeRestart.enqueue({
    sessionKey: "main:restart-probe",
    sessionId,
    events: [
      {
        event_id: eventId,
        event_type: "message",
        role: "user",
        content: "queued before restart",
      },
    ],
  });

  await outboxBeforeRestart.flush();
  const depthBefore = outboxBeforeRestart.getStats().depth;
  outboxBeforeRestart.stop();
  if (depthBefore !== 1) {
    throw new Error(`expected depth=1 before restart, got ${depthBefore}`);
  }

  let delivered = 0;
  const outboxAfterRestart = new OpenVikingOutbox({
    filePath,
    flushIntervalMs: 500,
    maxBatchSize: 10,
    retryBaseMs: 100,
    retryMaxMs: 500,
    sender: async () => {
      delivered += 1;
    },
  });

  await outboxAfterRestart.start();
  const recovered = await waitFor(async () => {
    await outboxAfterRestart.flush();
    return outboxAfterRestart.getStats().depth === 0;
  }, timeoutMs);
  const depthAfter = outboxAfterRestart.getStats().depth;
  outboxAfterRestart.stop();

  if (!recovered) {
    throw new Error(`outbox did not recover within timeout=${timeoutMs}ms`);
  }
  if (depthAfter !== 0) {
    throw new Error(`expected depth=0 after restart recovery, got ${depthAfter}`);
  }
  if (delivered !== 1) {
    throw new Error(`expected delivered=1 after restart recovery, got ${delivered}`);
  }

  const report = {
    roundId,
    filePath,
    depthBefore,
    depthAfter,
    delivered,
    timeoutMs,
    recovered,
    check: "pass",
  };
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ check: "fail", error: message }));
  process.exitCode = 1;
});
