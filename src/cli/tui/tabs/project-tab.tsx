import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ProjectPendingItem,
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
  const namespace = ctx.namespace.namespace;
  const desc = `.${namespace} · workspace mode auto-detected`;

  const events: ActivityEvent[] = data.activity.slice(0, 7).map((a, i) => ({
    id: `${a.whenIso}-${i}`,
    when: a.whenRel,
    dotColor: a.type === "commit" ? "info" : a.type === "session" ? "accent" : "purple",
    text: a.text,
    metaTone: "dim",
  }));

  return (
    <Box flexDirection="column">
      <PageHead
        title={`Project · ${data.workspaceMode === "hub" ? "hub" : "single-repo"} · ${data.workspaceName}`}
        action={<Text color={colors.mute}>{desc}</Text>}
      />

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

      <Text color={colors.borderFaint}>{"─".repeat(60)}</Text>

      {/* Two columns: Active sessions + Pending */}
      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          <SectionHead label="Active sessions" count={totalActiveSessions} rightAction="⏎ resume" />
          {totalActiveSessions === 0 ? (
            <Box marginLeft={2}>
              <Text color={colors.faint}>(none)</Text>
            </Box>
          ) : (
            <Box marginLeft={0} flexDirection="column">
              {data.sessions
                .filter((s) => s.state === "active")
                .slice(0, 6)
                .map((s) => (
                  <Box key={s.code}>
                    <Text color={colors.accent}>{icons.focusBar}</Text>
                    <Text color={colors.accent}> {icons.expandCollapsed} </Text>
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
          )}
        </Box>

        <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
          <SectionHead
            label="Pending"
            count={totalPending}
            hint={`${highPending} high · ${medPending} med · ${lowPending} low`}
          />
          {totalPending === 0 ? (
            <Box marginLeft={2}>
              <Text color={colors.faint}>(no pending)</Text>
            </Box>
          ) : (
            <Box marginLeft={0} flexDirection="column">
              {data.pending.slice(0, 7).map((p) => (
                <PendingRow key={`${p.sessionCode}-${p.text}`} item={p} />
              ))}
              {totalPending > 7 ? (
                <Text color={colors.faint}>…+{totalPending - 7} more</Text>
              ) : null}
            </Box>
          )}
        </Box>
      </Box>

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
