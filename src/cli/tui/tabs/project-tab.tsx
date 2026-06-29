import { basename } from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type GitFlowAction,
  type GitFlowInput,
  type GitFlowResult,
  runGitFlow,
} from "../../../application/git-flow-service.js";
import type { ProcessRecord } from "../../../application/process-registry-service.js";
import {
  type ProjectSource,
  type ProjectTabData,
  buildProjectTabData,
} from "../../../application/project-tab-data.js";
import type { LaunchDescriptor } from "../../../application/source-launch-scripts-service.js";
import {
  type LaunchDeps,
  type LaunchRequest,
  findCollision,
  launchSource,
  readDescriptor,
  relaunchProcess,
  stopProcess,
  tailLog,
} from "../../../application/source-launch-service.js";
import { removeSource } from "../../../application/source-remove-service.js";
import type { CliContext } from "../../types.js";
import {
  type DetailAction,
  DetailPanel,
  type DetailStatePill,
} from "../components/detail-panel.js";
import { FlowResultView } from "../components/git-flow-actions.js";
import { ListRow } from "../components/list-row.js";
import { PageHead } from "../components/page-head.js";
import { ProcessList } from "../components/process-list.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { type LaunchFormValue, SourceLaunchForm } from "../components/source-launch-form.js";
import { StatTile } from "../components/stat-tile.js";
import { WorkspaceInitForm } from "../components/workspace-init-form.js";
import { useInputLock } from "../input-lock.js";
import { rowWidth } from "../row-width.js";
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

  // Mientras el wizard de init está abierto, bloquea las teclas globales para que
  // sus inputs no naveguen entre tabs. La vista inicializada (Initialized) maneja
  // su propio lock para el detail panel / flujo en curso.
  useEffect(() => {
    if (initForm) lock();
    else unlock();
  }, [initForm, lock, unlock]);
  useEffect(() => () => unlock(), [unlock]);

  // Teclas de la landing "no inicializado" (⏎ abre el wizard · g git status).
  useInput(
    (input, key) => {
      if (!data || data.initialized) return;
      if (key.return) {
        setInitForm(true);
        return;
      }
      if (input === "g") onRunAction?.("git:status");
    },
    { isActive: isActive && !!data && !data.initialized && !initForm },
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
        <WorkspaceInitForm
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

  return (
    <Initialized
      ctx={ctx}
      data={data}
      isActive={isActive}
      onRunAction={onRunAction}
      onReload={loadData}
    />
  );
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

/** Centinela de target = "todas las fuentes". Alias imposible (no colisiona). */
const ALL_SOURCES = " all-sources";

/**
 * Las tres acciones git-flow por-fuente, en el orden que pidió el usuario.
 * Mapean 1:1 a {@link GitFlowAction}:
 *  - `sync`    → "Alinear con PROD" (merge prod→work: trae PROD a la rama de trabajo)
 *  - `to-qa`   → "Enviar a QA"
 *  - `to-prod` → "Enviar a PROD"
 */
const FLOW_ACTIONS: { id: GitFlowAction; name: string; description: string }[] = [
  { id: "sync", name: "Alinear con PROD", description: "merge prod→work" },
  { id: "to-qa", name: "Enviar a QA", description: "sync + prod/work→qa + push" },
  { id: "to-prod", name: "Enviar a PROD", description: "sync + work→prod + push" },
];

type Mode =
  | { kind: "list" }
  | { kind: "detail" }
  | { kind: "running"; label: string }
  | { kind: "result"; action: GitFlowAction; result: GitFlowResult }
  // ===== Source removal =====
  | { kind: "confirm-remove"; alias: string }
  // ===== Source-launch + process management =====
  | { kind: "process" } // process region focused
  | { kind: "launch-form"; alias: string; descriptor: LaunchDescriptor }
  | { kind: "busy"; label: string }
  | { kind: "collision"; req: LaunchRequest; existing: ProcessRecord }
  | { kind: "notice"; tone: "ok" | "err"; lines: string[] }
  | { kind: "log"; record: ProcessRecord; lines: string[] };

/** First per-source detail action: launch the app locally. */
const LAUNCH_ACTION = { id: "launch", name: "Lanzar en local" } as const;

/**
 * Indentación (marginLeft) del contenedor de rows de SOURCES. Se pasa como `indent`
 * a {@link rowWidth} para que el ancho del row descuente ese marginLeft — si no, el
 * `ListRow` se construye más ancho que su contenedor → Yoga lo envuelve → línea en
 * blanco entre filas (visible solo con el panel cerrado). El `marginLeft` del JSX y
 * este `indent` comparten esta constante para no desincronizarse. El tab MCP no
 * indenta su lista (indent 0), por eso nunca sufrió este wrap.
 */
const SOURCES_ROWS_INDENT = 2;

interface InitializedProps {
  ctx: CliContext;
  data: ProjectTabData;
  isActive: boolean;
  onRunAction?: ((id: string, payload?: Record<string, unknown>) => void) | undefined;
  onReload?: (() => void | Promise<void>) | undefined;
}

function Initialized({ ctx, data, isActive, onRunAction, onReload }: InitializedProps) {
  const dirty = data.git?.dirty ?? 0;
  const totalSources = data.sources.length;
  const dirtySources = data.sources.filter((s) => s.dirty).length;
  const workingEntries = Object.entries(data.workingBranches);
  const qaEntries = Object.entries(data.qaBranches);

  const home = ctx.env.homeDir();
  const shortName = deriveShortName(data.workspaceName, basename(data.workspacePath));
  const description = deriveDescription(data.workspaceName);
  const wsPath = tildePath(data.workspacePath, home);

  const { stdout } = useStdout();
  const { lock, unlock } = useInputLock();

  // Targets navegables: cada fuente + la fila centinela "all sources" al final.
  const targets = useMemo(() => [...data.sources.map((s) => s.alias), ALL_SOURCES], [data.sources]);
  const hasSources = totalSources > 0;
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [processCursor, setProcessCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  const processes = data.processes;
  const runningCount = useMemo(
    () => processes.filter((p) => p.state === "running").length,
    [processes],
  );

  // Deps for the source-launch service. `baseEnv` = the real process env so the
  // child inherits PATH etc.; params/profile are layered on at resolve time.
  const launchDeps = useMemo<LaunchDeps>(
    () => ({
      fs: ctx.fs,
      proc: ctx.process,
      paths: ctx.paths,
      baseEnv: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    }),
    [ctx],
  );

  // Launch a source: collision-check first, then spawn detached + register.
  const doLaunch = useCallback(
    async (req: LaunchRequest) => {
      const existing = findCollision(processes, req.alias, req.profile);
      if (existing) return setMode({ kind: "collision", req, existing });
      setMode({ kind: "busy", label: `Lanzando ${req.alias}…` });
      const res = await launchSource(launchDeps, req);
      setMode(
        res.ok
          ? {
              kind: "notice",
              tone: "ok",
              lines: [`Lanzado ${req.alias} (PID ${res.record.pid})`, res.record.logPath],
            }
          : { kind: "notice", tone: "err", lines: [res.message] },
      );
      await onReload?.();
    },
    [processes, launchDeps, onReload],
  );

  // Entry from the "Lanzar en local" detail action: open the form if the
  // descriptor has profiles/params, otherwise launch directly.
  const beginLaunch = useCallback(
    async (alias: string) => {
      const descriptor = await readDescriptor(ctx.fs, ctx.paths.workspaceDir(), alias);
      if (!descriptor || !descriptor.command) {
        return setMode({
          kind: "notice",
          tone: "err",
          lines: [
            `Sin descriptor de arranque para ${alias}.`,
            "Generá scripts con /w:workspace-init.",
          ],
        });
      }
      if (descriptor.profiles.length === 0 && descriptor.params.length === 0) {
        return void doLaunch({ alias, profile: null, values: {} });
      }
      setMode({ kind: "launch-form", alias, descriptor });
    },
    [ctx, doLaunch],
  );

  const doStop = useCallback(
    async (record: ProcessRecord) => {
      setMode({ kind: "busy", label: `Deteniendo ${record.sourceAlias}…` });
      await stopProcess(launchDeps, record);
      setMode({ kind: "list" });
      await onReload?.();
    },
    [launchDeps, onReload],
  );

  const doRelaunch = useCallback(
    async (record: ProcessRecord) => {
      setMode({ kind: "busy", label: `Re-lanzando ${record.sourceAlias}…` });
      const res = await relaunchProcess(launchDeps, record);
      setMode(
        res.ok
          ? {
              kind: "notice",
              tone: "ok",
              lines: [`Re-lanzado ${record.sourceAlias} (PID ${res.record.pid})`],
            }
          : { kind: "notice", tone: "err", lines: [res.message] },
      );
      await onReload?.();
    },
    [launchDeps, onReload],
  );

  const doViewLog = useCallback(
    async (record: ProcessRecord) => {
      const lines = await tailLog(ctx.fs, record.logPath, 20);
      setMode({
        kind: "log",
        record,
        lines: lines.length > 0 ? lines : ["(log vacío o no encontrado)", record.logPath],
      });
    },
    [ctx.fs],
  );

  // El detail panel (y el flujo en curso) bloquean las teclas globales; la lista
  // base las deja pasar.
  useEffect(() => {
    if (mode.kind === "list") unlock();
    else lock();
  }, [mode, lock, unlock]);
  useEffect(() => () => unlock(), [unlock]);

  const detailOpen = mode.kind === "detail";
  const currentTarget = targets[cursor] ?? ALL_SOURCES;
  const isAllTarget = currentTarget === ALL_SOURCES;
  const currentSource = isAllTarget
    ? null
    : (data.sources.find((s) => s.alias === currentTarget) ?? null);

  // Detail-panel actions for the current target: a per-source "Lanzar en local"
  // (only for real sources), the git-flow actions, and a destructive "Quitar del
  // workspace" last (only for real sources, never for "all sources").
  const detailItems = useMemo<
    ({ kind: "launch" } | { kind: "flow"; action: GitFlowAction } | { kind: "remove" })[]
  >(
    () => [
      ...(currentSource ? [{ kind: "launch" as const }] : []),
      ...FLOW_ACTIONS.map((a) => ({ kind: "flow" as const, action: a.id })),
      ...(currentSource ? [{ kind: "remove" as const }] : []),
    ],
    [currentSource],
  );

  const runFlow = useCallback(
    async (action: GitFlowAction) => {
      const target = targets[cursor] ?? ALL_SOURCES;
      const isAll = target === ALL_SOURCES;
      const actionName = FLOW_ACTIONS.find((a) => a.id === action)?.name ?? action;
      setMode({ kind: "running", label: `${actionName} · ${isAll ? "all sources" : target}` });
      const input: GitFlowInput = isAll ? { action, all: true } : { action, source: target };
      try {
        const result = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input);
        setMode({ kind: "result", action, result });
      } catch (err) {
        setMode({
          kind: "result",
          action,
          result: {
            action,
            dry_run: false,
            status: "error",
            results: [],
            error: (err as Error).message,
          },
        });
      }
    },
    [cursor, ctx, targets],
  );

  // Quitar una fuente del workspace: orquesta detach + poda bloque + stop procesos
  // + borra docs/tools/<alias> (vía el servicio); luego recarga la vista.
  const doRemove = useCallback(
    async (alias: string) => {
      setMode({ kind: "busy", label: `Quitando ${alias}…` });
      const res = await removeSource(
        { fs: ctx.fs, env: ctx.env, proc: ctx.process, paths: ctx.paths },
        alias,
      );
      setCursor(0);
      setMode(
        "error" in res
          ? { kind: "notice", tone: "err", lines: [res.error] }
          : {
              kind: "notice",
              tone: "ok",
              lines: [
                `Quitada ${alias} del workspace.`,
                res.processesStopped > 0 ? `${res.processesStopped} proceso(s) detenido(s).` : "",
              ].filter((l) => l.length > 0),
            },
      );
      await onReload?.();
    },
    [ctx, onReload],
  );

  // Atajos de la lista de sources (↑↓ navega · ⏎ abre panel · p procesos · s/g/c acciones).
  const handleListKey = useCallback(
    (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
      if (input === "s") return void onRunAction?.("session:start");
      if (input === "g") return void onRunAction?.("git:status");
      if (input === "p" && processes.length > 0) {
        setProcessCursor(0);
        return setMode({ kind: "process" });
      }
      if (input === "c" && data.branches.length > 1) {
        const candidate = data.branches.find((b) => !b.current);
        if (candidate) onRunAction?.("git:checkout", { name: candidate.name });
        return;
      }
      if (!hasSources) return;
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(targets.length - 1, c + 1));
      if (key.return) {
        setActionCursor(0);
        setMode({ kind: "detail" });
      }
    },
    [data.branches, hasSources, onRunAction, targets.length, processes.length],
  );

  // Acciones del panel lateral (↑↓ navega · ⏎ ejecuta · esc cierra).
  const handleDetailKey = useCallback(
    (key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
      if (key.upArrow) return setActionCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setActionCursor((c) => Math.min(detailItems.length - 1, c + 1));
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const item = detailItems[actionCursor];
        if (!item) return;
        if (item.kind === "launch") {
          if (currentSource?.launchable) return void beginLaunch(currentSource.alias);
          return setMode({
            kind: "notice",
            tone: "err",
            lines: [
              `${currentSource?.alias ?? "source"}: sin descriptor de arranque.`,
              "Generá scripts con /w:workspace-init.",
            ],
          });
        }
        if (item.kind === "remove") {
          if (currentSource) return setMode({ kind: "confirm-remove", alias: currentSource.alias });
          return;
        }
        void runFlow(item.action);
      }
    },
    [actionCursor, detailItems, currentSource, runFlow, beginLaunch],
  );

  // Modo "process": navega la sección de procesos en segundo plano (x stop · r relaunch · o log).
  const handleProcessKey = useCallback(
    (input: string, key: { upArrow?: boolean; downArrow?: boolean; escape?: boolean }) => {
      if (key.escape) return setMode({ kind: "list" });
      if (key.upArrow) return setProcessCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setProcessCursor((c) => Math.min(processes.length - 1, c + 1));
      const record = processes[processCursor];
      if (!record) return;
      if (input === "x") return void doStop(record);
      if (input === "r") return void doRelaunch(record);
      if (input === "o") return void doViewLog(record);
    },
    [processes, processCursor, doStop, doRelaunch, doViewLog],
  );

  // Colisión: detiene el proceso existente y lanza el pedido (con sus valores).
  const confirmRelaunch = useCallback(
    async (req: LaunchRequest, existing: ProcessRecord) => {
      setMode({ kind: "busy", label: `Re-lanzando ${req.alias}…` });
      await stopProcess(launchDeps, existing);
      const res = await launchSource(launchDeps, req);
      setMode(
        res.ok
          ? {
              kind: "notice",
              tone: "ok",
              lines: [`Re-lanzado ${req.alias} (PID ${res.record.pid})`],
            }
          : { kind: "notice", tone: "err", lines: [res.message] },
      );
      await onReload?.();
    },
    [launchDeps, onReload],
  );

  // input — delega a cada handler según el modo activo.
  useInput(
    (input, key) => {
      if (!isActive) return;
      if (mode.kind === "list") return handleListKey(input, key);
      if (mode.kind === "detail") return handleDetailKey(key);
      if (mode.kind === "process") return handleProcessKey(input, key);
      if (mode.kind === "collision") {
        if (key.escape) setMode({ kind: "list" });
        else if (input === "r") void confirmRelaunch(mode.req, mode.existing);
        return;
      }
      if (mode.kind === "confirm-remove") {
        if (key.escape || input === "n" || input === "N") setMode({ kind: "list" });
        else if (input === "y" || input === "Y") void doRemove(mode.alias);
        return;
      }
      if (mode.kind === "notice" || mode.kind === "log") {
        if (key.escape || key.return) setMode({ kind: "list" });
        return;
      }
      if (mode.kind === "result") {
        // ⏎/r re-ejecuta (= resume on conflict) · esc vuelve a la lista.
        if (key.escape) {
          setMode({ kind: "list" });
          void onReload?.();
        } else if (key.return || input === "r") void runFlow(mode.action);
      }
    },
    { isActive },
  );

  if (mode.kind === "running") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Git flow" hint={mode.label} />
        <Box marginLeft={2} marginTop={1}>
          <Text color={colors.warn}>{icons.spinner} ejecutando…</Text>
        </Box>
      </Box>
    );
  }

  if (mode.kind === "result") {
    return <FlowResultView action={mode.action} result={mode.result} />;
  }

  if (mode.kind === "launch-form") {
    return (
      <SourceLaunchForm
        descriptor={mode.descriptor}
        isActive={isActive}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={(v: LaunchFormValue) =>
          void doLaunch({ alias: mode.alias, profile: v.profile, values: v.values })
        }
      />
    );
  }

  if (mode.kind === "busy") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Procesos" hint={mode.label} />
        <Box marginLeft={2} marginTop={1}>
          <Text color={colors.warn}>
            {icons.spinner} {mode.label}
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode.kind === "collision") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Ya en ejecución" marginTop={0} />
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text color={colors.warn}>
            Ya corre {mode.existing.sourceAlias}
            {mode.existing.profile ? ` · ${mode.existing.profile}` : ""} (PID {mode.existing.pid}).
          </Text>
          <Box marginTop={1}>
            <Text color={colors.faint}>
              r re-lanzar (detiene el actual + lanza de nuevo) · esc cancelar
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode.kind === "confirm-remove") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Quitar del workspace" marginTop={0} />
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text color={colors.warn}>¿Quitar {mode.alias} del workspace?</Text>
          <Box marginLeft={2} marginTop={1} flexDirection="column">
            <Text color={colors.dim}>
              Sale del bloque WORKSPACE (Fuentes + ramas), de la visibilidad multi-root,
            </Text>
            <Text color={colors.dim}>detiene sus procesos y borra docs/tools/{mode.alias}.</Text>
            <Text color={colors.faint}>El repo en disco NO se borra.</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={colors.faint}>y quitar · n/esc cancelar</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode.kind === "notice") {
    return (
      <Box flexDirection="column">
        <SectionHead label={mode.tone === "ok" ? "Listo" : "Atención"} marginTop={0} />
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          {mode.lines.map((l, i) => (
            <Text key={`${i}-${l}`} color={mode.tone === "ok" ? colors.ok : colors.warn}>
              {l}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={colors.faint}>⏎/esc volver</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode.kind === "log") {
    return (
      <Box flexDirection="column">
        <SectionHead
          label={`Log · ${mode.record.sourceAlias}${mode.record.profile ? ` · ${mode.record.profile}` : ""}`}
          hint={mode.record.logPath}
          marginTop={0}
        />
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          {mode.lines.map((l, i) => (
            <Text key={`${i}-${l.slice(0, 8)}`} color={colors.dim}>
              {l}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={colors.faint}>⏎/esc volver</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const detailActions: DetailAction[] = detailItems.map((it) => {
    if (it.kind === "launch") {
      return currentSource?.launchable
        ? { name: LAUNCH_ACTION.name, description: "spawn detached" }
        : { name: LAUNCH_ACTION.name, description: "sin descriptor — /w:workspace-init" };
    }
    if (it.kind === "remove") {
      return { name: "Quitar del workspace", description: "detach + poda bloque + scripts" };
    }
    const fa = FLOW_ACTIONS.find((a) => a.id === it.action);
    return { name: fa?.name ?? it.action, description: fa?.description ?? "" };
  });

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
        <StatTile
          label="procesos"
          value={`${runningCount}`}
          sub={
            processes.length > runningCount
              ? `${processes.length - runningCount} inactivos`
              : "running"
          }
          tone={runningCount > 0 ? "accent" : "dim"}
        />
      </Box>

      {/* Layout con detail panel: lista (sources + ramas) a la izquierda, panel
          de acciones a la derecha cuando hay una fuente seleccionada. */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          {hasSources ? (
            <>
              <SectionHead
                label="Sources"
                count={totalSources}
                marginTop={0}
                rightAction={detailOpen ? "esc to close detail" : "↑↓ select · ⏎ actions"}
              />
              <Box marginLeft={SOURCES_ROWS_INDENT} flexDirection="column">
                {data.sources.map((s, i) => (
                  <SourceRow
                    key={s.alias}
                    source={s}
                    active={i === cursor}
                    widthHint={rowWidth(stdout?.columns, detailOpen, SOURCES_ROWS_INDENT)}
                  />
                ))}
                <ListRow
                  icon={icons.diamond}
                  title="all sources"
                  subtitle={`aplica a las ${totalSources} fuentes`}
                  chevron
                  active={cursor === targets.length - 1}
                  widthHint={rowWidth(stdout?.columns, detailOpen, SOURCES_ROWS_INDENT)}
                />
              </Box>
            </>
          ) : null}

          <BranchList
            label="Ramas de trabajo actuales"
            entries={workingEntries}
            emptyHint="(no working branches declared)"
          />
          {qaEntries.length > 0 ? (
            <BranchList label="Ramas QA actuales" entries={qaEntries} />
          ) : null}

          <ProcessList
            processes={processes}
            cursor={processCursor}
            focused={mode.kind === "process"}
            widthHint={rowWidth(stdout?.columns, detailOpen, SOURCES_ROWS_INDENT)}
          />
        </Box>

        {/* Detail panel — sólo cuando se seleccionó una fuente con ⏎. */}
        {detailOpen ? (
          <SourceActionsPanel
            isAll={isAllTarget}
            name={isAllTarget ? "all sources" : currentTarget}
            source={currentSource}
            totalSources={totalSources}
            actions={detailActions}
            focusedAction={actionCursor}
          />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <QuickActions
          actions={[
            { key: "⏎", label: "source actions" },
            ...(processes.length > 0 ? [{ key: "p", label: "manage processes" }] : []),
            { key: "s", label: "start session" },
          ]}
        />
      </Box>
    </Box>
  );
}

function SourceRow({
  source,
  active,
  widthHint,
}: {
  source: ProjectSource;
  active: boolean;
  widthHint: number;
}) {
  const status = source.dirty ? `${source.changedFiles} dirty` : "in sync";
  const branch = source.branch ?? source.mainBranch;
  return (
    <ListRow
      icon={icons.diamond}
      iconActive={true}
      title={source.alias}
      subtitle={`main ${source.mainBranch}`}
      meta={[{ label: status, tone: source.dirty ? "warn" : "ok" }]}
      state={{ label: `${icons.branch} ${branch}`, tone: "dim" }}
      chevron
      active={active}
      widthHint={widthHint}
    />
  );
}

/** Sección "Ramas …" — una fila `◆ alias  ↳ branch` por entrada del bloque WORKSPACE. */
function BranchList({
  label,
  entries,
  emptyHint,
}: {
  label: string;
  entries: [string, string][];
  emptyHint?: string;
}) {
  return (
    <>
      <SectionHead label={label} count={entries.length} marginTop={1} />
      <Box marginLeft={2} flexDirection="column">
        {entries.length > 0 ? (
          entries.map(([alias, branch]) => (
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
        ) : emptyHint ? (
          <Text color={colors.faint}>{emptyHint}</Text>
        ) : null}
      </Box>
    </>
  );
}

/** Panel lateral de acciones git-flow para la fuente (o "all sources") seleccionada. */
function SourceActionsPanel({
  isAll,
  name,
  source,
  totalSources,
  actions,
  focusedAction,
}: {
  isAll: boolean;
  name: string;
  source: ProjectSource | null;
  totalSources: number;
  actions: DetailAction[];
  focusedAction: number;
}) {
  const meta = isAll
    ? `git flow · ${totalSources} fuentes`
    : `main ${source?.mainBranch ?? "?"}\n${icons.branch} ${source?.branch ?? source?.mainBranch ?? "?"}`;
  const statePill: DetailStatePill = isAll
    ? { label: `${totalSources} sources`, tone: "accent" }
    : source?.dirty
      ? { label: `${source.changedFiles} dirty`, tone: "warn" }
      : { label: "in sync", tone: "ok" };
  return (
    <DetailPanel
      bordered
      header={{ name, meta }}
      statePill={statePill}
      actions={actions}
      focusedAction={focusedAction}
    />
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
