import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { type SelfDoctorReport, selfDoctor } from "../../../application/self/doctor-self.js";
import type { SelfMcpConnectionView } from "../../../application/self/mcp-config.js";
import { selfMcpConfig } from "../../../application/self/mcp-config.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { type ActivityEvent, ActivityFeed } from "../components/activity-feed.js";
import { PageHead } from "../components/page-head.js";
import { SectionHead } from "../components/section-head.js";
import { StatTile } from "../components/stat-tile.js";
import { HOSTS } from "../hosts.js";
import { colors, icons } from "../theme.js";

export interface StatusTabProps {
  ctx: CliContext;
  version: string;
  isActive: boolean;
  onActivateTab?: (tab: "mcp" | "skills") => void;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
  /** Eventos recientes (activity feed). Si vacío, se renderiza empty-state. */
  recentEvents?: ActivityEvent[];
  /** Hosts deshabilitados en Config: se excluyen del cómputo de cobertura. */
  disabledHosts?: string[];
}

interface StatusData {
  doctor: SelfDoctorReport | null;
  mcp: SelfMcpConnectionView[];
  hooksArmed: boolean;
  loading: boolean;
}

const TILE_IDS = ["cli", "hosts", "hooks", "mcp"] as const;
type TileId = (typeof TILE_IDS)[number];

export function StatusTab({
  ctx,
  version,
  isActive,
  onActivateTab,
  recentEvents,
  disabledHosts = [],
}: StatusTabProps) {
  const [data, setData] = useState<StatusData>({
    doctor: null,
    mcp: [],
    hooksArmed: false,
    loading: true,
  });
  const [tileCursor, setTileCursor] = useState<TileId>("cli");
  const dataStartedRef = useRef(false);

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

  // El update-check + banner ahora viven en el AppShell vía NotificationCenter.
  // Esta tab sólo navega tiles y delega `⏎` en hosts/mcp para cambiar de tab.
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

  // Cross-reference HOSTS con doctor.skill.targets. Los hosts deshabilitados en
  // Config salen del cómputo de cobertura y de los chips (opt-out de targeting).
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

  const events: ActivityEvent[] = recentEvents ?? [];

  return (
    <Box flexDirection="column">
      <PageHead
        title="Status"
        count={{
          label: `${installedHosts}/${supportedHosts} hosts covered`,
          tone: installedHosts > 0 ? "accent" : "warn",
        }}
      />

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
        <ActivityFeed events={events} cap={5} emptyHint="  (no sessions yet)" />
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
