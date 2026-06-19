import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import {
  type ProjectSource,
  type ProjectTabData,
  buildProjectTabData,
} from "../../../application/project-tab-data.js";
import type { CliContext } from "../../types.js";
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
  const [initForm, setInitForm] = useState(false);
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

  // Mientras el form de workspace-init está abierto, bloquea las teclas globales.
  useEffect(() => {
    if (initForm) lock();
    else unlock();
  }, [initForm, lock, unlock]);
  useEffect(() => () => unlock(), [unlock]);

  const handleInitKey = useCallback(
    (input: string, key: { return?: boolean }) => {
      if (!data || data.initialized) return false;
      if (key.return) {
        setInitForm(true);
        return true;
      }
      if (input === "g") {
        onRunAction?.("git:status");
        return true;
      }
      return false;
    },
    [data, onRunAction],
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
    },
    { isActive: isActive && !!data && !initForm },
  );

  if (loading || !data) {
    return (
      <Box>
        <Text color={colors.dim}>{icons.spinner} loading…</Text>
      </Box>
    );
  }

  if (!data.initialized) {
    if (initForm) {
      return (
        <HubInitForm
          ctx={ctx}
          defaultProyecto={basename(data.workspacePath)}
          isActive={isActive}
          onCancel={() => setInitForm(false)}
          onDone={({ ok }) => {
            setInitForm(false);
            if (ok) void loadData();
          }}
        />
      );
    }
    return <NotInitialized data={data} />;
  }

  return <Initialized ctx={ctx} data={data} />;
}

// ===== Helpers de presentación =====

/**
 * Deriva un nombre corto del `workspaceName`, que puede contener un párrafo
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

/** Colapsa el `workspaceName` multilínea en una sola línea, truncada a 80 chars. */
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

// ===== Landing — workspace no inicializado =====

function NotInitialized({ data }: { data: ProjectTabData }) {
  return (
    <Box flexDirection="column">
      <PageHead
        title="Workspace"
        count={{ label: "not initialized", tone: "warn" }}
        action={<Text color={colors.mute}>WORKSPACE block not found in CLAUDE.md / AGENTS.md</Text>}
      />

      <SectionHead label="Initialize workspace" marginTop={0} />
      <Box marginLeft={2} marginTop={0} flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.bright} bold>
            Initialize this directory as a workspace
          </Text>
          <Box marginLeft={2} flexDirection="column">
            <Text color={colors.dim}>
              Collect 1+ sources (alias · path · main branch) and optional working branches.
            </Text>
            <Text color={colors.info}>/w:workspace-init</Text>
          </Box>
        </Box>
        <Text color={colors.dim}>⏎ start wizard</Text>
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

// ===== Inicializado — vista WORKSPACE =====

function Initialized({ ctx, data }: { ctx: CliContext; data: ProjectTabData }) {
  const dirty = data.git?.dirty ?? 0;
  const totalSources = data.sources.length;
  const dirtySources = data.sources.filter((s) => s.dirty).length;
  const workingEntries = Object.entries(data.workingBranches);

  const home = ctx.env.homeDir();
  const shortName = deriveShortName(data.workspaceName, basename(data.workspacePath));
  const description = deriveDescription(data.workspaceName);
  const wsPath = tildePath(data.workspacePath, home);

  return (
    <Box flexDirection="column">
      <PageHead
        title={`Workspace · ${shortName}`}
        action={<Text color={colors.faint}>{wsPath}</Text>}
      />
      {description ? (
        <Box marginBottom={1}>
          <Text color={colors.dim} wrap="truncate-end">
            {description}
          </Text>
        </Box>
      ) : null}

      {/* Health cards */}
      <Box flexDirection="row" marginBottom={1}>
        <StatTile label="git" value={data.git?.branch ?? "—"} sub={statGitSub(data)} accent />
        <StatTile
          label="working tree"
          value={`${dirty} dirty`}
          sub={`${data.git?.staged ?? 0} staged · ${data.git?.untracked ?? 0} untracked`}
          tone={dirty > 0 ? "warn" : "dim"}
        />
        <StatTile
          label="sources"
          value={`${totalSources}`}
          sub={`${dirtySources} dirty`}
          tone={totalSources > 0 ? "accent" : "dim"}
        />
        <StatTile
          label="working branches"
          value={`${workingEntries.length}`}
          sub={workingEntries.length > 0 ? "declared" : "none"}
          tone={workingEntries.length > 0 ? "accent" : "dim"}
        />
      </Box>

      {totalSources > 0 ? (
        <>
          <SectionHead label="Sources" count={totalSources} marginTop={1} />
          <Box marginLeft={2} flexDirection="column">
            {data.sources.map((s) => (
              <SourceRow key={s.alias} source={s} />
            ))}
          </Box>
        </>
      ) : null}

      <SectionHead label="Ramas de trabajo actuales" count={workingEntries.length} marginTop={1} />
      <Box marginLeft={2} flexDirection="column">
        {workingEntries.length > 0 ? (
          workingEntries.map(([alias, branch]) => (
            <Box key={alias}>
              <Text color={colors.accent}>{icons.diamond} </Text>
              <Text color={colors.bright} bold>
                {alias}
              </Text>
              <Box flexGrow={1} />
              <Text color={colors.dim}>
                {icons.branch} {branch}
              </Text>
            </Box>
          ))
        ) : (
          <Text color={colors.faint}>(no working branches declared)</Text>
        )}
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
      <Text color={colors.faint}> · main {source.mainBranch}</Text>
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
