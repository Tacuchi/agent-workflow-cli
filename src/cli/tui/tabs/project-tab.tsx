import { basename, relative } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ProjectPendingItem,
  type ProjectSource,
  type ProjectTabData,
  buildProjectTabData,
} from "../../../application/project-tab-data.js";
import type { CliContext } from "../../types.js";
import { type ActivityEvent, ActivityFeed } from "../components/activity-feed.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { StatTile } from "../components/stat-tile.js";
import { colors, icons } from "../theme.js";

export interface ProjectTabProps {
  ctx: CliContext;
  isActive: boolean;
  onRunAction?: (id: string, payload?: Record<string, unknown>) => void;
}

export function ProjectTab({ ctx, isActive, onRunAction }: ProjectTabProps) {
  const [data, setData] = useState<ProjectTabData | null>(null);
  const [loading, setLoading] = useState(true);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
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
    })();
  }, [ctx]);

  const [landingCursor, setLandingCursor] = useState(0);

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
        const opt = LANDING_OPTIONS[landingCursor];
        if (opt) onRunAction?.(opt.actionId);
        return true;
      }
      if (input === "g") {
        onRunAction?.("git:status");
        return true;
      }
      return false;
    },
    [data, landingCursor, onRunAction],
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
      if (input === "r") {
        const active = data.sessions.find((s) => s.state === "active");
        if (active) onRunAction?.("session:resume", { code: active.code });
      }
    },
    { isActive: isActive && !!data },
  );

  if (loading || !data) {
    return (
      <Box>
        <Text color={colors.dim}>{icons.spinner} loading…</Text>
      </Box>
    );
  }

  if (!data.initialized) {
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

const ACTIVITY_UNIT_SHORT: Record<string, string> = {
  second: "s",
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};

/** `21 minutes ago` → `21m ago`, `2 hours ago` → `2h ago`, etc. */
function formatActivityWhen(whenRel: string): string {
  const m = whenRel.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!m) return whenRel;
  const unit = m[2]?.toLowerCase() ?? "";
  const short = ACTIVITY_UNIT_SHORT[unit] ?? unit;
  return `${m[1]}${short} ago`;
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

  const events: ActivityEvent[] = data.activity.slice(0, 7).map((a, i) => ({
    id: `${a.whenIso}-${i}`,
    when: formatActivityWhen(a.whenRel),
    dotColor: a.type === "commit" ? "info" : a.type === "session" ? "accent" : "purple",
    text: a.text,
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
              <SourceRow key={s.alias} source={s} workspacePath={data.workspacePath} />
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

      {/* Recent activity full-width */}
      <SectionHead label="Recent activity" count={events.length} marginTop={1} />
      <Box marginLeft={2}>
        <ActivityFeed events={events} cap={7} emptyHint="  (no recent activity yet)" />
      </Box>

      <Box marginTop={1}>
        <QuickActions actions={[{ key: "s", label: "start session" }]} />
      </Box>
    </Box>
  );
}

function SourceRow({ source, workspacePath }: { source: ProjectSource; workspacePath: string }) {
  const rel = relative(workspacePath, source.path) || ".";
  const status = source.dirty ? `${source.changedFiles} dirty` : "in sync";
  const statusColor = source.dirty ? colors.warn : colors.ok;
  return (
    <Box>
      <Text color={colors.accent}>{icons.diamond} </Text>
      <Text color={colors.bright} bold>
        {source.alias}
      </Text>
      <Text color={colors.dim}> → </Text>
      <Text color={colors.dim}>{rel}</Text>
      <Text color={colors.faint}> · </Text>
      <Text color={colors.dim}>
        {icons.branch} {source.branch ?? source.mainBranch}
      </Text>
      <Text color={colors.faint}> · </Text>
      <Text color={statusColor}>{status}</Text>
    </Box>
  );
}

function statGitSub(data: ProjectTabData): string {
  if (!data.git) return "—";
  const parts: string[] = [];
  if (data.git.ahead > 0) parts.push(`↑${data.git.ahead}`);
  if (data.git.behind > 0) parts.push(`↓${data.git.behind}`);
  if (parts.length === 0) return `in sync with ${data.git.base}`;
  return `${parts.join(" / ")} · base ${data.git.base}`;
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
