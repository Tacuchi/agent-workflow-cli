import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type SelfDoctorReport, selfDoctor } from "../../../application/self/doctor-self.js";
import type { SelfMcpConnectionView } from "../../../application/self/mcp-config.js";
import { selfMcpConfig } from "../../../application/self/mcp-config.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { LogsSection } from "../components/logs-section.js";
import { PageHead } from "../components/page-head.js";
import { SectionHead } from "../components/section-head.js";
import { StatTile } from "../components/stat-tile.js";
import type { LogEntry } from "../data/logs.js";
import { HOSTS } from "../hosts.js";
import { colors, icons } from "../theme.js";

export interface StatusTabProps {
  ctx: CliContext;
  version: string;
  isActive: boolean;
  onActivateTab?: (tab: "workflow" | "mcp" | "skills") => void;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
  /** Daily operational logs (global user-level). Empty renders the empty-state. */
  logs?: LogEntry[];
  /** Last app used in "open with…" (prefill + memory). */
  lastOpenApp?: string;
  /** Persist the last app chosen in "open with…". */
  onSetLastApp?: (app: string) => void;
  /** Hosts disabled in Config: excluded from the coverage computation. */
  disabledHosts?: string[];
}

interface StatusData {
  doctor: SelfDoctorReport | null;
  mcp: SelfMcpConnectionView[];
  hooksArmed: boolean;
  loading: boolean;
}

const TILE_IDS = ["cli", "hosts", "hooks", "mcp", "logs"] as const;
type TileId = (typeof TILE_IDS)[number];

export function StatusTab({
  ctx,
  version,
  isActive,
  onActivateTab,
  onToast,
  logs = [],
  lastOpenApp,
  onSetLastApp,
  disabledHosts = [],
}: StatusTabProps) {
  const [data, setData] = useState<StatusData>({
    doctor: null,
    mcp: [],
    hooksArmed: false,
    loading: true,
  });
  const [tileCursor, setTileCursor] = useState<TileId>("cli");
  // When true the Logs section owns the keyboard (↑↓/⏎/a/esc); the tiles strip
  // pauses its own nav so the two don't fight over arrows.
  const [logsMode, setLogsMode] = useState(false);
  const dataStartedRef = useRef(false);

  const openEntry = useCallback(
    async (entry: LogEntry, app?: string) => {
      if (!(await ctx.fs.exists(entry.path))) {
        onToast?.({ tone: "err", title: "Log no encontrado", body: entry.path });
        return;
      }
      try {
        await ctx.process.openPath(entry.path, app ? { app } : {});
        onToast?.({
          tone: "info",
          title: `Abriendo ${entry.name}`,
          ...(app ? { body: `con ${app}` } : {}),
        });
        if (app) onSetLastApp?.(app);
      } catch {
        onToast?.({ tone: "err", title: "No se pudo abrir", body: entry.path });
      }
    },
    [ctx, onToast, onSetLastApp],
  );

  useEffect(() => {
    if (dataStartedRef.current) return;
    dataStartedRef.current = true;
    void (async () => {
      const doc = await selfDoctor(ctx).catch(() => null);
      const mcpRes = await selfMcpConfig(buildArgs("list"), ctx).catch(() => null);
      const mcp: SelfMcpConnectionView[] = mcpRes?.ok ? (mcpRes.data?.connections ?? []) : [];
      const hooksArmed = await detectHooksArmed(ctx);
      setData({
        doctor: doc?.ok ? (doc.data ?? null) : null,
        mcp,
        hooksArmed,
        loading: false,
      });
    })();
  }, [ctx]);

  // The update-check + banner live in the AppShell via NotificationCenter.
  // This tab navigates tiles and delegates `⏎` on hosts/mcp (switch tab) and
  // logs (enter Logs mode). While logsMode is active, the LogsSection owns the
  // keyboard → this capture turns off so they don't fight over the arrows.
  useInput(
    (_input, key) => {
      if (!isActive) return;
      if (key.upArrow || key.leftArrow) {
        setTileCursor((c) => {
          const idx = TILE_IDS.indexOf(c);
          return TILE_IDS[(idx - 1 + TILE_IDS.length) % TILE_IDS.length] ?? "cli";
        });
        return;
      }
      if (key.downArrow || key.rightArrow) {
        setTileCursor((c) => {
          const idx = TILE_IDS.indexOf(c);
          return TILE_IDS[(idx + 1) % TILE_IDS.length] ?? "cli";
        });
        return;
      }
      if (key.return) {
        // Host administration lives in [Workflows].
        if (tileCursor === "hosts") onActivateTab?.("workflow");
        if (tileCursor === "mcp") onActivateTab?.("mcp");
        if (tileCursor === "logs") setLogsMode(true);
      }
    },
    { isActive: isActive && !logsMode },
  );

  if (data.loading) {
    return (
      <Box>
        <Text color={colors.dim}>{icons.spinner} loading status…</Text>
      </Box>
    );
  }

  // Cross-reference HOSTS with doctor.skill.targets. Hosts disabled in Config
  // leave the coverage computation and the chips (targeting opt-out).
  const disabled = new Set(disabledHosts);
  const activeHosts = HOSTS.filter((h) => !disabled.has(h.id));
  const installedByTarget = new Map<string, boolean>(
    (data.doctor?.skill.targets ?? []).map((t) => [t.target, t.installed]),
  );
  const hostsInstalled = activeHosts.map((h) => ({
    host: h,
    installed: installedByTarget.get(h.id) === true,
  }));
  const installedHosts = hostsInstalled.filter((h) => h.installed).length;
  const supportedHosts = activeHosts.length;
  const backedHosts = activeHosts.filter((h) => h.backed).length;
  const pendingHosts = supportedHosts - backedHosts;
  const pct = supportedHosts > 0 ? Math.round((installedHosts / supportedHosts) * 100) : 0;

  return (
    <Box flexDirection="column">
      <PageHead
        title="Status"
        count={{
          label: `${installedHosts}/${supportedHosts} hosts covered`,
          tone: installedHosts > 0 ? "accent" : "warn",
        }}
      />

      <Box flexDirection="row" marginBottom={1}>
        <StatTile
          label="cli"
          value={`v${data.doctor?.cli_version ?? version}`}
          sub="@tacuchi"
          accent
          active={tileCursor === "cli"}
        />
        <StatTile
          label="hosts"
          value={`${installedHosts}/${supportedHosts}`}
          sub={`${pct}% coverage`}
          tone={installedHosts > 0 ? "accent" : "warn"}
          clickable
          active={tileCursor === "hosts"}
        />
        <StatTile
          label="hooks"
          value={data.hooksArmed ? "armed" : "off"}
          sub="claude only"
          tone={data.hooksArmed ? "ok" : "dim"}
          active={tileCursor === "hooks"}
        />
        <StatTile
          label="mcp"
          value={`${data.mcp.length} db`}
          sub="mcp-connections.json"
          tone={data.mcp.length > 0 ? "accent" : "dim"}
          clickable
          active={tileCursor === "mcp"}
        />
        <StatTile
          label="logs"
          value={`${logs.length}`}
          sub="daily"
          tone={logs.length > 0 ? "accent" : "dim"}
          clickable
          active={tileCursor === "logs"}
        />
      </Box>

      <Text color={colors.borderFaint}>{"─".repeat(60)}</Text>

      <SectionHead
        label="Skill coverage"
        count={`${installedHosts}/${supportedHosts}`}
        hint={`${backedHosts} backed · ${pendingHosts} pending`}
        marginTop={1}
      />
      <Box marginLeft={2} marginTop={0} flexDirection="row">
        <ProgressLine ratio={supportedHosts > 0 ? installedHosts / supportedHosts : 0} />
        <Text> </Text>
        <Text color={colors.accent} bold>
          {pct}%
        </Text>
      </Box>
      <Box marginLeft={2} marginTop={0} flexDirection="row" flexWrap="wrap">
        {hostsInstalled.map(({ host, installed }) => (
          <HostChip key={host.id} name={host.name} installed={installed} backed={host.backed} />
        ))}
      </Box>

      <LogsSection
        logs={logs}
        focused={logsMode}
        {...(lastOpenApp !== undefined ? { lastApp: lastOpenApp } : {})}
        onOpen={(entry) => void openEntry(entry)}
        onOpenWith={(entry, app) => void openEntry(entry, app)}
        onExit={() => setLogsMode(false)}
      />
    </Box>
  );
}

function HostChip({
  name,
  installed,
  backed,
}: {
  name: string;
  installed: boolean;
  backed: boolean;
}) {
  let color: string = colors.dim;
  let glyph = " ";
  if (installed) {
    color = colors.ok;
    glyph = "✓";
  } else if (!backed) {
    color = colors.warn;
  }
  return (
    <Box marginRight={2}>
      <Text color={color}>{glyph}</Text>
      <Text> </Text>
      <Text color={installed ? colors.text : colors.dim}>{name}</Text>
    </Box>
  );
}

async function detectHooksArmed(ctx: CliContext): Promise<boolean> {
  const settingsPath = `${ctx.env.homeDir()}/.claude/settings.json`;
  if (!(await ctx.fs.exists(settingsPath))) return false;
  try {
    const raw = await ctx.fs.readText(settingsPath);
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    return Boolean(parsed.hooks && Object.keys(parsed.hooks).length > 0);
  } catch {
    return false;
  }
}

function ProgressLine({ ratio }: { ratio: number }) {
  const width = 18;
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return (
    <Box>
      <Text color={colors.accent}>{"█".repeat(filled)}</Text>
      <Text color={colors.faint}>{"░".repeat(width - filled)}</Text>
    </Box>
  );
}

function buildArgs(action: string): ParsedArgs {
  return {
    rest: ["mcp", action],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
}
