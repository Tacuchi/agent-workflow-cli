import { basename } from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type GitFlowAction,
  type GitFlowInput,
  type GitFlowResult,
  runGitFlow,
} from "../../../application/git-flow-service.js";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
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
  type LaunchResult,
  ensureDescriptor,
  findCollision,
  launchSource,
  relaunchProcess,
  stopFailed,
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
import { ListRow, type MetaChip } from "../components/list-row.js";
import { notificationStackRows } from "../components/notification-stack.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { type LaunchFormValue, SourceLaunchForm } from "../components/source-launch-form.js";
import { StatTile } from "../components/stat-tile.js";
import { WorkspaceInitForm } from "../components/workspace-init-form.js";
import { useLockWhile } from "../input-lock.js";
import { useNotificationItems } from "../notification-center.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { useListWindow, windowRangeHint } from "../use-list-window.js";

export interface ProjectTabProps {
  ctx: CliContext;
  isActive: boolean;
  onRunAction?: (id: string) => void;
}

/**
 * Operational-log line for a launch/relaunch: ok · fallback background (warn,
 * carrying WHY the window never opened — the exported log is the
 * remote-diagnosis channel) · error.
 */
function logLaunchOutcome(logger: CliContext["logger"], action: string, res: LaunchResult): void {
  if (!res.ok) {
    void logger?.log("error", formatTuiEvent(action, "error", res.message));
    return;
  }
  if (res.record.launchMode === "terminal") {
    void logger?.log("info", formatTuiEvent(action, "ok"));
    return;
  }
  void logger?.log(
    res.terminalError ? "warn" : "info",
    formatTuiEvent(action, "fallback background", res.terminalError),
  );
}

/** Notice lines for a successful launch/relaunch, aware of the terminal-vs-background mode. */
function launchNoticeLines(head: string, res: Extract<LaunchResult, { ok: true }>): string[] {
  if (res.record.launchMode === "terminal") {
    return [`${head} en una terminal (PID ${res.record.pid}).`];
  }
  return [
    `${head} en segundo plano (PID ${res.record.pid}) — sin terminal disponible.`,
    ...(res.terminalError ? [`Motivo: ${res.terminalError}`] : []),
    res.record.logPath,
  ];
}

export function ProjectTab({ ctx, isActive, onRunAction }: ProjectTabProps) {
  const [data, setData] = useState<ProjectTabData | null>(null);
  const [loading, setLoading] = useState(true);
  const [initForm, setInitForm] = useState(false);

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
      // Partial-fetch failures (a git subcommand threw) are collected in
      // `warnings` instead of tanking the render — surface them to the daily log
      // so a degraded workspace view leaves a durable, greppable trace.
      for (const w of out.warnings) {
        void ctx.logger?.warn(formatTuiEvent("workspace data", "warning", w));
      }
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // While the init wizard is open, block the global keys so its inputs don't
  // navigate across tabs. The Initialized view manages its own lock for the
  // detail panel / in-flight flow.
  useLockWhile(initForm);

  // Keys for the "not initialized" landing (⏎ opens the wizard · g git status).
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

// ===== Presentation helpers =====

/**
 * Derives a short name from `workspaceName`, which may carry a long
 * description paragraph. Takes the first non-empty line, cuts at the first
 * structural separator (`·` / `:` / `.`) and truncates to ~40 chars.
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

/** Collapses the multiline `workspaceName` into one line, truncated to 80 chars. */
function deriveDescription(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** `~/Git/foo` instead of the absolute path. */
function tildePath(path: string, home: string): string {
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

// ===== Landing — uninitialized workspace =====

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

// ===== Initialized — WORKSPACE view =====

/** Target sentinel = "all sources". Impossible alias (cannot collide). */
const ALL_SOURCES = " all-sources";

/**
 * The per-source git-flow actions, in the order the user requested.
 * They map 1:1 to {@link GitFlowAction}:
 *  - `sync`    → "Alinear con PROD" (merge prod→work: brings PROD into the working branch)
 *  - `to-dev`  → "Enviar a Desarrollo"
 *  - `to-qa`   → "Enviar a QA"
 *  - `to-prod` → "Enviar a PROD"
 */
const FLOW_ACTIONS: { id: GitFlowAction; name: string; description: string }[] = [
  { id: "sync", name: "Alinear con PROD", description: "merge prod→work" },
  { id: "to-dev", name: "Enviar a Desarrollo", description: "sync + prod/work→dev + push" },
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
  | { kind: "launch-form"; alias: string; descriptor: LaunchDescriptor }
  | { kind: "busy"; label: string }
  | { kind: "collision"; req: LaunchRequest; existing: ProcessRecord }
  | { kind: "notice"; tone: "ok" | "err"; lines: string[] }
  | { kind: "log"; record: ProcessRecord; lines: string[] };

/** First per-source detail action: launch the app locally. */
const LAUNCH_ACTION = { id: "launch", name: "Lanzar en local" } as const;

/** One selectable row of the source detail panel, in render order. */
type DetailItem =
  | { kind: "launch" }
  | { kind: "flow"; action: GitFlowAction }
  | { kind: "proc"; op: ProcessOp; record: ProcessRecord }
  | { kind: "remove" };

type ProcessOp = "stop" | "relaunch" | "log";

/**
 * The three operations offered per `running` process of the selected source —
 * the same ones the removed process region carried on x/r/o. No description:
 * the row spells the profile and the PID, and the panel's remaining width
 * would truncate one to a single cell.
 */
const PROCESS_OPS: Record<ProcessOp, string> = {
  stop: "Detener",
  relaunch: "Re-lanzar",
  log: "Ver log",
};

/**
 * Indentation (marginLeft) of the SOURCES rows container. Passed as `indent`
 * to {@link rowWidth} so the row width subtracts that marginLeft — otherwise
 * the `ListRow` builds wider than its container → Yoga wraps it → blank line
 * between rows (visible only with the panel closed). The JSX `marginLeft` and
 * this `indent` share this constant so they cannot desync. The MCP tab does
 * not indent its list (indent 0), which is why it never hit this wrap.
 */
const SOURCES_ROWS_INDENT = 2;

// Terminal rows eaten around the SOURCES list, handed to `useListWindow` so the
// active row never clips under app.tsx's `overflowY="hidden"` (same accounting
// style as rowWidth for width / HOSTS_LIST_RESERVED_ROWS in host-admin-section):
// - app shell: ScreenFrame border+paddingY (4) + HomeHeader (2 lines + 1 margin)
//   + TabBar (1 line + 2 border) + tab content box border+paddingY (4)
//   + HomeFooter (1 line + 1 margin) = 16
// - this tab, fixed: PageHead (1 + 1 margin) + StatTile row (3 + 1 margin)
//   + Sources SectionHead (1) + QuickActions (2 + 1 marginTop) = 10
// - 1 slack: better one row short than a clipped active row.
// The data-driven rows (description, warnings) and the NotificationStack height
// (0 unless a banner is visible) are added per render — see `reservedRows` in
// Initialized. Nothing renders below the list anymore (SPEC 019).
const SOURCES_LIST_RESERVED_ROWS = 27;

interface InitializedProps {
  ctx: CliContext;
  data: ProjectTabData;
  isActive: boolean;
  onRunAction?: ((id: string) => void) | undefined;
  onReload?: (() => void | Promise<void>) | undefined;
}

function Initialized({ ctx, data, isActive, onRunAction, onReload }: InitializedProps) {
  const dirty = data.git?.dirty ?? 0;
  const totalSources = data.sources.length;
  const dirtySources = data.sources.filter((s) => s.dirty).length;
  const workingEntries = Object.entries(data.workingBranches);

  const home = ctx.env.homeDir();
  const shortName = deriveShortName(data.workspaceName, basename(data.workspacePath));
  const description = deriveDescription(data.workspaceName);
  const wsPath = tildePath(data.workspacePath, home);

  const { stdout } = useStdout();

  // Navigable targets: each source + the sentinel "all sources" row at the end.
  const targets = useMemo(() => [...data.sources.map((s) => s.alias), ALL_SOURCES], [data.sources]);
  const hasSources = totalSources > 0;
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  const processes = data.processes;
  // Active processes per source alias: the source row's chip and the global
  // tile both read from here, so "active" has one definition. `stopped` and
  // `exited` records are history and never counted (SPEC 019).
  const runningBySource = useMemo(() => {
    const byAlias = new Map<string, number>();
    for (const p of processes) {
      if (p.state === "running") byAlias.set(p.sourceAlias, (byAlias.get(p.sourceAlias) ?? 0) + 1);
    }
    return byAlias;
  }, [processes]);
  const runningCount = useMemo(
    () => [...runningBySource.values()].reduce((total, n) => total + n, 0),
    [runningBySource],
  );

  // Window over the SOURCES list: the shell clips overflow, so only the slice
  // around the cursor renders — the active row can never walk off-screen.
  // `reservedRows` adds the data-driven chrome to the static count: the
  // description and warnings blocks above the list, plus the NotificationStack
  // height while a banner is visible (0 otherwise). rows=0 (non-TTY) → the
  // hook returns the whole list and nothing changes.
  const notifItems = useNotificationItems();
  const warningsRows = data.warnings.length > 0 ? Math.min(data.warnings.length, 3) + 2 : 0;
  const reservedRows =
    SOURCES_LIST_RESERVED_ROWS +
    notificationStackRows(notifItems) +
    (description ? 2 : 0) +
    warningsRows;
  const win = useListWindow(targets.length, cursor, reservedRows);
  const winEnd = win.start + win.visible;
  // Overflow indicator for the SectionHead hint slot (no extra terminal row).
  const rangeHint = windowRangeHint(win, targets.length);

  // Deps for the source-launch service. `baseEnv` = the real process env so the
  // child inherits PATH etc.; params/profile are layered on at resolve time.
  // `resolveSourcePath` enables on-demand descriptor generation (first launch).
  const launchDeps = useMemo<LaunchDeps>(
    () => ({
      fs: ctx.fs,
      proc: ctx.process,
      paths: ctx.paths,
      baseEnv: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      resolveSourcePath: async (alias: string) =>
        data.sources.find((s) => s.alias === alias)?.path ?? null,
    }),
    [ctx, data.sources],
  );

  // Launch a source: collision-check first, then open a terminal (or background fallback) + register.
  const doLaunch = useCallback(
    async (req: LaunchRequest) => {
      const existing = findCollision(processes, req.alias, req.profile);
      if (existing) return setMode({ kind: "collision", req, existing });
      setMode({ kind: "busy", label: `Lanzando ${req.alias}…` });
      const res = await launchSource(launchDeps, req);
      const target = `${req.alias}${req.profile ? ` · ${req.profile}` : ""}`;
      logLaunchOutcome(ctx.logger, `launch ${target}`, res);
      setMode(
        res.ok
          ? {
              kind: "notice",
              tone: "ok",
              lines:
                res.record.launchMode === "terminal"
                  ? [
                      `Lanzado ${req.alias} en una terminal (PID ${res.record.pid}).`,
                      "Monitoreá en esa ventana; cerrala para detener.",
                    ]
                  : launchNoticeLines(`Lanzado ${req.alias}`, res),
            }
          : { kind: "notice", tone: "err", lines: [res.message] },
      );
      await onReload?.();
    },
    [processes, launchDeps, onReload, ctx],
  );

  // Entry from the "Lanzar en local" detail action: ensure the descriptor
  // (generated on demand at the first launch), then open the form if it has
  // profiles/params, otherwise launch directly.
  const beginLaunch = useCallback(
    async (alias: string) => {
      const read = await ensureDescriptor(
        ctx.fs,
        ctx.paths.cwdLaunchDir(),
        alias,
        launchDeps.resolveSourcePath,
      );
      if (read.status === "corrupt") {
        return setMode({
          kind: "notice",
          tone: "err",
          lines: [
            `launch.json corrupto para ${alias}.`,
            "Corregilo o borralo: se regenera en el próximo lanzamiento.",
          ],
        });
      }
      if (read.status !== "ok" || !read.descriptor.command) {
        return setMode({
          kind: "notice",
          tone: "err",
          lines: [`${alias}: sin comando de arranque detectable en la fuente.`],
        });
      }
      const descriptor = read.descriptor;
      if (descriptor.profiles.length === 0 && descriptor.params.length === 0) {
        return void doLaunch({ alias, profile: null, values: {} });
      }
      setMode({ kind: "launch-form", alias, descriptor });
    },
    [ctx, doLaunch, launchDeps],
  );

  const doStop = useCallback(
    async (record: ProcessRecord) => {
      setMode({ kind: "busy", label: `Deteniendo ${record.sourceAlias}…` });
      const res = await stopProcess(launchDeps, record);
      const event = `stop ${record.sourceAlias} (PID ${record.pid})`;
      // A stop that did not kill anything is a warning, not an "ok": the daily
      // log is the only trace once the notice is dismissed.
      void ctx.logger?.log(
        res.stopped ? "info" : "warn",
        formatTuiEvent(event, res.stopped ? "ok" : "sigue vivo"),
      );
      setMode(
        res.stopped
          ? {
              kind: "notice",
              tone: "ok",
              lines: [`Detenido ${record.sourceAlias} (PID ${record.pid}).`],
            }
          : {
              kind: "notice",
              tone: "err",
              lines: [
                `${record.sourceAlias} (PID ${record.pid}) sigue vivo tras la señal.`,
                "Sigue contando como activo; detenelo desde el sistema y refrescá.",
              ],
            },
      );
      await onReload?.();
    },
    [launchDeps, onReload, ctx],
  );

  // Shared tail of doRelaunch/confirmRelaunch: daily-log entry + notice + reload.
  const finishRelaunch = useCallback(
    async (alias: string, res: LaunchResult) => {
      // Same mode-aware surfacing as doLaunch: the retry path is exactly where a
      // silent background fallback would otherwise go unnoticed.
      logLaunchOutcome(ctx.logger, `relaunch ${alias}`, res);
      setMode(
        res.ok
          ? { kind: "notice", tone: "ok", lines: launchNoticeLines(`Re-lanzado ${alias}`, res) }
          : { kind: "notice", tone: "err", lines: [res.message] },
      );
      await onReload?.();
    },
    [ctx, onReload],
  );

  const doRelaunch = useCallback(
    async (record: ProcessRecord) => {
      setMode({ kind: "busy", label: `Re-lanzando ${record.sourceAlias}…` });
      const res = await relaunchProcess(launchDeps, record);
      await finishRelaunch(record.sourceAlias, res);
    },
    [launchDeps, finishRelaunch],
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

  // Global keys are locked for every mode except the plain list and the detail
  // panel (its ↑↓ ⏎ esc don't collide with the globals). MCP/Skills policy.
  useLockWhile(mode.kind !== "list" && mode.kind !== "detail");

  const detailOpen = mode.kind === "detail";
  const currentTarget = targets[cursor] ?? ALL_SOURCES;
  const isAllTarget = currentTarget === ALL_SOURCES;
  const currentSource = isAllTarget
    ? null
    : (data.sources.find((s) => s.alias === currentTarget) ?? null);

  // The selected source's own active processes — what its detail panel can
  // operate now that no process list exists.
  const sourceProcesses = useMemo(
    () =>
      currentSource
        ? processes.filter((p) => p.state === "running" && p.sourceAlias === currentSource.alias)
        : [],
    [processes, currentSource],
  );

  // Detail-panel actions for the current target: a per-source "Lanzar en local"
  // (only for real sources), the git-flow actions, one triplet per active
  // process, and a destructive "Quitar del workspace" last (only for real
  // sources, never for "all sources").
  const detailItems = useMemo<DetailItem[]>(
    () => [
      ...(currentSource ? [{ kind: "launch" as const }] : []),
      ...FLOW_ACTIONS.map((a) => ({ kind: "flow" as const, action: a.id })),
      ...sourceProcesses.flatMap((record): DetailItem[] => [
        { kind: "proc", op: "stop", record },
        { kind: "proc", op: "relaunch", record },
        { kind: "proc", op: "log", record },
      ]),
      ...(currentSource ? [{ kind: "remove" as const }] : []),
    ],
    [currentSource, sourceProcesses],
  );

  const runFlow = useCallback(
    async (action: GitFlowAction) => {
      const target = targets[cursor] ?? ALL_SOURCES;
      const isAll = target === ALL_SOURCES;
      const actionName = FLOW_ACTIONS.find((a) => a.id === action)?.name ?? action;
      setMode({ kind: "running", label: `${actionName} · ${isAll ? "all sources" : target}` });
      const input: GitFlowInput = isAll ? { action, all: true } : { action, source: target };
      const event = `git-flow ${action} · ${isAll ? "all-sources" : target}`;
      try {
        const result = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input);
        const level =
          result.status === "error" ? "error" : result.status === "conflict" ? "warn" : "info";
        void ctx.logger?.log(level, formatTuiEvent(event, result.status, result.error));
        setMode({ kind: "result", action, result });
      } catch (err) {
        const message = (err as Error).message;
        void ctx.logger?.error(formatTuiEvent(event, "error", message));
        setMode({
          kind: "result",
          action,
          result: {
            action,
            dry_run: false,
            status: "error",
            results: [],
            error: message,
          },
        });
      }
    },
    [cursor, ctx, targets],
  );

  // Remove a source from the workspace: orchestrates detach + block pruning +
  // stopping processes + deleting .workflow/launch/<alias> (via the service);
  // then reloads the view.
  const doRemove = useCallback(
    async (alias: string) => {
      setMode({ kind: "busy", label: `Quitando ${alias}…` });
      const res = await removeSource(
        { fs: ctx.fs, env: ctx.env, proc: ctx.process, paths: ctx.paths },
        alias,
      );
      setCursor(0);
      void ctx.logger?.log(
        "error" in res ? "error" : "info",
        formatTuiEvent(
          `remove ${alias}`,
          "error" in res ? "error" : "ok",
          "error" in res ? res.error : undefined,
        ),
      );
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

  // Sources list shortcuts (↑↓ navigate · ⏎ open panel · g git status).
  const handleListKey = useCallback(
    (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
      if (input === "g") return void onRunAction?.("git:status");
      if (!hasSources) return;
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(targets.length - 1, c + 1));
      if (key.return) {
        setActionCursor(0);
        setMode({ kind: "detail" });
      }
    },
    [hasSources, onRunAction, targets.length],
  );

  // Side panel actions (↑↓ navigate · ⏎ run · esc close).
  const handleDetailKey = useCallback(
    (key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
      if (key.upArrow) return setActionCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setActionCursor((c) => Math.min(detailItems.length - 1, c + 1));
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const item = detailItems[actionCursor];
        if (!item) return;
        if (item.kind === "launch") {
          // Always route through beginLaunch: it diagnoses precisely (regenerates
          // on demand, distinguishes corrupt vs not-launchable) — `launchable`
          // only drives the inline description.
          if (currentSource) return void beginLaunch(currentSource.alias);
          return;
        }
        if (item.kind === "proc") {
          if (item.op === "stop") return void doStop(item.record);
          if (item.op === "relaunch") return void doRelaunch(item.record);
          return void doViewLog(item.record);
        }
        if (item.kind === "remove") {
          if (currentSource) return setMode({ kind: "confirm-remove", alias: currentSource.alias });
          return;
        }
        void runFlow(item.action);
      }
    },
    [actionCursor, detailItems, currentSource, runFlow, beginLaunch, doStop, doRelaunch, doViewLog],
  );

  // Collision: stops the existing process and launches the requested one (with its values).
  const confirmRelaunch = useCallback(
    async (req: LaunchRequest, existing: ProcessRecord) => {
      setMode({ kind: "busy", label: `Re-lanzando ${req.alias}…` });
      const stop = await stopProcess(launchDeps, existing);
      // Same rule as relaunchProcess: never launch over a survivor.
      const res = stop.stopped ? await launchSource(launchDeps, req) : stopFailed(existing.pid);
      await finishRelaunch(req.alias, res);
    },
    [launchDeps, finishRelaunch],
  );

  // input — delegates to the handler of the active mode.
  useInput(
    (input, key) => {
      if (!isActive) return;
      if (mode.kind === "list") return handleListKey(input, key);
      if (mode.kind === "detail") return handleDetailKey(key);
      if (mode.kind === "collision") {
        if (key.escape) setMode({ kind: "list" });
        else if (input === "r") void confirmRelaunch(mode.req, mode.existing);
        return;
      }
      if (mode.kind === "confirm-remove") {
        // Cancel returns to the detail panel the confirm was launched from
        // (same as the MCP/Skills tabs), not all the way to the list.
        if (key.escape || input === "n" || input === "N") setMode({ kind: "detail" });
        else if (input === "y" || input === "Y") void doRemove(mode.alias);
        return;
      }
      if (mode.kind === "notice" || mode.kind === "log") {
        if (key.escape || key.return) setMode({ kind: "list" });
        return;
      }
      if (mode.kind === "result") {
        // ⏎/r re-runs (= resume on conflict) · esc back to the list.
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
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text color={colors.warn}>{icons.spinner} ejecutando…</Text>
          {/* Not cancellable: git runs without prompts (GIT_TERMINAL_PROMPT=0)
              → fails fast on credentials instead of hanging. Ctrl+C aborts the TUI. */}
          <Text color={colors.faint}>git corriendo · no interrumpible — Ctrl+C aborta el TUI</Text>
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
            <Text color={colors.dim}>
              detiene sus procesos y borra .workflow/launch/{mode.alias}.
            </Text>
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
        ? { name: LAUNCH_ACTION.name, description: "abre una terminal" }
        : { name: LAUNCH_ACTION.name, description: "no lanzable — sin comando detectado" };
    }
    if (it.kind === "proc") {
      return {
        name: `${PROCESS_OPS[it.op]} · ${it.record.profile ?? "default"} (PID ${it.record.pid})`,
      };
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

      {/* Degraded-data notice: some subfetch failed (see the daily log for detail). */}
      {data.warnings.length > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.warn} wrap="truncate-end">
            {icons.alertDot} {data.warnings.length} advertencia
            {data.warnings.length > 1 ? "s" : ""} al cargar el workspace (datos parciales)
          </Text>
          {data.warnings.slice(0, 3).map((w, i) => (
            <Text key={`${i}-${w.slice(0, 16)}`} color={colors.faint} wrap="truncate-end">
              {"  "}
              {w}
            </Text>
          ))}
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

      {/* Layout with detail panel: the sources list on the left, actions panel
          on the right when a source is selected. */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          {hasSources ? (
            <>
              <SectionHead
                label="Sources"
                count={totalSources}
                marginTop={0}
                // Overflow indicator without spending a terminal row: the range
                // of the window currently rendered, only when rows hide above
                // or below.
                {...(rangeHint ? { hint: rangeHint } : {})}
                rightAction={detailOpen ? "esc to close detail" : "↑↓ select · ⏎ actions"}
              />
              <Box marginLeft={SOURCES_ROWS_INDENT} flexDirection="column">
                {targets.slice(win.start, winEnd).map((target, offset) => {
                  const i = win.start + offset;
                  // The last target is the "all sources" sentinel, not a source.
                  const source = target === ALL_SOURCES ? undefined : data.sources[i];
                  return source ? (
                    <SourceRow
                      key={source.alias}
                      source={source}
                      running={runningBySource.get(source.alias) ?? 0}
                      active={i === cursor}
                      widthHint={rowWidth(stdout?.columns, detailOpen, SOURCES_ROWS_INDENT)}
                    />
                  ) : (
                    <ListRow
                      key={ALL_SOURCES}
                      icon={icons.diamond}
                      title="all sources"
                      subtitle={`aplica a las ${totalSources} fuentes`}
                      chevron
                      active={i === cursor}
                      widthHint={rowWidth(stdout?.columns, detailOpen, SOURCES_ROWS_INDENT)}
                    />
                  );
                })}
              </Box>
            </>
          ) : null}
        </Box>

        {/* Detail panel — only once a source was selected with ⏎. */}
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
            { key: "g", label: "git status" },
          ]}
        />
      </Box>
    </Box>
  );
}

function SourceRow({
  source,
  running,
  active,
  widthHint,
}: {
  source: ProjectSource;
  /** Processes of this source currently `running`; 0 renders no chip. */
  running: number;
  active: boolean;
  widthHint: number;
}) {
  const status = source.dirty ? `${source.changedFiles} dirty` : "in sync";
  const branch = source.branch ?? source.mainBranch;
  // Commits carried by the branch itself; "—" when it cannot be measured (on
  // the main branch, no local base). Sits next to the dirty/in-sync chip: one
  // says what is committed, the other what is not.
  const commits: MetaChip =
    source.commitCount === null
      ? { label: "—", tone: "dim" }
      : { label: `+${source.commitCount}`, tone: "accent" };
  // Live activity, after the git chips: the dot is textual (never color alone)
  // and the count is the source's own `running` total (SPEC 019).
  const activity: MetaChip[] = running > 0 ? [{ label: `● ${running} running`, tone: "ok" }] : [];
  return (
    <ListRow
      icon={icons.diamond}
      iconActive={true}
      title={source.alias}
      subtitle={`main ${source.mainBranch}`}
      meta={[commits, { label: status, tone: source.dirty ? "warn" : "ok" }, ...activity]}
      state={{ label: `${icons.branch} ${branch}`, tone: "dim" }}
      chevron
      active={active}
      widthHint={widthHint}
    />
  );
}

/** Side panel of git-flow actions for the selected source (or "all sources"). */
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
  // GIT tile: `value` is the working branch; this `sub` is the main branch
  // (below it). ahead/behind go as a compact suffix only when they differ.
  const base = `base ${data.git.base}`;
  const sync: string[] = [];
  if (data.git.ahead > 0) sync.push(`↑${data.git.ahead}`);
  if (data.git.behind > 0) sync.push(`↓${data.git.behind}`);
  return sync.length > 0 ? `${base} · ${sync.join(" ")}` : base;
}
