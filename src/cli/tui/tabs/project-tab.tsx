import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ProjectActivityEntry,
  type ProjectPendingItem,
  type ProjectSource,
  type ProjectTabData,
  buildProjectTabData,
} from "../../../application/project-tab-data.js";
import type { CliContext } from "../../types.js";
import { FrameBox } from "../components/frame-box.js";
import { PageHead } from "../components/page-head.js";
import { Pill } from "../components/pill.js";
import { colors, icons } from "../theme.js";

export interface ProjectTabProps {
  ctx: CliContext;
  isActive: boolean;
  /** Callback opcional para emitir toasts del tab */
  onRunAction?: (id: string, payload?: Record<string, unknown>) => void;
}

/**
 * ProjectTab — vista agregada del workspace.
 *
 * Dos estados:
 * - **No inicializado** (sin bloque AW-PROJECT en CLAUDE.md/AGENTS.md) →
 *   landing con instrucciones para `project-init` o `hub-init` + info detectada
 *   (cwd, git).
 * - **Inicializado** → stat strip + git workspace + sesiones + pendientes +
 *   actividad. En hub mode, también lista de sources con dirty status.
 */
export function ProjectTab({ ctx, isActive, onRunAction }: ProjectTabProps) {
  const [data, setData] = useState<ProjectTabData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingFilter, setPendingFilter] = useState<string>("all");
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
    },
    { isActive: isActive && !!data },
  );

  const filteredPending = useMemo(() => {
    if (!data) return [];
    if (pendingFilter === "all") return data.pending;
    if (pendingFilter === "high") return data.pending.filter((p) => p.prio === "high");
    return data.pending.filter((p) => p.sessionCode === pendingFilter);
  }, [data, pendingFilter]);

  if (loading || !data) {
    return (
      <Box>
        <Text color={colors.fgSubtle}>{icons.spinner} cargando…</Text>
      </Box>
    );
  }

  if (!data.initialized) {
    return <NotInitialized data={data} cursor={landingCursor} />;
  }

  return (
    <Initialized
      data={data}
      pendingFilter={pendingFilter}
      filteredPending={filteredPending}
      onFilter={setPendingFilter}
    />
  );
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
    title: "Inicializar como single-repo",
    desc: "Genera el bloque AW-PROJECT con git origin + main branch detectado.",
  },
  {
    actionId: "hub-init",
    cli: "agent-workflow hub-init",
    title: "Inicializar como hub (multi-repo)",
    desc: "Workspace orquesta 2+ fuentes con sus paths y main branches.",
  },
];

function NotInitialized({ data, cursor }: { data: ProjectTabData; cursor: number }) {
  return (
    <Box flexDirection="column">
      <PageHead title="Proyecto" count={{ label: "no inicializado", tone: "warn" }} />
      <Text color={colors.fgSubtle}>
        No encuentro bloque AW-PROJECT en CLAUDE.md / AGENTS.md de este directorio.
      </Text>

      <Box marginTop={1}>
        <FrameBox title="elegí cómo inicializar" accent>
          {LANDING_OPTIONS.map((opt, i) => (
            <LandingRow key={opt.actionId} option={opt} active={i === cursor} />
          ))}
          <Text color={colors.fgSubtle}>↑↓ navegar · ⏎ aplicar</Text>
        </FrameBox>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.fgFaint}>
          {icons.pin} {data.workspacePath}
        </Text>
        {data.git ? (
          <Box>
            <Text color={colors.fgFaint}>
              {icons.branch} {data.git.branch} (base {data.git.base})
            </Text>
            {data.git.dirty > 0 ? (
              <Box marginLeft={1}>
                <Pill tone="warn">{`${data.git.dirty} sin commit`}</Pill>
              </Box>
            ) : null}
          </Box>
        ) : (
          <Text color={colors.fgFaint}>(no es un repo git)</Text>
        )}
      </Box>
    </Box>
  );
}

function LandingRow({ option, active }: { option: LandingOption; active: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={active ? colors.accent : colors.fgFaint} {...(active ? { bold: true } : {})}>
          {active ? "▸" : " "}
        </Text>
        <Text> </Text>
        <Text color={active ? colors.accent : colors.fgBright} {...(active ? { bold: true } : {})}>
          {option.title}
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text color={colors.fgSubtle}>{option.desc}</Text>
        <Text color={active ? colors.accent : colors.info}>{option.cli}</Text>
      </Box>
    </Box>
  );
}

// ===== Inicializado — vista completa =====

function Initialized({
  data,
  pendingFilter,
  filteredPending,
  onFilter,
}: {
  data: ProjectTabData;
  pendingFilter: string;
  filteredPending: ProjectPendingItem[];
  onFilter: (id: string) => void;
}) {
  const totalSessions = data.sessions.filter((s) => s.state === "active").length;
  const totalPending = data.pending.length;
  const highPending = data.pending.filter((p) => p.prio === "high").length;

  return (
    <Box flexDirection="column">
      {/* Stat strip */}
      <Box>
        <StatCell
          label="git"
          value={data.git?.branch ?? "—"}
          sub={statGitSub(data)}
          color={colors.fgBright}
        />
        <Box marginLeft={3}>
          <StatCell
            label="working tree"
            value={`${data.git?.dirty ?? 0}`}
            sub={`${data.git?.staged ?? 0} staged · ${data.git?.untracked ?? 0} untracked`}
            color={(data.git?.dirty ?? 0) > 0 ? colors.warning : colors.fgBright}
          />
        </Box>
        <Box marginLeft={3}>
          <StatCell
            label="sesiones"
            value={`${totalSessions}`}
            sub={`${data.sessions.length} totales`}
            color={colors.fgBright}
          />
        </Box>
        <Box marginLeft={3}>
          <StatCell
            label="pendientes"
            value={`${totalPending}`}
            sub={highPending > 0 ? `${highPending} altas` : ""}
            color={highPending > 0 ? colors.error : colors.fgBright}
          />
        </Box>
      </Box>

      {data.workspaceMode === "hub" && data.sources.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <SectionLabel label="sources" right={`${data.sources.length}`} />
          {data.sources.map((s) => (
            <SourceRow key={s.alias} source={s} />
          ))}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <SectionLabel
          label="git workspace"
          right={
            data.git?.lastCommit
              ? `${data.git.lastCommit.sha} · ${data.git.lastCommit.whenRel}`
              : ""
          }
        />
        {data.git ? (
          <GitWorkspace data={data} />
        ) : (
          <Text color={colors.fgFaint}>(no git repo)</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SectionLabel label="sesiones activas" right={`${totalSessions}`} />
        {totalSessions === 0 ? (
          <Text color={colors.fgFaint}>(ninguna)</Text>
        ) : (
          data.sessions
            .filter((s) => s.state === "active")
            .slice(0, 6)
            .map((s) => (
              <Box key={s.code}>
                <Text color={colors.accent}>{icons.chevron}</Text>
                <Text> </Text>
                <Text color={colors.fgBright}>session{s.code}</Text>
                <Text color={colors.fgFaint}> · </Text>
                <Text color={colors.info}>{s.flow}</Text>
                <Text color={colors.fgFaint}> · </Text>
                <Text color={colors.fgSubtle}>{s.name}</Text>
                <Text color={colors.fgFaint}> ({s.phase})</Text>
              </Box>
            ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SectionLabel label="pendientes" right={`${filteredPending.length} de ${totalPending}`} />
        <PendingFilters
          current={pendingFilter}
          options={buildPendingFilters(data.pending)}
          onChange={onFilter}
        />
        {filteredPending.length === 0 ? (
          <Text color={colors.fgFaint}>(sin pendientes en este filtro)</Text>
        ) : (
          filteredPending
            .slice(0, 8)
            .map((p) => <PendingRow key={`${p.sessionCode}-${p.text}`} item={p} />)
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SectionLabel label="actividad reciente" right={`${data.activity.length}`} />
        {data.activity.length === 0 ? (
          <Text color={colors.fgFaint}>(sin actividad)</Text>
        ) : (
          data.activity
            .slice(0, 6)
            .map((a) => <ActivityRow key={`${a.whenIso}-${a.type}-${a.text}`} entry={a} />)
        )}
      </Box>
    </Box>
  );
}

// ===== sub-components =====

function SectionLabel({ label, right }: { label: string; right?: string }) {
  return (
    <Box>
      <Text color={colors.fgMoreSubtle}>{label.toUpperCase()}</Text>
      {right ? (
        <>
          <Text color={colors.fgFaint}> · </Text>
          <Text color={colors.fgFaint}>{right}</Text>
        </>
      ) : null}
    </Box>
  );
}

function StatCell({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <Box flexDirection="column" minWidth={18}>
      <Text color={colors.fgMoreSubtle}>{label}</Text>
      <Text color={color} bold>
        {value}
      </Text>
      {sub ? <Text color={colors.fgFaint}>{sub}</Text> : null}
    </Box>
  );
}

function statGitSub(data: ProjectTabData): string {
  if (!data.git) return "—";
  const parts: string[] = [];
  if (data.git.ahead > 0) parts.push(`↑${data.git.ahead}`);
  if (data.git.behind > 0) parts.push(`↓${data.git.behind}`);
  if (parts.length === 0) return `en sync con ${data.git.base}`;
  return parts.join(" / ");
}

function GitWorkspace({ data }: { data: ProjectTabData }) {
  if (!data.git) return null;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.fgBright}>{data.git.branch}</Text>
        <Text color={colors.fgFaint}> ← </Text>
        <Text color={colors.fgSubtle}>{data.git.base}</Text>
        {data.git.ahead > 0 ? (
          <Box marginLeft={1}>
            <Text color={colors.info}>↑{data.git.ahead}</Text>
          </Box>
        ) : null}
        {data.git.behind > 0 ? (
          <Box marginLeft={1}>
            <Text color={colors.warning}>↓{data.git.behind}</Text>
          </Box>
        ) : null}
      </Box>
      {data.git.lastCommit ? (
        <Box>
          <Text color={colors.info}>{data.git.lastCommit.sha}</Text>
          <Text> </Text>
          <Text color={colors.fgBright}>{data.git.lastCommit.title}</Text>
          <Text color={colors.fgFaint}> · </Text>
          <Text color={colors.fgMoreSubtle}>{data.git.lastCommit.author}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SourceRow({ source }: { source: ProjectSource }) {
  return (
    <Box>
      <Text color={colors.fgFaint}>·</Text>
      <Text> </Text>
      <Text color={colors.fgBright}>{source.alias}</Text>
      <Text color={colors.fgFaint}> · </Text>
      <Text color={colors.fgSubtle}>{source.branch ?? "(detached)"}</Text>
      {source.dirty ? (
        <Box marginLeft={1}>
          <Text color={colors.warning}>{source.changedFiles} sin commit</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function buildPendingFilters(items: ProjectPendingItem[]): { id: string; label: string }[] {
  const seen = new Set<string>();
  const opts: { id: string; label: string }[] = [
    { id: "all", label: "todos" },
    { id: "high", label: "altas" },
  ];
  for (const it of items) {
    if (!seen.has(it.sessionCode)) {
      seen.add(it.sessionCode);
      opts.push({ id: it.sessionCode, label: `s${it.sessionCode}` });
    }
  }
  return opts;
}

function PendingFilters({
  current,
  options,
}: {
  current: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <Box>
      {options.map((o, idx) => (
        <Box key={o.id} marginLeft={idx === 0 ? 0 : 2}>
          <Text
            color={current === o.id ? colors.accent : colors.fgFaint}
            {...(current === o.id ? { bold: true } : {})}
          >
            {o.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function PendingRow({ item }: { item: ProjectPendingItem }) {
  const prioColor =
    item.prio === "high" ? colors.error : item.prio === "med" ? colors.warning : colors.fgFaint;
  return (
    <Box>
      <Text color={prioColor}>·</Text>
      <Text> </Text>
      <Text color={colors.fgBright}>{item.text}</Text>
      <Text color={colors.fgFaint}> · </Text>
      <Text color={colors.fgMoreSubtle}>{item.sessionLabel}</Text>
    </Box>
  );
}

function ActivityRow({ entry }: { entry: ProjectActivityEntry }) {
  const typeColor =
    entry.type === "commit"
      ? colors.info
      : entry.type === "session"
        ? colors.accent
        : colors.fgSubtle;
  return (
    <Box>
      <Text color={typeColor}>{entry.type}</Text>
      <Text color={colors.fgFaint}> · </Text>
      <Text color={colors.fgBright}>{entry.text}</Text>
      <Text color={colors.fgFaint}> · </Text>
      <Text color={colors.fgMoreSubtle}>{entry.whenRel}</Text>
    </Box>
  );
}
