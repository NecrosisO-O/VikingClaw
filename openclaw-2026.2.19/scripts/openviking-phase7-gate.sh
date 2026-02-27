#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OPENCLAW_OV_ITEST_DIR:-/tmp/oc_ov_itest}"
PORTS_JSON="${OPENCLAW_OV_PORTS_JSON:-$OUT_DIR/ports.json}"
REPRO_DIR="${ROOT_DIR}/scripts/repro/openviking"

RUN_P701=1
RUN_P702=1
RUN_P703=1
RUN_P704=1
RUN_P705=1
QUICK_MODE=0

REAL_SECONDS="${OPENCLAW_OV_REAL_SOAK_SECONDS:-1800}"
MOCK_SECONDS="${OPENCLAW_OV_MOCK_SOAK_SECONDS:-2700}"

SMOKE_SERVER_SCRIPT="${OPENCLAW_OV_SMOKE_SERVER_SCRIPT:-$REPRO_DIR/runtime_mock_server.py}"
SMOKE_CONFIG_PATH="${OPENCLAW_OV_SMOKE_CONFIG_PATH:-$REPRO_DIR/runtime_mock.config.json}"
REAL_SERVER_SCRIPT="${OPENCLAW_OV_REAL_SERVER_SCRIPT:-$OUT_DIR/run_real_server.py}"
REAL_CONFIG_PATH="${OPENCLAW_OV_REAL_CONFIG_PATH:-$OUT_DIR/ov.real.conf}"
MOCK_SERVER_SCRIPT="${OPENCLAW_OV_MOCK_SERVER_SCRIPT:-$REPRO_DIR/runtime_mock_server.py}"
MOCK_CONFIG_PATH="${OPENCLAW_OV_MOCK_CONFIG_PATH:-$REPRO_DIR/runtime_mock.config.json}"
PYTHON_BIN="${OPENCLAW_OV_PYTHON_BIN:-}"

REAL_PORT="${OPENCLAW_OV_REAL_PORT:-51193}"
MOCK_PORT="${OPENCLAW_OV_MOCK_PORT:-51192}"

SMOKE_PID=""
SMOKE_SERVER_STARTED=0

P701_OPENCLAW_STATUS="skipped"
P701_OPENVIKING_STATUS="skipped"
P702_STATUS="skipped"
P703_STATUS="skipped"
P704_STATUS="skipped"
P705_STATUS="skipped"

REAL_JSONL=""
REAL_SUMMARY=""
MOCK_JSONL=""
MOCK_SUMMARY=""
RESTART_JSONL=""
RESTART_SUMMARY=""
RECONCILE_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/openviking-phase7-gate.sh [options]

Options:
  --skip-p701            Skip P7-01 (OpenClaw/OpenViking minimal unit gates)
  --skip-p702            Skip P7-02 (runtime smoke/recovery/pressure trio)
  --skip-p703            Skip P7-03 (real pressure soak)
  --skip-p704            Skip P7-04 (mock recovery soak)
  --skip-p705            Skip P7-05 (5-round restart recovery)
  --real-seconds N       Duration for P7-03 in seconds (default: 1800)
  --mock-seconds N       Duration for P7-04 in seconds (default: 2700)
  --quick                Quick smoke: skip P7-01, run short mock-only P7-02..P7-05
  --help                 Show this message
EOF
}

log() {
  printf '[phase7-gate] %s\n' "$*"
}

fail() {
  printf '[phase7-gate] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

resolve_python_bin() {
  if [[ -n "$PYTHON_BIN" ]]; then
    [[ -x "$PYTHON_BIN" ]] || fail "python runtime not found: ${PYTHON_BIN}"
    return
  fi

  local venv_python="${ROOT_DIR}/../OpenViking-0.1.17/.venv/bin/python"
  if [[ -x "$venv_python" ]]; then
    PYTHON_BIN="$venv_python"
    return
  fi

  local python3_bin
  python3_bin="$(command -v python3 || true)"
  if [[ -n "$python3_bin" ]]; then
    PYTHON_BIN="$python3_bin"
    return
  fi
  fail "python runtime not found (set OPENCLAW_OV_PYTHON_BIN)"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --skip-p701)
        RUN_P701=0
        ;;
      --skip-p702)
        RUN_P702=0
        ;;
      --skip-p703)
        RUN_P703=0
        ;;
      --skip-p704)
        RUN_P704=0
        ;;
      --skip-p705)
        RUN_P705=0
        ;;
      --real-seconds)
        shift
        REAL_SECONDS="${1:-}"
        ;;
      --mock-seconds)
        shift
        MOCK_SECONDS="${1:-}"
        ;;
      --quick)
        QUICK_MODE=1
        RUN_P701=0
        REAL_SECONDS=120
        MOCK_SECONDS=180
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
    shift
  done
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

wait_for_health() {
  local endpoint="$1"
  local timeout_sec="$2"
  local deadline=$(( $(date +%s) + timeout_sec ))
  while (( $(date +%s) <= deadline )); do
    if curl -fsS --max-time 1 "${endpoint}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

stop_smoke_server() {
  if [[ -n "${SMOKE_PID}" ]] && kill -0 "${SMOKE_PID}" >/dev/null 2>&1; then
    kill "${SMOKE_PID}" >/dev/null 2>&1 || true
    local wait_secs=0
    while kill -0 "${SMOKE_PID}" >/dev/null 2>&1; do
      sleep 0.2
      wait_secs=$((wait_secs + 1))
      if (( wait_secs >= 25 )); then
        kill -9 "${SMOKE_PID}" >/dev/null 2>&1 || true
        break
      fi
    done
    wait "${SMOKE_PID}" 2>/dev/null || true
  fi
  SMOKE_PID=""
}

cleanup() {
  stop_smoke_server
}
trap cleanup EXIT

resolve_smoke_port() {
  node - "$PORTS_JSON" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const value = Number(parsed?.server_port ?? 51181);
  if (Number.isFinite(value) && value > 0) {
    process.stdout.write(String(value));
  } else {
    process.stdout.write("51181");
  }
} catch {
  process.stdout.write("51181");
}
NODE
}

ensure_smoke_server() {
  local smoke_port="$1"
  local endpoint="http://127.0.0.1:${smoke_port}"
  if wait_for_health "$endpoint" 2; then
    log "smoke server already healthy at ${endpoint}"
    return 0
  fi

  [[ -f "$SMOKE_SERVER_SCRIPT" ]] || fail "smoke server script not found: $SMOKE_SERVER_SCRIPT"
  [[ -f "$SMOKE_CONFIG_PATH" ]] || fail "smoke config not found: $SMOKE_CONFIG_PATH"

  local smoke_log="${OUT_DIR}/phase7_smoke_server_${RUN_TS}.log"
  log "starting smoke server at ${endpoint} with ${SMOKE_SERVER_SCRIPT}"
  "$PYTHON_BIN" \
    "$SMOKE_SERVER_SCRIPT" \
    --config "$SMOKE_CONFIG_PATH" \
    --host 127.0.0.1 \
    --port "$smoke_port" \
    --log-level warning \
    >"$smoke_log" 2>&1 &
  SMOKE_PID=$!
  SMOKE_SERVER_STARTED=1

  if ! wait_for_health "$endpoint" 15; then
    stop_smoke_server
    fail "failed to start smoke server at ${endpoint}; see ${smoke_log}"
  fi
}

write_pressure_summary() {
  local jsonl="$1"
  local summary="$2"
  node - "$jsonl" "$summary" <<'NODE'
const fs = require("fs");
const [jsonlPath, summaryPath] = process.argv.slice(2);
const rows = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const passRows = rows.filter((row) => row.status === "pass");
const failRows = rows.filter((row) => row.status !== "pass");

function stats(values) {
  if (!values.length) return { avg: null, min: null, max: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
  return { avg, min, max };
}

const elapsed = stats(rows.map((row) => row.elapsedSec).filter((value) => Number.isFinite(value)));
const flush = stats(passRows.map((row) => row.flushDurationMs).filter((value) => Number.isFinite(value)));
const throughput = stats(passRows.map((row) => row.throughputEventsPerSec).filter((value) => Number.isFinite(value)));

const queuedDepthSet = [...new Set(passRows.map((row) => row.queuedDepth).filter((value) => Number.isFinite(value)))].sort(
  (a, b) => a - b,
);
const peakDepthSet = [...new Set(passRows.map((row) => row.peakDepth).filter((value) => Number.isFinite(value)))].sort(
  (a, b) => a - b,
);

const summary = {
  mode: "real_pressure_soak",
  rounds: rows.length,
  passes: passRows.length,
  fails: failRows.length,
  elapsedSec: elapsed,
  flushDurationMs: flush,
  throughputEventsPerSec: throughput,
  queuedDepthSet,
  peakDepthSet,
  failedRounds: failRows.map((row) => ({ round: row.round, log: row.log })),
  allChecksPass: failRows.length === 0,
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
NODE
}

write_recovery_summary() {
  local jsonl="$1"
  local summary="$2"
  node - "$jsonl" "$summary" <<'NODE'
const fs = require("fs");
const [jsonlPath, summaryPath] = process.argv.slice(2);
const rows = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const passRows = rows.filter((row) => row.status === "pass");
const failRows = rows.filter((row) => row.status !== "pass");

function stats(values) {
  if (!values.length) return { avg: null, min: null, max: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
  return { avg, min, max };
}

const elapsed = stats(rows.map((row) => row.elapsedSec).filter((value) => Number.isFinite(value)));
const t6aPass = passRows.filter((row) => row.T6_outage_non_blocking_enqueue === "pass").length;
const t6bPass = passRows.filter((row) => row.T6_recovery_outbox_flush === "pass").length;

const summary = {
  mode: "mock_recovery_soak",
  rounds: rows.length,
  passes: passRows.length,
  fails: failRows.length,
  elapsedSec: elapsed,
  checks: {
    T6_outage_non_blocking_enqueue: { pass: t6aPass, total: passRows.length },
    T6_recovery_outbox_flush: { pass: t6bPass, total: passRows.length },
  },
  failedRounds: failRows.map((row) => ({ round: row.round, log: row.log })),
  allChecksPass: failRows.length === 0 && t6aPass === passRows.length && t6bPass === passRows.length,
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
NODE
}

write_restart_summary() {
  local jsonl="$1"
  local summary="$2"
  node - "$jsonl" "$summary" <<'NODE'
const fs = require("fs");
const [jsonlPath, summaryPath] = process.argv.slice(2);
const rows = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const passRows = rows.filter((row) => row.status === "pass");
const failRows = rows.filter((row) => row.status !== "pass");
const elapsedValues = rows.map((row) => row.elapsedSec).filter((value) => Number.isFinite(value));

const elapsedSec = elapsedValues.length
  ? {
      avg: Number((elapsedValues.reduce((a, b) => a + b, 0) / elapsedValues.length).toFixed(2)),
      min: Math.min(...elapsedValues),
      max: Math.max(...elapsedValues),
    }
  : { avg: null, min: null, max: null };

const summary = {
  mode: "restart_recovery_5round",
  rounds: rows.length,
  passes: passRows.length,
  fails: failRows.length,
  elapsedSec,
  failedRounds: failRows.map((row) => ({ round: row.round, log: row.log })),
  allChecksPass: failRows.length === 0 && passRows.length === 5,
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
NODE
}

run_p701() {
  local openclaw_log="${OUT_DIR}/phase7_p701_openclaw_${RUN_TS}.log"
  local openviking_log="${OUT_DIR}/phase7_p701_openviking_${RUN_TS}.log"

  log "P7-01: running OpenClaw minimal unit gate"
  if pnpm vitest run \
    --config vitest.unit.config.ts \
    src/memory/backend-config.test.ts \
    src/memory/search-manager.test.ts \
    src/memory/openviking/client.test.ts \
    src/memory/openviking/bridge.test.ts \
    --maxWorkers=1 \
    >"$openclaw_log" 2>&1; then
    P701_OPENCLAW_STATUS="pass"
  else
    P701_OPENCLAW_STATUS="fail"
    fail "P7-01 OpenClaw gate failed. log: ${openclaw_log}"
  fi

  log "P7-01: running OpenViking minimal unit gate"
  if "$PYTHON_BIN" -m pytest -q \
    "${ROOT_DIR}/../OpenViking-0.1.17/tests/misc/test_viking_vector_index_backend_uri_idempotency.py" \
    "${ROOT_DIR}/../OpenViking-0.1.17/tests/misc/test_intent_analyzer_signal_tokens.py" \
    "${ROOT_DIR}/../OpenViking-0.1.17/tests/misc/test_hierarchical_retriever_signal_bonus.py" \
    "${ROOT_DIR}/../OpenViking-0.1.17/tests/session/test_memory_deduplicator.py" \
    >"$openviking_log" 2>&1; then
    P701_OPENVIKING_STATUS="pass"
  else
    P701_OPENVIKING_STATUS="fail"
    fail "P7-01 OpenViking gate failed. log: ${openviking_log}"
  fi
}

run_p702() {
  local smoke_port
  smoke_port="$(resolve_smoke_port)"
  ensure_smoke_server "$smoke_port"

  local runtime_log="${OUT_DIR}/phase7_p702_runtime_${RUN_TS}.log"
  log "P7-02: running runtime trio (smoke + recovery + pressure)"
  if pnpm vitest run \
    src/memory/openviking/manual.runtime-smoke.test.ts \
    src/memory/openviking/manual.runtime-recovery.test.ts \
    src/memory/openviking/manual.runtime-pressure.test.ts \
    --maxWorkers=1 \
    >"$runtime_log" 2>&1; then
    P702_STATUS="pass"
  else
    P702_STATUS="fail"
    fail "P7-02 runtime trio failed. log: ${runtime_log}"
  fi

  if (( SMOKE_SERVER_STARTED == 1 )); then
    stop_smoke_server
  fi
}

run_p703() {
  REAL_JSONL="${OUT_DIR}/real_pressure_soak_${RUN_TS}.jsonl"
  REAL_SUMMARY="${OUT_DIR}/real_pressure_soak_${RUN_TS}.summary.json"
  : >"$REAL_JSONL"

  local stage_report="${OUT_DIR}/stage_pressure_report.json"
  local started_at
  started_at=$(date +%s)
  local round=0
  local fail_count=0

  log "P7-03: real pressure soak start (${REAL_SECONDS}s)"
  while (( $(date +%s) - started_at < REAL_SECONDS )); do
    round=$((round + 1))
    local round_started_at
    round_started_at=$(date +%s)
    local round_log="${OUT_DIR}/real_pressure_soak_${RUN_TS}_round_${round}.log"
    : >"$stage_report"

    local status="pass"
    if ! OPENCLAW_OV_SERVER_SCRIPT="$REAL_SERVER_SCRIPT" \
      OPENCLAW_OV_CONFIG_PATH="$REAL_CONFIG_PATH" \
      OPENCLAW_OV_PORT="$REAL_PORT" \
      pnpm vitest run src/memory/openviking/manual.runtime-pressure.test.ts --maxWorkers=1 \
      >"$round_log" 2>&1; then
      status="fail"
      fail_count=$((fail_count + 1))
    fi

    local elapsed=$(( $(date +%s) - round_started_at ))
    local parsed
    parsed="$(node - "$stage_report" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const values = [
    parsed.flushDurationMs ?? "null",
    parsed.throughputEventsPerSec ?? "null",
    parsed.queuedDepth ?? "null",
    parsed.peakDepth ?? "null",
  ];
  process.stdout.write(values.join("\t"));
} catch {
  process.stdout.write("null\tnull\tnull\tnull");
}
NODE
)"
    local flush throughput queued peak
    IFS=$'\t' read -r flush throughput queued peak <<<"$parsed"

    printf '{"round":%s,"status":"%s","elapsedSec":%s,"flushDurationMs":%s,"throughputEventsPerSec":%s,"queuedDepth":%s,"peakDepth":%s,"log":"%s"}\n' \
      "$round" "$status" "$elapsed" "$flush" "$throughput" "$queued" "$peak" "$round_log" >>"$REAL_JSONL"
    log "P7-03 round=${round} status=${status} elapsed=${elapsed}s flush=${flush} throughput=${throughput} fail=${fail_count}"
  done

  write_pressure_summary "$REAL_JSONL" "$REAL_SUMMARY" >/dev/null
  local all_pass
  all_pass="$(node - "$REAL_SUMMARY" <<'NODE'
const fs = require("fs");
const summary = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(summary.allChecksPass ? "true" : "false");
NODE
)"
  if [[ "$all_pass" == "true" ]]; then
    P703_STATUS="pass"
  else
    P703_STATUS="fail"
    fail "P7-03 summary indicates failure. summary: ${REAL_SUMMARY}"
  fi
}

run_p704() {
  MOCK_JSONL="${OUT_DIR}/mock_recovery_soak_${RUN_TS}.jsonl"
  MOCK_SUMMARY="${OUT_DIR}/mock_recovery_soak_${RUN_TS}.summary.json"
  : >"$MOCK_JSONL"

  local stage_report="${OUT_DIR}/stage2_report.json"
  local started_at
  started_at=$(date +%s)
  local round=0
  local fail_count=0

  log "P7-04: mock recovery soak start (${MOCK_SECONDS}s)"
  while (( $(date +%s) - started_at < MOCK_SECONDS )); do
    round=$((round + 1))
    local round_started_at
    round_started_at=$(date +%s)
    local round_log="${OUT_DIR}/mock_recovery_soak_${RUN_TS}_round_${round}.log"
    : >"$stage_report"

    local status="pass"
    if ! OPENCLAW_OV_SERVER_SCRIPT="$MOCK_SERVER_SCRIPT" \
      OPENCLAW_OV_CONFIG_PATH="$MOCK_CONFIG_PATH" \
      OPENCLAW_OV_PORT="$MOCK_PORT" \
      pnpm vitest run src/memory/openviking/manual.runtime-recovery.test.ts --maxWorkers=1 \
      >"$round_log" 2>&1; then
      status="fail"
      fail_count=$((fail_count + 1))
    fi

    local elapsed=$(( $(date +%s) - round_started_at ))
    local parsed
    parsed="$(node - "$stage_report" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const checks = parsed?.checks ?? {};
  const values = [
    checks.T6_outage_non_blocking_enqueue ?? "null",
    checks.T6_recovery_outbox_flush ?? "null",
  ];
  process.stdout.write(values.join("\t"));
} catch {
  process.stdout.write("null\tnull");
}
NODE
)"
    local t6a t6b
    IFS=$'\t' read -r t6a t6b <<<"$parsed"

    printf '{"round":%s,"status":"%s","elapsedSec":%s,"T6_outage_non_blocking_enqueue":"%s","T6_recovery_outbox_flush":"%s","log":"%s"}\n' \
      "$round" "$status" "$elapsed" "$t6a" "$t6b" "$round_log" >>"$MOCK_JSONL"

    if [[ "$status" == "fail" ]] || (( round % 10 == 0 )); then
      log "P7-04 round=${round} status=${status} elapsed=${elapsed}s t6a=${t6a} t6b=${t6b} fail=${fail_count}"
    fi
  done

  write_recovery_summary "$MOCK_JSONL" "$MOCK_SUMMARY" >/dev/null
  local all_pass
  all_pass="$(node - "$MOCK_SUMMARY" <<'NODE'
const fs = require("fs");
const summary = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(summary.allChecksPass ? "true" : "false");
NODE
)"
  if [[ "$all_pass" == "true" ]]; then
    P704_STATUS="pass"
  else
    P704_STATUS="fail"
    fail "P7-04 summary indicates failure. summary: ${MOCK_SUMMARY}"
  fi
}

run_p705() {
  RESTART_JSONL="${OUT_DIR}/restart_recovery_5round_${RUN_TS}.jsonl"
  RESTART_SUMMARY="${OUT_DIR}/restart_recovery_5round_${RUN_TS}.summary.json"
  : >"$RESTART_JSONL"

  local round
  local fail_count=0
  for round in 1 2 3 4 5; do
    local round_started_at
    round_started_at=$(date +%s)
    local round_log="${OUT_DIR}/restart_recovery_5round_${RUN_TS}_round_${round}.log"

    local status="pass"
    if ! OPENCLAW_OV_ITEST_DIR="$OUT_DIR" \
      OPENCLAW_OV_RESTART_ROUND_ID="${RUN_TS}-${round}" \
      pnpm tsx scripts/repro/openviking-outbox-restart-probe.ts \
      >"$round_log" 2>&1; then
      status="fail"
      fail_count=$((fail_count + 1))
    fi

    local elapsed=$(( $(date +%s) - round_started_at ))
    printf '{"round":%s,"status":"%s","elapsedSec":%s,"log":"%s"}\n' \
      "$round" "$status" "$elapsed" "$round_log" >>"$RESTART_JSONL"
    log "P7-05 round=${round} status=${status} elapsed=${elapsed}s fail=${fail_count}"
  done

  write_restart_summary "$RESTART_JSONL" "$RESTART_SUMMARY" >/dev/null
  local all_pass
  all_pass="$(node - "$RESTART_SUMMARY" <<'NODE'
const fs = require("fs");
const summary = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(summary.allChecksPass ? "true" : "false");
NODE
)"
  if [[ "$all_pass" == "true" ]]; then
    P705_STATUS="pass"
  else
    P705_STATUS="fail"
    fail "P7-05 summary indicates failure. summary: ${RESTART_SUMMARY}"
  fi
}

run_reconcile() {
  RECONCILE_PATH="${OUT_DIR}/phase7_gate_reconcile_${RUN_TS}.json"
  node - "$REAL_SUMMARY" "$MOCK_SUMMARY" "$RESTART_SUMMARY" "$RECONCILE_PATH" <<'NODE'
const fs = require("fs");
const [realPath, mockPath, restartPath, outPath] = process.argv.slice(2);

function countJsonl(path) {
  const content = fs.readFileSync(path, "utf8").trim();
  return content ? content.split("\n").filter(Boolean).length : 0;
}

function inspect(summaryPath) {
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const jsonlPath = summaryPath.replace(/\.summary\.json$/, ".jsonl");
  const jsonlRows = fs.existsSync(jsonlPath) ? countJsonl(jsonlPath) : null;
  const roundsMatch = jsonlRows !== null ? summary.rounds === jsonlRows : false;
  const countsMatch = summary.rounds === summary.passes + summary.fails;
  const record = {
    summaryPath,
    jsonlPath,
    rounds: summary.rounds,
    passes: summary.passes,
    fails: summary.fails,
    jsonlRows,
    roundsMatch,
    countsMatch,
    allChecksPass: summary.allChecksPass === true,
  };
  record.consistent = record.roundsMatch && record.countsMatch;
  return record;
}

const checks = [inspect(realPath), inspect(mockPath), inspect(restartPath)];
const report = {
  generatedAt: new Date().toISOString(),
  checks,
  allConsistent: checks.every((check) => check.consistent),
  allChecksPass: checks.every((check) => check.allChecksPass),
  gatePass: checks.every((check) => check.consistent && check.allChecksPass),
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
NODE

  local gate_pass
  gate_pass="$(node - "$RECONCILE_PATH" <<'NODE'
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(report.gatePass ? "true" : "false");
NODE
)"
  if [[ "$gate_pass" != "true" ]]; then
    fail "reconcile indicates gate failure. report: ${RECONCILE_PATH}"
  fi
}

write_final_summary() {
  local final_summary="${OUT_DIR}/phase7_gate_${RUN_TS}.summary.json"
  node - \
    "$final_summary" \
    "$P701_OPENCLAW_STATUS" \
    "$P701_OPENVIKING_STATUS" \
    "$P702_STATUS" \
    "$P703_STATUS" \
    "$P704_STATUS" \
    "$P705_STATUS" \
    "$REAL_JSONL" \
    "$REAL_SUMMARY" \
    "$MOCK_JSONL" \
    "$MOCK_SUMMARY" \
    "$RESTART_JSONL" \
    "$RESTART_SUMMARY" \
    "$RECONCILE_PATH" <<'NODE'
const fs = require("fs");
const [
  outPath,
  p701Openclaw,
  p701Openviking,
  p702,
  p703,
  p704,
  p705,
  realJsonl,
  realSummary,
  mockJsonl,
  mockSummary,
  restartJsonl,
  restartSummary,
  reconcilePath,
] = process.argv.slice(2);

const summary = {
  generatedAt: new Date().toISOString(),
  phases: {
    P701: {
      openclaw: p701Openclaw,
      openviking: p701Openviking,
      pass: p701Openclaw !== "fail" && p701Openviking !== "fail",
    },
    P702: { status: p702, pass: p702 !== "fail" },
    P703: { status: p703, pass: p703 !== "fail", summaryPath: realSummary, jsonlPath: realJsonl },
    P704: { status: p704, pass: p704 !== "fail", summaryPath: mockSummary, jsonlPath: mockJsonl },
    P705: { status: p705, pass: p705 !== "fail", summaryPath: restartSummary, jsonlPath: restartJsonl },
  },
  reconcilePath,
};
summary.gatePass =
  summary.phases.P701.pass &&
  summary.phases.P702.pass &&
  summary.phases.P703.pass &&
  summary.phases.P704.pass &&
  summary.phases.P705.pass;

fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
NODE
}

main() {
  parse_args "$@"

  require_cmd node
  require_cmd pnpm
  require_cmd curl
  resolve_python_bin
  [[ -f "${ROOT_DIR}/scripts/repro/openviking-outbox-restart-probe.ts" ]] || \
    fail "restart probe script missing: ${ROOT_DIR}/scripts/repro/openviking-outbox-restart-probe.ts"
  [[ -f "$SMOKE_SERVER_SCRIPT" ]] || fail "smoke server script missing: ${SMOKE_SERVER_SCRIPT}"
  [[ -f "$SMOKE_CONFIG_PATH" ]] || fail "smoke config missing: ${SMOKE_CONFIG_PATH}"
  [[ -f "$MOCK_SERVER_SCRIPT" ]] || fail "mock server script missing: ${MOCK_SERVER_SCRIPT}"
  [[ -f "$MOCK_CONFIG_PATH" ]] || fail "mock config missing: ${MOCK_CONFIG_PATH}"

  if (( QUICK_MODE == 1 )); then
    REAL_SERVER_SCRIPT="$MOCK_SERVER_SCRIPT"
    REAL_CONFIG_PATH="$MOCK_CONFIG_PATH"
  fi

  is_positive_integer "$REAL_SECONDS" || fail "--real-seconds must be a positive integer"
  is_positive_integer "$MOCK_SECONDS" || fail "--mock-seconds must be a positive integer"

  mkdir -p "$OUT_DIR"
  cd "$ROOT_DIR"
  RUN_TS="$(date +%s)"

  log "run id=${RUN_TS} out_dir=${OUT_DIR}"
  log "plan: P701=${RUN_P701} P702=${RUN_P702} P703=${RUN_P703} P704=${RUN_P704} P705=${RUN_P705}"
  log "durations: real=${REAL_SECONDS}s mock=${MOCK_SECONDS}s"
  log "python=${PYTHON_BIN}"
  if (( QUICK_MODE == 1 )); then
    log "quick-mode enabled: P7-03 uses mock server (${REAL_SERVER_SCRIPT})"
  fi

  if (( RUN_P701 == 1 )); then
    run_p701
  fi
  if (( RUN_P702 == 1 )); then
    run_p702
  fi
  if (( RUN_P703 == 1 )); then
    run_p703
  fi
  if (( RUN_P704 == 1 )); then
    run_p704
  fi
  if (( RUN_P705 == 1 )); then
    run_p705
  fi

  if (( RUN_P703 == 1 && RUN_P704 == 1 && RUN_P705 == 1 )); then
    run_reconcile
  else
    RECONCILE_PATH="skipped"
  fi

  write_final_summary
  log "completed. final summary: ${OUT_DIR}/phase7_gate_${RUN_TS}.summary.json"
}

main "$@"
