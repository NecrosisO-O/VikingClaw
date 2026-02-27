import { formatCliCommand } from "../cli/command-format.js";
import { withProgress } from "../cli/progress.js";
import { resolveGatewayPort } from "../config/config.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { info } from "../globals.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { formatUsageReportLines, loadProviderUsageSummary } from "../infra/provider-usage.js";
import { normalizeUpdateChannel, resolveUpdateChannelDisplay } from "../infra/update-channels.js";
import { formatGitInstallLabel } from "../infra/update-check.js";
import {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "../memory/status-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { runSecurityAudit } from "../security/audit.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatHealthChannelLines, type HealthSummary } from "./health.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";
import { statusAllCommand } from "./status-all.js";
import { formatGatewayAuthUsed } from "./status-all/format.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
import {
  formatDuration,
  formatKTokens,
  formatTokensCompact,
  shortenText,
} from "./status.format.js";
import { resolveGatewayProbeAuth } from "./status.gateway-probe.js";
import { scanStatus } from "./status.scan.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
} from "./status.update.js";

export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  if (opts.all && !opts.json) {
    await statusAllCommand(runtime, { timeoutMs: opts.timeoutMs });
    return;
  }

  const scan = await scanStatus(
    { json: opts.json, timeoutMs: opts.timeoutMs, all: opts.all },
    runtime,
  );
  const {
    cfg,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues,
    agentStatus,
    channels,
    summary,
    memory,
    memoryPlugin,
  } = scan;

  const securityAudit = await withProgress(
    {
      label: "Running security audit…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await runSecurityAudit({
        config: cfg,
        deep: false,
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
  );

  const usage = opts.usage
    ? await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await loadProviderUsageSummary({ timeoutMs: opts.timeoutMs }),
      )
    : undefined;
  const health: HealthSummary | undefined = opts.deep
    ? await withProgress(
        {
          label: "Checking gateway health…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () =>
          await callGateway<HealthSummary>({
            method: "health",
            params: { probe: true },
            timeoutMs: opts.timeoutMs,
          }),
      )
    : undefined;
  const lastHeartbeat =
    opts.deep && gatewayReachable
      ? await callGateway<HeartbeatEventPayload | null>({
          method: "last-heartbeat",
          params: {},
          timeoutMs: opts.timeoutMs,
        }).catch(() => null)
      : null;

  const configChannel = normalizeUpdateChannel(cfg.update?.channel);
  const channelInfo = resolveUpdateChannelDisplay({
    configChannel,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });

  if (opts.json) {
    const [daemon, nodeDaemon] = await Promise.all([
      getDaemonStatusSummary(),
      getNodeDaemonStatusSummary(),
    ]);
    runtime.log(
      JSON.stringify(
        {
          ...summary,
          os: osSummary,
          update,
          updateChannel: channelInfo.channel,
          updateChannelSource: channelInfo.source,
          memory,
          memoryPlugin,
          gateway: {
            mode: gatewayMode,
            url: gatewayConnection.url,
            urlSource: gatewayConnection.urlSource,
            misconfigured: remoteUrlMissing,
            reachable: gatewayReachable,
            connectLatencyMs: gatewayProbe?.connectLatencyMs ?? null,
            self: gatewaySelf,
            error: gatewayProbe?.error ?? null,
          },
          gatewayService: daemon,
          nodeService: nodeDaemon,
          agents: agentStatus,
          securityAudit,
          ...(health || usage || lastHeartbeat ? { health, usage, lastHeartbeat } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  const rich = true;
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);

  if (opts.verbose) {
    const details = buildGatewayConnectionDetails();
    runtime.log(info("Gateway connection:"));
    for (const line of details.message.split("\n")) {
      runtime.log(`  ${line}`);
    }
    runtime.log("");
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  const dashboard = (() => {
    const controlUiEnabled = cfg.gateway?.controlUi?.enabled ?? true;
    if (!controlUiEnabled) {
      return "disabled";
    }
    const links = resolveControlUiLinks({
      port: resolveGatewayPort(cfg),
      bind: cfg.gateway?.bind,
      customBindHost: cfg.gateway?.customBindHost,
      basePath: cfg.gateway?.controlUi?.basePath,
    });
    return links.httpUrl;
  })();

  const gatewayValue = (() => {
    const target = remoteUrlMissing
      ? `fallback ${gatewayConnection.url}`
      : `${gatewayConnection.url}${gatewayConnection.urlSource ? ` (${gatewayConnection.urlSource})` : ""}`;
    const reach = remoteUrlMissing
      ? warn("misconfigured (remote.url missing)")
      : gatewayReachable
        ? ok(`reachable ${formatDuration(gatewayProbe?.connectLatencyMs)}`)
        : warn(gatewayProbe?.error ? `unreachable (${gatewayProbe.error})` : "unreachable");
    const auth =
      gatewayReachable && !remoteUrlMissing
        ? ` · auth ${formatGatewayAuthUsed(resolveGatewayProbeAuth(cfg))}`
        : "";
    const self =
      gatewaySelf?.host || gatewaySelf?.version || gatewaySelf?.platform
        ? [
            gatewaySelf?.host ? gatewaySelf.host : null,
            gatewaySelf?.ip ? `(${gatewaySelf.ip})` : null,
            gatewaySelf?.version ? `app ${gatewaySelf.version}` : null,
            gatewaySelf?.platform ? gatewaySelf.platform : null,
          ]
            .filter(Boolean)
            .join(" ")
        : null;
    const suffix = self ? ` · ${self}` : "";
    return `${gatewayMode} · ${target} · ${reach}${auth}${suffix}`;
  })();

  const agentsValue = (() => {
    const pending =
      agentStatus.bootstrapPendingCount > 0
        ? `${agentStatus.bootstrapPendingCount} bootstrapping`
        : "no bootstraps";
    const def = agentStatus.agents.find((a) => a.id === agentStatus.defaultId);
    const defActive = def?.lastActiveAgeMs != null ? formatTimeAgo(def.lastActiveAgeMs) : "unknown";
    const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
    return `${agentStatus.agents.length} · ${pending} · sessions ${agentStatus.totalSessions}${defSuffix}`;
  })();

  const [daemon, nodeDaemon] = await Promise.all([
    getDaemonStatusSummary(),
    getNodeDaemonStatusSummary(),
  ]);
  const daemonValue = (() => {
    if (daemon.installed === false) {
      return `${daemon.label} not installed`;
    }
    const installedPrefix = daemon.installed === true ? "installed · " : "";
    return `${daemon.label} ${installedPrefix}${daemon.loadedText}${daemon.runtimeShort ? ` · ${daemon.runtimeShort}` : ""}`;
  })();
  const nodeDaemonValue = (() => {
    if (nodeDaemon.installed === false) {
      return `${nodeDaemon.label} not installed`;
    }
    const installedPrefix = nodeDaemon.installed === true ? "installed · " : "";
    return `${nodeDaemon.label} ${installedPrefix}${nodeDaemon.loadedText}${nodeDaemon.runtimeShort ? ` · ${nodeDaemon.runtimeShort}` : ""}`;
  })();

  const defaults = summary.sessions.defaults;
  const defaultCtx = defaults.contextTokens
    ? ` (${formatKTokens(defaults.contextTokens)} ctx)`
    : "";
  const eventsValue =
    summary.queuedSystemEvents.length > 0 ? `${summary.queuedSystemEvents.length} queued` : "none";

  const probesValue = health ? ok("enabled") : muted("skipped (use --deep)");

  const heartbeatValue = (() => {
    const parts = summary.heartbeat.agents
      .map((agent) => {
        if (!agent.enabled || !agent.everyMs) {
          return `disabled (${agent.agentId})`;
        }
        const everyLabel = agent.every;
        return `${everyLabel} (${agent.agentId})`;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : "disabled";
  })();
  const lastHeartbeatValue = (() => {
    if (!opts.deep) {
      return null;
    }
    if (!gatewayReachable) {
      return warn("unavailable");
    }
    if (!lastHeartbeat) {
      return muted("none");
    }
    const age = formatTimeAgo(Date.now() - lastHeartbeat.ts);
    const channel = lastHeartbeat.channel ?? "unknown";
    const accountLabel = lastHeartbeat.accountId ? `account ${lastHeartbeat.accountId}` : null;
    return [lastHeartbeat.status, `${age} ago`, channel, accountLabel].filter(Boolean).join(" · ");
  })();

  const storeLabel =
    summary.sessions.paths.length > 1
      ? `${summary.sessions.paths.length} stores`
      : (summary.sessions.paths[0] ?? "unknown");

  const memoryValue = (() => {
    if (!memoryPlugin.enabled) {
      const suffix = memoryPlugin.reason ? ` (${memoryPlugin.reason})` : "";
      return muted(`disabled${suffix}`);
    }
    if (!memory) {
      const slot = memoryPlugin.slot ? `plugin ${memoryPlugin.slot}` : "plugin";
      const backend = cfg.memory?.backend ?? "builtin";
      return muted(`enabled (${slot}) · backend ${backend} unavailable`);
    }
    const parts: string[] = [];
    const dirtySuffix = memory.dirty ? ` · ${warn("dirty")}` : "";
    if (typeof memory.files === "number" && typeof memory.chunks === "number") {
      parts.push(`${memory.files} files · ${memory.chunks} chunks${dirtySuffix}`);
    } else {
      parts.push(`backend ${memory.backend}${dirtySuffix}`);
    }
    if (memory.sources?.length) {
      parts.push(`sources ${memory.sources.join(", ")}`);
    }
    if (memoryPlugin.slot) {
      parts.push(`plugin ${memoryPlugin.slot}`);
    }
    const colorByTone = (tone: Tone, text: string) =>
      tone === "ok" ? ok(text) : tone === "warn" ? warn(text) : muted(text);
    const vector = memory.vector;
    if (vector) {
      const state = resolveMemoryVectorState(vector);
      const label = state.state === "disabled" ? "vector off" : `vector ${state.state}`;
      parts.push(colorByTone(state.tone, label));
    }
    const fts = memory.fts;
    if (fts) {
      const state = resolveMemoryFtsState(fts);
      const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
      parts.push(colorByTone(state.tone, label));
    }
    const cache = memory.cache;
    if (cache) {
      const summary = resolveMemoryCacheSummary(cache);
      parts.push(colorByTone(summary.tone, summary.text));
    }
    const endpoint = (memory.custom as { endpoint?: string } | undefined)?.endpoint;
    if (endpoint) {
      parts.push(`endpoint ${endpoint}`);
    }
    const outbox = (
      memory.custom as {
        outbox?: { depth?: number; readyNow?: number; lastFlushDurationMs?: number };
      } | undefined
    )?.outbox;
    const outboxDepth = outbox?.depth;
    if (typeof outboxDepth === "number") {
      parts.push(`outbox ${outboxDepth}`);
    }
    if (typeof outbox?.readyNow === "number" && outbox.readyNow > 0) {
      parts.push(`ready ${outbox.readyNow}`);
    }
    if (typeof outbox?.lastFlushDurationMs === "number" && outbox.lastFlushDurationMs >= 0) {
      parts.push(`flush ${Math.round(outbox.lastFlushDurationMs)}ms`);
    }
    const openvikingSearch = (
      memory.custom as {
        search?: {
          strategy?: string;
          readLayer?: string;
          maxEntries?: number;
          maxSnippetChars?: number;
          maxInjectedChars?: number;
          explainability?: boolean;
          relationExpansion?: boolean;
          lastExplain?: { typedQueries?: number; queryResults?: number };
          lastStrategy?: {
            priority?: string;
            includeResources?: boolean;
            includeSkills?: boolean;
          };
          lastLayering?: {
            requestedLayer?: string;
            entries?: number;
            snippetChars?: number;
            injectedChars?: number;
            l0?: number;
            l1?: number;
            l2?: number;
            truncatedByBudget?: boolean;
          };
          lastRelations?: {
            discovered?: number;
            directSelected?: number;
            relationSelected?: number;
          };
          lastRanking?: {
            selectedCandidates?: number;
            emittedCandidates?: number;
            droppedByMaxEntries?: number;
            droppedByBudget?: number;
          };
        };
        observer?: {
          available?: boolean;
          componentsHealthy?: number;
          componentsTotal?: number;
          degradedComponents?: string[];
          alerts?: Array<{ code?: string; severity?: string; message?: string }>;
        };
        timeliness?: {
          commitMode?: "sync" | "async";
          triggerEveryNMessages?: number;
          triggerEveryNMinutes?: number;
          outboxFlushIntervalMs?: number;
          bridge?: {
            syncCommits?: number;
            asyncCommits?: number;
            periodicCommitsByMessage?: number;
            periodicCommitsByTime?: number;
            lastCommitCause?: string;
            lastCommitSource?: string;
            lastCommitMode?: "sync" | "async";
            lastCommitLagMs?: number;
          };
        };
      } | undefined
    );
    const openvikingObserver = openvikingSearch?.observer;
    const openvikingSearchConfig = openvikingSearch?.search;
    const openvikingTimeliness = openvikingSearch?.timeliness;
    const openvikingTimelinessBridge = openvikingTimeliness?.bridge;
    if (
      typeof openvikingSearchConfig?.strategy === "string"
      && openvikingSearchConfig.strategy.trim()
    ) {
      parts.push(`strategy ${openvikingSearchConfig.strategy}`);
    }
    if (
      typeof openvikingSearchConfig?.readLayer === "string"
      && openvikingSearchConfig.readLayer.trim()
    ) {
      parts.push(`layer ${openvikingSearchConfig.readLayer}`);
    }
    if (typeof openvikingSearchConfig?.explainability === "boolean") {
      parts.push(openvikingSearchConfig.explainability ? "explain on" : "explain off");
    }
    if (typeof openvikingSearchConfig?.relationExpansion === "boolean") {
      parts.push(openvikingSearchConfig.relationExpansion ? "rels on" : "rels off");
    }
    const priority = openvikingSearchConfig?.lastStrategy?.priority;
    if (typeof priority === "string" && priority.trim()) {
      const flags = [
        "m",
        openvikingSearchConfig.lastStrategy?.includeResources ? "r" : "",
        openvikingSearchConfig.lastStrategy?.includeSkills ? "s" : "",
      ].join("");
      parts.push(`ctx ${priority}(${flags})`);
    }
    const typedQueries = openvikingSearchConfig?.lastExplain?.typedQueries;
    const queryResults = openvikingSearchConfig?.lastExplain?.queryResults;
    if (
      openvikingSearchConfig?.explainability === true
      && typeof typedQueries === "number"
      && typeof queryResults === "number"
    ) {
      parts.push(`plan ${typedQueries}/${queryResults}`);
    }
    const layerL0 = openvikingSearchConfig?.lastLayering?.l0;
    const layerL1 = openvikingSearchConfig?.lastLayering?.l1;
    const layerL2 = openvikingSearchConfig?.lastLayering?.l2;
    if (
      typeof layerL0 === "number"
      && typeof layerL1 === "number"
      && typeof layerL2 === "number"
    ) {
      parts.push(`hits ${layerL0}/${layerL1}/${layerL2}`);
    }
    const injectedChars = openvikingSearchConfig?.lastLayering?.injectedChars;
    const maxInjectedChars = openvikingSearchConfig?.maxInjectedChars;
    if (typeof injectedChars === "number" && typeof maxInjectedChars === "number") {
      parts.push(`inject ${injectedChars}/${maxInjectedChars}`);
    } else if (typeof injectedChars === "number") {
      parts.push(`inject ${injectedChars}`);
    }
    if (openvikingSearchConfig?.lastLayering?.truncatedByBudget === true) {
      parts.push(warn("inject cut"));
    }
    const relationDirect = openvikingSearchConfig?.lastRelations?.directSelected;
    const relationExpanded = openvikingSearchConfig?.lastRelations?.relationSelected;
    if (typeof relationDirect === "number" && typeof relationExpanded === "number") {
      parts.push(`relhits ${relationDirect}/${relationExpanded}`);
    }
    const selectedCandidates = openvikingSearchConfig?.lastRanking?.selectedCandidates;
    const emittedCandidates = openvikingSearchConfig?.lastRanking?.emittedCandidates;
    if (typeof selectedCandidates === "number" && typeof emittedCandidates === "number") {
      parts.push(`emit ${emittedCandidates}/${selectedCandidates}`);
    }
    const droppedByBudget = openvikingSearchConfig?.lastRanking?.droppedByBudget;
    if (typeof droppedByBudget === "number" && droppedByBudget > 0) {
      parts.push(warn(`dropB ${droppedByBudget}`));
    }
    const droppedByMaxEntries = openvikingSearchConfig?.lastRanking?.droppedByMaxEntries;
    if (typeof droppedByMaxEntries === "number" && droppedByMaxEntries > 0) {
      parts.push(`dropN ${droppedByMaxEntries}`);
    }
    if (
      typeof openvikingTimeliness?.triggerEveryNMessages === "number"
      && typeof openvikingTimeliness?.triggerEveryNMinutes === "number"
    ) {
      parts.push(
        `commit@${openvikingTimeliness.triggerEveryNMessages}msg/${openvikingTimeliness.triggerEveryNMinutes}m`,
      );
    }
    if (typeof openvikingTimelinessBridge?.lastCommitLagMs === "number") {
      parts.push(`lag ${Math.round(openvikingTimelinessBridge.lastCommitLagMs / 1000)}s`);
    }
    const lastCommitCause = openvikingTimelinessBridge?.lastCommitCause;
    if (typeof lastCommitCause === "string" && lastCommitCause.trim()) {
      const source = openvikingTimelinessBridge?.lastCommitSource;
      if (typeof source === "string" && source.trim()) {
        parts.push(`last ${lastCommitCause}/${source}`);
      } else {
        parts.push(`last ${lastCommitCause}`);
      }
    }
    if (
      typeof openvikingTimelinessBridge?.periodicCommitsByMessage === "number"
      && typeof openvikingTimelinessBridge?.periodicCommitsByTime === "number"
    ) {
      parts.push(
        `periodic ${openvikingTimelinessBridge.periodicCommitsByMessage}/${openvikingTimelinessBridge.periodicCommitsByTime}`,
      );
    }
    if (typeof openvikingObserver?.available === "boolean") {
      if (!openvikingObserver.available) {
        parts.push(warn("obs unavailable"));
      } else {
        const healthy = openvikingObserver.componentsHealthy;
        const total = openvikingObserver.componentsTotal;
        if (typeof healthy === "number" && typeof total === "number" && total > 0) {
          const ratio = `${healthy}/${total}`;
          if (healthy >= total) {
            parts.push(ok(`obs ${ratio}`));
          } else {
            parts.push(warn(`obs ${ratio}`));
          }
        } else {
          parts.push("obs unknown");
        }
      }
      const riskAlerts = Array.isArray(openvikingObserver.alerts)
        ? openvikingObserver.alerts.filter((item) => item && item.severity !== "info")
        : [];
      if (riskAlerts.length > 0) {
        const firstCode =
          typeof riskAlerts[0]?.code === "string" && riskAlerts[0].code
            ? riskAlerts[0].code
            : "alert";
        parts.push(warn(`risk ${riskAlerts.length}:${firstCode}`));
      }
    }
    return parts.join(" · ");
  })();

  const updateAvailability = resolveUpdateAvailability(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
  const channelLabel = channelInfo.label;
  const gitLabel = formatGitInstallLabel(update);

  const overviewRows = [
    { Item: "Dashboard", Value: dashboard },
    { Item: "OS", Value: `${osSummary.label} · node ${process.versions.node}` },
    {
      Item: "Tailscale",
      Value:
        tailscaleMode === "off"
          ? muted("off")
          : tailscaleDns && tailscaleHttpsUrl
            ? `${tailscaleMode} · ${tailscaleDns} · ${tailscaleHttpsUrl}`
            : warn(`${tailscaleMode} · magicdns unknown`),
    },
    { Item: "Channel", Value: channelLabel },
    ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
    {
      Item: "Update",
      Value: updateAvailability.available ? warn(`available · ${updateLine}`) : updateLine,
    },
    { Item: "Gateway", Value: gatewayValue },
    { Item: "Gateway service", Value: daemonValue },
    { Item: "Node service", Value: nodeDaemonValue },
    { Item: "Agents", Value: agentsValue },
    { Item: "Memory", Value: memoryValue },
    { Item: "Probes", Value: probesValue },
    { Item: "Events", Value: eventsValue },
    { Item: "Heartbeat", Value: heartbeatValue },
    ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
    {
      Item: "Sessions",
      Value: `${summary.sessions.count} active · default ${defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`,
    },
  ];

  runtime.log(theme.heading("OpenClaw status"));
  runtime.log("");
  runtime.log(theme.heading("Overview"));
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 12 },
        { key: "Value", header: "Value", flex: true, minWidth: 32 },
      ],
      rows: overviewRows,
    }).trimEnd(),
  );

  runtime.log("");
  runtime.log(theme.heading("Security audit"));
  const fmtSummary = (value: { critical: number; warn: number; info: number }) => {
    const parts = [
      theme.error(`${value.critical} critical`),
      theme.warn(`${value.warn} warn`),
      theme.muted(`${value.info} info`),
    ];
    return parts.join(" · ");
  };
  runtime.log(theme.muted(`Summary: ${fmtSummary(securityAudit.summary)}`));
  const importantFindings = securityAudit.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warn",
  );
  if (importantFindings.length === 0) {
    runtime.log(theme.muted("No critical or warn findings detected."));
  } else {
    const severityLabel = (sev: "critical" | "warn" | "info") => {
      if (sev === "critical") {
        return theme.error("CRITICAL");
      }
      if (sev === "warn") {
        return theme.warn("WARN");
      }
      return theme.muted("INFO");
    };
    const sevRank = (sev: "critical" | "warn" | "info") =>
      sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
    const sorted = [...importantFindings].toSorted(
      (a, b) => sevRank(a.severity) - sevRank(b.severity),
    );
    const shown = sorted.slice(0, 6);
    for (const f of shown) {
      runtime.log(`  ${severityLabel(f.severity)} ${f.title}`);
      runtime.log(`    ${shortenText(f.detail.replaceAll("\n", " "), 160)}`);
      if (f.remediation?.trim()) {
        runtime.log(`    ${theme.muted(`Fix: ${f.remediation.trim()}`)}`);
      }
    }
    if (sorted.length > shown.length) {
      runtime.log(theme.muted(`… +${sorted.length - shown.length} more`));
    }
  }
  runtime.log(theme.muted(`Full report: ${formatCliCommand("openclaw security audit")}`));
  runtime.log(theme.muted(`Deep probe: ${formatCliCommand("openclaw security audit --deep")}`));

  runtime.log("");
  runtime.log(theme.heading("Channels"));
  const channelIssuesByChannel = (() => {
    const map = new Map<string, typeof channelIssues>();
    for (const issue of channelIssues) {
      const key = issue.channel;
      const list = map.get(key);
      if (list) {
        list.push(issue);
      } else {
        map.set(key, [issue]);
      }
    }
    return map;
  })();
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Channel", header: "Channel", minWidth: 10 },
        { key: "Enabled", header: "Enabled", minWidth: 7 },
        { key: "State", header: "State", minWidth: 8 },
        { key: "Detail", header: "Detail", flex: true, minWidth: 24 },
      ],
      rows: channels.rows.map((row) => {
        const issues = channelIssuesByChannel.get(row.id) ?? [];
        const effectiveState = row.state === "off" ? "off" : issues.length > 0 ? "warn" : row.state;
        const issueSuffix =
          issues.length > 0
            ? ` · ${warn(`gateway: ${shortenText(issues[0]?.message ?? "issue", 84)}`)}`
            : "";
        return {
          Channel: row.label,
          Enabled: row.enabled ? ok("ON") : muted("OFF"),
          State:
            effectiveState === "ok"
              ? ok("OK")
              : effectiveState === "warn"
                ? warn("WARN")
                : effectiveState === "off"
                  ? muted("OFF")
                  : theme.accentDim("SETUP"),
          Detail: `${row.detail}${issueSuffix}`,
        };
      }),
    }).trimEnd(),
  );

  runtime.log("");
  runtime.log(theme.heading("Sessions"));
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Key", header: "Key", minWidth: 20, flex: true },
        { key: "Kind", header: "Kind", minWidth: 6 },
        { key: "Age", header: "Age", minWidth: 9 },
        { key: "Model", header: "Model", minWidth: 14 },
        { key: "Tokens", header: "Tokens", minWidth: 16 },
      ],
      rows:
        summary.sessions.recent.length > 0
          ? summary.sessions.recent.map((sess) => ({
              Key: shortenText(sess.key, 32),
              Kind: sess.kind,
              Age: sess.updatedAt ? formatTimeAgo(sess.age) : "no activity",
              Model: sess.model ?? "unknown",
              Tokens: formatTokensCompact(sess),
            }))
          : [
              {
                Key: muted("no sessions yet"),
                Kind: "",
                Age: "",
                Model: "",
                Tokens: "",
              },
            ],
    }).trimEnd(),
  );

  if (summary.queuedSystemEvents.length > 0) {
    runtime.log("");
    runtime.log(theme.heading("System events"));
    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
        rows: summary.queuedSystemEvents.slice(0, 5).map((event) => ({
          Event: event,
        })),
      }).trimEnd(),
    );
    if (summary.queuedSystemEvents.length > 5) {
      runtime.log(muted(`… +${summary.queuedSystemEvents.length - 5} more`));
    }
  }

  if (health) {
    runtime.log("");
    runtime.log(theme.heading("Health"));
    const rows: Array<Record<string, string>> = [];
    rows.push({
      Item: "Gateway",
      Status: ok("reachable"),
      Detail: `${health.durationMs}ms`,
    });

    for (const line of formatHealthChannelLines(health, { accountMode: "all" })) {
      const colon = line.indexOf(":");
      if (colon === -1) {
        continue;
      }
      const item = line.slice(0, colon).trim();
      const detail = line.slice(colon + 1).trim();
      const normalized = detail.toLowerCase();
      const status = (() => {
        if (normalized.startsWith("ok")) {
          return ok("OK");
        }
        if (normalized.startsWith("failed")) {
          return warn("WARN");
        }
        if (normalized.startsWith("not configured")) {
          return muted("OFF");
        }
        if (normalized.startsWith("configured")) {
          return ok("OK");
        }
        if (normalized.startsWith("linked")) {
          return ok("LINKED");
        }
        if (normalized.startsWith("not linked")) {
          return warn("UNLINKED");
        }
        return warn("WARN");
      })();
      rows.push({ Item: item, Status: status, Detail: detail });
    }

    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Item", header: "Item", minWidth: 10 },
          { key: "Status", header: "Status", minWidth: 8 },
          { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
        ],
        rows,
      }).trimEnd(),
    );
  }

  if (usage) {
    runtime.log("");
    runtime.log(theme.heading("Usage"));
    for (const line of formatUsageReportLines(usage)) {
      runtime.log(line);
    }
  }

  runtime.log("");
  runtime.log("FAQ: https://docs.openclaw.ai/faq");
  runtime.log("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
  runtime.log("");
  const updateHint = formatUpdateAvailableHint(update);
  if (updateHint) {
    runtime.log(theme.warn(updateHint));
    runtime.log("");
  }
  runtime.log("Next steps:");
  runtime.log(`  Need to share?      ${formatCliCommand("openclaw status --all")}`);
  runtime.log(`  Need to debug live? ${formatCliCommand("openclaw logs --follow")}`);
  if (gatewayReachable) {
    runtime.log(`  Need to test channels? ${formatCliCommand("openclaw status --deep")}`);
  } else {
    runtime.log(`  Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`);
  }
}
