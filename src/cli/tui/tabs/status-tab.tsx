import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type SelfDoctorReport, selfDoctor } from "../../../application/self/doctor-self.js";
import type { SelfMcpConnectionView } from "../../../application/self/mcp-config.js";
import { selfMcpConfig } from "../../../application/self/mcp-config.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { type ActivityEvent, ActivityFeed } from "../components/activity-feed.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { StatTile } from "../components/stat-tile.js";
import { HOSTS } from "../hosts.js";
import { colors, icons } from "../theme.js";

export interface StatusTabProps {
  ctx: CliContext;
  version: string;
  isActive: boolean;
  onActivateTab?: (tab: "mcp" | "skills") => void;
  onRequestUpdate?: () => void;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
  /** Emite cambios en el estado de alerta del tab (update outdated). */
  onAlertChange?: (alert: boolean) => void;
  /** Eventos recientes (activity feed). Si vacío, se renderiza empty-state. */
  recentEvents?: ActivityEvent[];
}

type UpdateStatus = "idle" | "checking" | "uptodate" | "outdated" | "applying" | "error";

interface StatusData {
  doctor: SelfDoctorReport | null;
  mcp: SelfMcpConnectionView[];
  hooksArmed: boolean;
  loading: boolean;
}

interface UpdateState {
  status: UpdateStatus;
  latest?: string;
  message?: string;
}

const TILE_IDS = ["cli", "hosts", "hooks", "mcp"] as const;
type TileId = (typeof TILE_IDS)[number];

export function StatusTab({
  ctx,
  version,
  isActive,
  onActivateTab,
  onRequestUpdate,
  onToast,
  onAlertChange,
  recentEvents,
}: StatusTabProps) {
  const [data, setData] = useState<StatusData>({
    doctor: null,
    mcp: [],
    hooksArmed: false,
    loading: true,
  });
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [tileCursor, setTileCursor] = useState<TileId>("cli");
  const dataStartedRef = useRef(false);
  const updateStartedRef = useRef(false);
  const lastCheckedAtRef = useRef<number | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

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

  const runUpdateCheck = useCallback(async () => {
    setUpdate({ status: "checking" });
    try {
      const result = await ctx.process.run("npm", ["view", ctx.runtime.packageName, "version"], {});
      if (result.code !== 0) {
        const msg = `npm view failed: ${result.stderr.trim() || "no detail"}`;
        setUpdate({ status: "error", message: msg });
        onToast?.({ tone: "err", title: "Update check failed", body: msg });
        return;
      }
      const latest = result.stdout.trim();
      if (!latest) {
        setUpdate({ status: "error", message: "npm view returned empty output." });
        return;
      }
      lastCheckedAtRef.current = Date.now();
      setLastCheckedAt(Date.now());
      if (latest === version) {
        setUpdate({ status: "uptodate", latest });
      } else {
        setUpdate({ status: "outdated", latest });
        onToast?.({
          tone: "info",
          title: "Update available",
          body: `v${version} → v${latest}`,
        });
      }
    } catch (err) {
      setUpdate({ status: "error", message: (err as Error).message });
    }
  }, [ctx, version, onToast]);

  useEffect(() => {
    if (updateStartedRef.current) return;
    updateStartedRef.current = true;
    void runUpdateCheck();
  }, [runUpdateCheck]);

  useEffect(() => {
    onAlertChange?.(update.status === "outdated");
  }, [update.status, onAlertChange]);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (update.status === "checking" || update.status === "applying") {
        // Solo bloquear teclas del update banner; navegación sigue.
      } else {
        if (input === "r" || input === "R") {
          void runUpdateCheck();
          return;
        }
        if ((input === "i" || input === "I") && update.status === "outdated") {
          setUpdate({ ...update, status: "applying" });
          onRequestUpdate?.();
          return;
        }
        if (input === "o" || input === "O") {
          onToast?.({
            tone: "info",
            title: "Release notes",
            body: `https://www.npmjs.com/package/${ctx.runtime.packageName}`,
          });
          return;
        }
      }
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
        if (tileCursor === "hosts") onActivateTab?.("skills");
        if (tileCursor === "mcp") onActivateTab?.("mcp");
      }
    },
    { isActive },
  );

  if (data.loading) {
    return (
      <Box>
        <Text color={colors.dim}>{icons.spinner} loading status…</Text>
      </Box>
    );
  }

  // Cross-reference HOSTS (7) con doctor.skill.targets (4 backed).
  const installedByTarget = new Map<string, boolean>(
    (data.doctor?.skill.targets ?? []).map((t) => [t.target, t.installed]),
  );
  const hostsInstalled = HOSTS.map((h) => ({
    host: h,
    installed: installedByTarget.get(h.id) === true,
  }));
  const installedHosts = hostsInstalled.filter((h) => h.installed).length;
  const supportedHosts = HOSTS.length;
  const backedHosts = HOSTS.filter((h) => h.backed).length;
  const pendingHosts = supportedHosts - backedHosts;
  const pct = supportedHosts > 0 ? Math.round((installedHosts / supportedHosts) * 100) : 0;

  const checkedAgo = lastCheckedAt ? humanizeAgo(lastCheckedAt) : "—";
  const showUpdateStrip = update.status === "outdated";

  const events: ActivityEvent[] = recentEvents ?? [];

  return (
    <Box flexDirection="column">
      <PageHead
        title="Status"
        count={{
          label: `${installedHosts}/${supportedHosts} hosts covered`,
          tone: installedHosts > 0 ? "accent" : "warn",
        }}
        action={
          <Text color={colors.mute}>
            checked {checkedAgo} · <Text color={colors.accent}>r</Text> recheck
          </Text>
        }
      />

      {showUpdateStrip ? (
        <UpdateStrip update={update} packageName={ctx.runtime.packageName} />
      ) : null}

      {/* Stat strip 4 tiles + WORKING TREE right */}
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
          sub="profile.json"
          tone={data.mcp.length > 0 ? "accent" : "dim"}
          clickable
          active={tileCursor === "mcp"}
        />
      </Box>

      <Text color={colors.borderFaint}>{"─".repeat(60)}</Text>

      <SectionHead
        label="Skill coverage"
        count={`${installedHosts}/${supportedHosts}`}
        hint={`${backedHosts} backed · ${pendingHosts} pending`}
        rightAction="⏎ open · ↑↓ select"
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

      <SectionHead label="Recent" count={events.length} marginTop={1} />
      <Box marginLeft={2}>
        <ActivityFeed events={events} cap={4} emptyHint="  (no recent activity yet)" />
      </Box>

      <Box marginTop={1}>
        <QuickActions
          actions={[
            ...(showUpdateStrip ? [{ key: "i", label: `apply v${update.latest ?? ""}` }] : []),
            { key: "r", label: "recheck" },
            { key: "^K", label: "palette" },
          ]}
        />
      </Box>
    </Box>
  );
}

function UpdateStrip({
  update,
  packageName,
}: {
  update: UpdateState;
  packageName: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={colors.warn}>{icons.focusBar}</Text>
        <Text> </Text>
        <Text color={colors.warn}>↻ </Text>
        <Text color={colors.bright} bold>
          v{packageName.split("/").pop()}
        </Text>
        <Text color={colors.dim}> → </Text>
        <Text color={colors.bright} bold>
          v{update.latest ?? "?"}
        </Text>
        <Text color={colors.dim}> available</Text>
        <Box flexGrow={1} />
        <Text color={colors.accent} bold inverse>
          {" i · apply "}
        </Text>
        <Text> </Text>
        <Text color={colors.mute}>r recheck · o notes · x dismiss</Text>
      </Box>
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

function humanizeAgo(t: number): string {
  const diffSec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
