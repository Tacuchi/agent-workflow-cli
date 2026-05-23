import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type SelfDoctorReport, selfDoctor } from "../../../application/self/doctor-self.js";
import type { SelfMcpConnectionView } from "../../../application/self/mcp-config.js";
import { selfMcpConfig } from "../../../application/self/mcp-config.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { FrameBox } from "../components/frame-box.js";
import { PageHead } from "../components/page-head.js";
import { Pill } from "../components/pill.js";
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
        const msg = `npm view falló: ${result.stderr.trim() || "sin detalle"}`;
        setUpdate({ status: "error", message: msg });
        onToast?.({ tone: "err", title: "Buscar actualización falló", body: msg });
        return;
      }
      const latest = result.stdout.trim();
      if (!latest) {
        setUpdate({ status: "error", message: "npm view devolvió output vacío." });
        return;
      }
      if (latest === version) {
        setUpdate({ status: "uptodate", latest });
      } else {
        setUpdate({ status: "outdated", latest });
        onToast?.({
          tone: "info",
          title: "Hay una actualización disponible",
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
        <Text color={colors.fgSubtle}>{icons.spinner} cargando estado…</Text>
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
  const supportedHosts = HOSTS.length; // 7
  const backedHosts = HOSTS.filter((h) => h.backed).length; // 4
  const pendingHosts = supportedHosts - backedHosts; // 3
  const pct = supportedHosts > 0 ? Math.round((installedHosts / supportedHosts) * 100) : 0;

  return (
    <Box flexDirection="column">
      <PageHead
        title="Status"
        count={{
          label: `${installedHosts}/${supportedHosts}`,
          tone: installedHosts > 0 ? "accent" : "warn",
        }}
        desc="runtime overview · skill coverage · mcp · update"
      />

      {/* Update banner */}
      <FrameBox
        title="update"
        accent={update.status === "outdated"}
        dim={update.status !== "outdated"}
      >
        <Box flexDirection="row">
          <Text color={colors.fgSubtle}>actual </Text>
          <Text color={colors.fgBright} bold>
            v{version}
          </Text>
          <Text color={colors.fgSubtle}> → última </Text>
          <Text
            color={update.status === "outdated" ? colors.accent : colors.fgBright}
            bold={update.status === "outdated"}
          >
            v{update.latest ?? "?"}
          </Text>
          {update.status === "outdated" ? (
            <Box marginLeft={1}>
              <Pill tone="accent">disponible</Pill>
            </Box>
          ) : update.status === "uptodate" ? (
            <Box marginLeft={1}>
              <Pill tone="ok">al día</Pill>
            </Box>
          ) : update.status === "checking" ? (
            <Box marginLeft={1}>
              <Text color={colors.fgSubtle}>{icons.spinner} consultando…</Text>
            </Box>
          ) : update.status === "error" ? (
            <Box marginLeft={1}>
              <Pill tone="err">error</Pill>
            </Box>
          ) : null}
          <Box flexGrow={1} />
          {update.status === "outdated" ? (
            <Text color={colors.accent} bold inverse>
              {` i · aplicar v${update.latest} `}
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="row">
          <Text color={colors.fgSubtle}>{ctx.runtime.packageName}</Text>
          <Text color={colors.fgFaint}> · </Text>
          <Text color={colors.fgSubtle}>registry.npmjs.org</Text>
          <Box flexGrow={1} />
          <Text color={colors.fgBright}>r</Text>
          <Text color={colors.fgSubtle}> recheck </Text>
          <Text color={colors.fgFaint}>·</Text>
          <Text color={colors.fgBright}> o</Text>
          <Text color={colors.fgSubtle}> release notes</Text>
        </Box>
        {update.status === "error" && update.message ? (
          <Text color={colors.error}>
            {icons.cross} {update.message}
          </Text>
        ) : null}
      </FrameBox>

      {/* Stat tiles 4-col */}
      <Box flexDirection="row">
        <StatTile
          label="cli"
          value={`v${data.doctor?.cli_version ?? version}`}
          sub={"@tacuchi"}
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

      {/* Skill coverage */}
      <FrameBox title="skill coverage">
        <Box flexDirection="row">
          <Text color={colors.fgBright} bold>
            {installedHosts}
          </Text>
          <Text color={colors.fgSubtle}> /{supportedHosts}</Text>
          <Text> </Text>
          <ProgressLine ratio={supportedHosts > 0 ? installedHosts / supportedHosts : 0} />
          <Box flexGrow={1} />
          <Text color={colors.fgSubtle}>
            {backedHosts} backed · {pendingHosts} pending
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="row" flexWrap="wrap">
          {hostsInstalled.map(({ host, installed }) => (
            <Box key={host.id} marginRight={1}>
              <Pill tone={installed ? "ok" : host.backed ? "muted" : "warn"} preserveCase>
                {host.name}
              </Pill>
            </Box>
          ))}
        </Box>
      </FrameBox>
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
  const width = 14;
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return (
    <Box>
      <Text color={colors.accent}>{"█".repeat(filled)}</Text>
      <Text color={colors.fgFaint}>{"░".repeat(width - filled)}</Text>
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
