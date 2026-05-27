import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import {
  type ProjectPendingItem,
  type ProjectSessionSummary,
  type ProjectSource,
  type ProjectTabData,
  buildProjectTabData,
} from "../../../application/project-tab-data.js";
import type { CliContext } from "../../types.js";
import { type ActivityEvent, ActivityFeed } from "../components/activity-feed.js";
import { HubInitForm } from "../components/hub-init-form.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { StatTile } from "../components/stat-tile.js";
import { useInputLock } from "../input-lock.js";
import { colors, icons } from "../theme.js";

export interface ProjectTabProps {
  ctx: CliContext;
  isActive: boolean;
  onRunAction?: (id: string, payload?: Record<string, unknown>) => void;
}

export function ProjectTab({ ctx, isActive, onRunAction }: ProjectTabProps) {
  const [data, setData] = useState<ProjectTabData | null>(null);
  const [loading, setLoading] = useState(true);
  const [hubForm, setHubForm] = useState(false);
  const [landingCursor, setLandingCursor] = useState(0);
  const { lock, unlock } = useInputLock();

  const loadData = useCallback(async () => {
    try {
      const out = await buildProjectTabData({
        fs: ctx.fs,
        env: ctx.env,
        git: ctx.git,
        process: ctx.process,
        paths: ctx.paths,
      });
      setData(out);
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Mientras el form de hub está abierto, bloquea las teclas globales del shell.
  useEffect(() => {
    if (hubForm) lock();
    else unlock();
  }, [hubForm, lock, unlock]);
  useEffect(() => () => unlock(), [unlock]);

  // hub-init se resuelve con un form nativo en ink (no exit-to-CLI); el resto de
  // las opciones del landing salen al CLI vía onRunAction.
  const applyLandingChoice = useCallback(() => {
    const opt = LANDING_OPTIONS[landingCursor];
    if (!opt) return;
    if (opt.actionId === "hub-init") setHubForm(true);
    else onRunAction?.(opt.actionId);
  }, [landingCursor, onRunAction]);

  const handleInitKey = useCallback(
    (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
      if (!data || data.initialized) return false;
      if (key.upArrow) {
        setLandingCursor((c) => Math.max(0, c - 1));
        return true;
      }
      if (key.downArrow) {
        setLandingCursor((c) => Math.min(LANDING_OPTIONS.length - 1, c + 1));
        return true;
      }
      if (key.return) {
        applyLandingChoice();
        return true;
      }
      if (input === "g") {
        onRunAction?.("git:status");
        return true;
      }
      return false;
    },
    [data, applyLandingChoice, onRunAction],
  );

  useInput(
    (input, key) => {
      if (!data) return;
      if (handleInitKey(input, key)) return;
      if (input === "g") onRunAction?.("git:status");
      if (input === "c" && data.branches.length > 1) {
        const candidate = data.branches.find((b) => !b.current);
        if (candidate) onRunAction?.("git:checkout", { name: candidate.name });
      }
      if (input === "s") onRunAction?.("session:start");
      // Resume con ⏎ (la sección "Active sessions" ya anuncia "⏎ resume").
      // `r` queda libre para el refresh global del shell.
      if (key.return) {
        const active = data.sessions.find((s) => s.state === "active");
        if (active) onRunAction?.("session:resume", { code: active.code });
      }
    },
    { isActive: isActive && !!data && !hubForm },
  );

  if (loading || !data) {
    return (
      <Box>
        <Text color={colors.dim}>{icons.spinner} loading…</Text>
      </Box>
    );
  }

  if (!data.initialized) {
    if (hubForm) {
      return (
        <HubInitForm
          ctx={ctx}
          defaultProyecto={basename(data.workspacePath)}
          isActive={isActive}
          onCancel={() => setHubForm(false)}
          onDone={({ ok }) => {
            setHubForm(false);
            if (ok) void loadData();
          }}
        />
      );
    }
    return <NotInitialized data={data} cursor={landingCursor} />;
  }

  return <Initialized ctx={ctx} data={data} />;
}

// ===== Helpers de presentación =====

/**
 * Deriva un nombre corto del `block.proyecto`, que puede contener un párrafo
 * largo de descripción. Toma la primera línea no vacía, corta al primer
 * separador estructural (`·` / `:` / `.`) y trunca a ~40 chars.
 */
function deriveShortName(raw: string, fallback: string): string {
  const firstLine = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return fallback;
  const cut = firstLine.split(/[·:.]/)[0]?.trim() ?? firstLine;
  if (!cut) return fallback;
  return cut.length > 40 ? `${cut.slice(0, 39)}…` : cut;
}

/** Colapsa el `block.proyecto` multilínea en una sola línea, truncada a 80 chars. */
function deriveDescription(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** `~/Git/foo` en lugar del path absoluto. */
function tildePath(path: string, home: string): string {
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

/** Orden de sesiones más reciente primero: por código (zero-padded) desc. */
function byCodeDesc(a: ProjectSessionSummary, b: ProjectSessionSummary): number {
  return b.code.localeCompare(a.code);
}

/** Meta compacta de una sesión para el feed: `tipo · flujo · estado`. */
function sessionMeta(s: ProjectSessionSummary): string {
  return [s.type, s.flow, s.state].filter((v): v is string => Boolean(v)).join(" · ");
}

// ===== Landing — workspace no inicializado =====

interface LandingOption {
  actionId: string;
  cli: string;
  title: string;
  desc: string;
}

const LANDING_OPTIONS: readonly LandingOption[] = [
  {
    actionId: "project-init",
    cli: "agent-workflow project-md-upsert --init",
    title: "Initialize as single-repo",
    desc: "Generate AW-PROJECT block with detected git origin + main branch.",
  },
  {
    actionId: "hub-init",
    cli: "agent-workflow hub-init",
    title: "Initialize as hub (multi-repo)",
    desc: "Workspace orchestrates 2+ sources with their paths and main branches.",
  },
];

function NotInitialized({ data, cursor }: { data: ProjectTabData; cursor: number }) {
  return (
    <Box flexDirection="column">
      <PageHead
        title="Project"
        count={{ label: "not initialized", tone: "warn" }}
        action={<Text color={colors.mute}>AW-PROJECT not found in CLAUDE.md / AGENTS.md</Text>}
      />

      <SectionHead label="Choose initialization" marginTop={0} />
      <Box marginLeft={2} marginTop={0} flexDirection="column">
        {LANDING_OPTIONS.map((opt, i) => (
          <LandingRow key={opt.actionId} option={opt} active={i === cursor} />
        ))}
        <Text color={colors.dim}>↑↓ navigate · ⏎ apply</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.faint}>
          {icons.pin} {data.workspacePath}
        </Text>
        {data.git ? (
          <Box>
            <Text color={colors.faint}>
              {icons.branch} {data.git.branch} (base {data.git.base})
            </Text>
            {data.git.dirty > 0 ? (
              <>
                <Text> </Text>
                <Text color={colors.warn}>{data.git.dirty} uncommitted</Text>
              </>
            ) : null}
          </Box>
        ) : (
          <Text color={colors.faint}>(not a git repo)</Text>
        )}
      </Box>
    </Box>
  );
}

function LandingRow({ option, active }: { option: LandingOption; active: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={active ? colors.accent : colors.faint}>{active ? icons.focusBar : " "}</Text>
        <Text> </Text>
        <Text color={active ? colors.accent : colors.bright} bold={active}>
          {option.title}
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text color={colors.dim}>{option.desc}</Text>
        <Text color={active ? colors.accent : colors.info}>{option.cli}</Text>
      </Box>
    </Box>
  );
}

// ===== Inicializado — vista completa =====

function Initialized({ ctx, data }: { ctx: CliContext; data: ProjectTabData }) {
  const totalActiveSessions = data.sessions.filter((s) => s.state === "active").length;
  const totalSessions = data.sessions.length;
  const totalPending = data.pending.length;
  const highPending = data.pending.filter((p) => p.prio === "high").length;
  const medPending = data.pending.filter((p) => p.prio === "med").length;
  const lowPending = data.pending.filter((p) => p.prio === "low").length;
  const dirty = data.git?.dirty ?? 0;

  const home = ctx.env.homeDir();
  const shortName = deriveShortName(data.workspaceName, basename(data.workspacePath));
  const description = deriveDescription(data.workspaceName);
  const wsPath = tildePath(data.workspacePath, home);

  // Recent sessions: las más recientes primero (por código), con tipo/flujo/estado.
  const events: ActivityEvent[] = [...data.sessions]
    .sort(byCodeDesc)
    .slice(0, 7)
    .map((s) => ({
      id: `session-${s.code}`,
      when: s.date ?? "",
      dotColor: s.state === "active" ? "accent" : "dim",
      text: `session${s.code} · ${s.name}`,
      meta: sessionMeta(s),
      metaTone: "dim",
    }));

  const isHub = data.workspaceMode === "hub";
  const showSources = isHub && data.sources.length > 0;
  const activeSessions = data.sessions.filter((s) => s.state === "active").slice(0, 6);

  return (
    <Box flexDirection="column">
      <PageHead
        title={`Project · ${isHub ? "hub" : "single-repo"} · ${shortName}`}
        action={<Text color={colors.faint}>{wsPath}</Text>}
      />
      {description ? (
        <Box marginBottom={1}>
          <Text color={colors.dim} wrap="truncate-end">
            {description}
          </Text>
        </Box>
      ) : null}

      {/* Health cards 2x2 (rendered as 4 tiles in a row) */}
      <Box flexDirection="row" marginBottom={1}>
        <StatTile label="git" value={data.git?.branch ?? "—"} sub={statGitSub(data)} accent />
        <StatTile
          label="working tree"
          value={`${dirty} dirty`}
          sub={`${data.git?.staged ?? 0} staged · ${data.git?.untracked ?? 0} untracked`}
          tone={dirty > 0 ? "warn" : "dim"}
        />
        <StatTile
          label="sessions"
          value={`${totalActiveSessions} active`}
          sub={`${totalSessions} total`}
          tone={totalActiveSessions > 0 ? "accent" : "dim"}
        />
        <StatTile
          label="pending"
          value={`${totalPending} tasks`}
          sub={`${highPending} high · ${medPending} med · ${lowPending} low`}
          tone={highPending > 0 ? "warn" : "dim"}
        />
      </Box>

      {showSources ? (
        <>
          <SectionHead label="Sources" count={data.sources.length} marginTop={1} />
          <Box marginLeft={2} flexDirection="column">
            {data.sources.map((s) => (
              <SourceRow key={s.alias} source={s} />
            ))}
          </Box>
        </>
      ) : null}

      {totalActiveSessions > 0 ? (
        <>
          <SectionHead
            label="Active sessions"
            count={totalActiveSessions}
            rightAction="⏎ resume"
            marginTop={1}
          />
          <Box marginLeft={2} flexDirection="column">
            {activeSessions.map((s) => (
              <Box key={s.code}>
                <Text color={colors.accent}>{icons.expandCollapsed} </Text>
                <Text color={colors.bright}>session{s.code}</Text>
                <Text color={colors.dim}> · </Text>
                <Text color={colors.dim}>{s.name}</Text>
                <Text color={colors.dim}> · phase </Text>
                <Text color={colors.accent}>{s.phase}</Text>
                <Text> </Text>
                <Text color={colors.purple}>[{s.flow}]</Text>
              </Box>
            ))}
          </Box>
        </>
      ) : null}

      {totalPending > 0 ? (
        <>
          <SectionHead
            label="Pending"
            count={totalPending}
            hint={`${highPending} high · ${medPending} med · ${lowPending} low`}
            marginTop={1}
          />
          <Box marginLeft={2} flexDirection="column">
            {data.pending.slice(0, 7).map((p) => (
              <PendingRow key={`${p.sessionCode}-${p.text}`} item={p} />
            ))}
            {totalPending > 7 ? <Text color={colors.faint}>…+{totalPending - 7} more</Text> : null}
          </Box>
        </>
      ) : null}

      {/* Recent sessions full-width */}
      <SectionHead label="Recent sessions" count={events.length} marginTop={1} />
      <Box marginLeft={2}>
        <ActivityFeed events={events} cap={7} emptyHint="  (no sessions yet)" />
      </Box>

      <Box marginTop={1}>
        <QuickActions actions={[{ key: "s", label: "start session" }]} />
      </Box>
    </Box>
  );
}

function SourceRow({ source }: { source: ProjectSource }) {
  const status = source.dirty ? `${source.changedFiles} dirty` : "in sync";
  const statusColor = source.dirty ? colors.warn : colors.ok;
  const branch = source.branch ?? source.mainBranch;
  return (
    <Box>
      <Text color={colors.accent}>{icons.diamond} </Text>
      <Text color={colors.bright} bold>
        {source.alias}
      </Text>
      {/* Cluster derecho: estado a la izquierda de la rama, todo alineado a la derecha. */}
      <Box flexGrow={1} />
      <Text color={statusColor}>{status}</Text>
      <Text color={colors.faint}> · </Text>
      <Text color={colors.dim}>
        {icons.branch} {branch}
      </Text>
    </Box>
  );
}

function statGitSub(data: ProjectTabData): string {
  if (!data.git) return "—";
  // Tile GIT: el `value` es la rama de trabajo; este `sub` es la rama principal
  // (debajo). ahead/behind van como sufijo compacto sólo si difiere.
  const base = `base ${data.git.base}`;
  const sync: string[] = [];
  if (data.git.ahead > 0) sync.push(`↑${data.git.ahead}`);
  if (data.git.behind > 0) sync.push(`↓${data.git.behind}`);
  return sync.length > 0 ? `${base} · ${sync.join(" ")}` : base;
}

function PendingRow({ item }: { item: ProjectPendingItem }) {
  const prioColor =
    item.prio === "high" ? colors.err : item.prio === "med" ? colors.warn : colors.mute;
  return (
    <Box>
      <Text color={prioColor}>● </Text>
      <Text color={colors.text}>{item.text}</Text>
      <Box flexGrow={1} />
      <Text color={colors.dim}>{item.sessionLabel}</Text>
    </Box>
  );
}
