import { basename } from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type GitFlowAction,
  type GitFlowInput,
  type GitFlowResult,
  runGitFlow,
} from "../../../application/git-flow-service.js";
import {
  formatGitFlowSourceLine,
  formatTuiEvent,
} from "../../../application/logging/log-events.js";
import { readWorkspaceBlock } from "../../../application/parsers/project-block.js";
import { attributeTuiKeypress, grantProdConsent } from "../../../application/prod-consent.js";
import {
  type ProjectSource,
  type ProjectTabData,
  buildProjectTabData,
} from "../../../application/project-tab-data.js";
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
        void ctx.logger?.warn(formatTuiEvent("hub data", "warning", w));
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

  // Configuration is secondary: the normal workspace view stays available even
  // without a WORKSPACE block, and `c` opens the source configuration wizard.
  useInput(
    (input) => {
      if (!data) return;
      if (input === "c") {
        setInitForm(true);
        return;
      }
      if (input === "g") onRunAction?.("git:status");
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

  return (
    <Initialized
      ctx={ctx}
      data={data}
      isActive={isActive}
      onRunAction={onRunAction}
      onReload={loadData}
      onConfigureSources={() => setInitForm(true)}
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
  // ===== Publishing in PROD (SCR-002@r7#confirm-prod) =====
  | { kind: "confirm-prod"; input: GitFlowInput; preview: GitFlowResult }
  // ===== Source removal =====
  | { kind: "confirm-remove"; alias: string }
  | { kind: "busy"; label: string }
  | { kind: "notice"; tone: "ok" | "err"; lines: string[] };

/** The aliases the WORKSPACE block declares, readable or not. */
async function declaredAliases(ctx: CliContext): Promise<string[]> {
  const block = await readWorkspaceBlock(
    ctx.fs,
    ctx.paths.workspaceDir(),
    ctx.paths.blockMarkers(),
  );
  return (block?.fuentes ?? []).map((s) => s.alias);
}

const FLOW_LOG_LEVEL = { ok: "info", conflict: "warn", error: "error" } as const;

/** The event line, then one line per source that did not finish (source, step, git's stderr). */
function logFlowResult(ctx: CliContext, event: string, result: GitFlowResult): void {
  void ctx.logger?.log(
    FLOW_LOG_LEVEL[result.status],
    formatTuiEvent(event, result.status, result.error),
  );
  for (const r of result.results) {
    if (r.status === "ok") continue;
    void ctx.logger?.log(FLOW_LOG_LEVEL[r.status], formatGitFlowSourceLine(result.action, r));
  }
}

/** One selectable row of the source detail panel, in render order. */
type DetailItem = { kind: "flow"; action: GitFlowAction } | { kind: "remove" };

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
  onConfigureSources?: (() => void) | undefined;
}

function Initialized({
  ctx,
  data,
  isActive,
  onRunAction,
  onReload,
  onConfigureSources,
}: InitializedProps) {
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

  // Global keys are locked for every mode except the plain list and the detail
  // panel (its ↑↓ ⏎ esc don't collide with the globals). MCP/Skills policy.
  useLockWhile(mode.kind !== "list" && mode.kind !== "detail");

  const detailOpen = mode.kind === "detail";
  const currentTarget = targets[cursor] ?? ALL_SOURCES;
  const isAllTarget = currentTarget === ALL_SOURCES;
  const currentSource = isAllTarget
    ? null
    : (data.sources.find((s) => s.alias === currentTarget) ?? null);

  // Git-flow actions plus source removal, never legacy launcher controls.
  const detailItems = useMemo<DetailItem[]>(
    () => [
      ...FLOW_ACTIONS.map((a) => ({ kind: "flow" as const, action: a.id })),
      ...(currentSource ? [{ kind: "remove" as const }] : []),
    ],
    [currentSource],
  );

  // Run a git-flow input and show its result. Every source that did not finish
  // leaves its own line (source, step, git's stderr) next to the event line.
  const executeFlow = useCallback(
    async (input: GitFlowInput, label: string) => {
      const action = input.action;
      const actionName = FLOW_ACTIONS.find((a) => a.id === action)?.name ?? action;
      setMode({ kind: "running", label: `${actionName} · ${label}` });
      const event = `git-flow ${action} · ${label === "all sources" ? "all-sources" : label}`;
      try {
        const result = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input);
        logFlowResult(ctx, event, result);
        // The plan moved between the preview and the yes: nothing ran, and the
        // person is asked again over the preview of what would run now.
        if (result.consent_required !== undefined) {
          const { consent: _spent, ...fresh } = input;
          return setMode({ kind: "confirm-prod", input: fresh, preview: result });
        }
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
    [ctx],
  );

  // «Enviar a PROD» never runs from the panel: it opens confirm-prod over the
  // service's own preview, and `r` on its result comes back here too. "All
  // sources" becomes the explicit list the confirmation shows (--all is refused
  // for PROD by the service).
  const runFlow = useCallback(
    async (action: GitFlowAction) => {
      const target = targets[cursor] ?? ALL_SOURCES;
      const isAll = target === ALL_SOURCES;
      const label = isAll ? "all sources" : target;
      if (action !== "to-prod") {
        const input: GitFlowInput = isAll ? { action, all: true } : { action, source: target };
        return executeFlow(input, label);
      }
      // Locked while the preview is built: a key pressed meanwhile must not be
      // overtaken by a confirmation opening on top of where the person went.
      setMode({ kind: "running", label: `Enviar a PROD · vista previa · ${label}` });
      // Every declared source, not only the ones the listing could read: one
      // that is not a repo still belongs on the list, and says so when it runs.
      const input: GitFlowInput = isAll
        ? { action, sources: await declaredAliases(ctx) }
        : { action, source: target };
      const preview = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input).catch(
        (err): GitFlowResult => ({
          action,
          dry_run: false,
          status: "error",
          results: [],
          error: (err as Error).message,
        }),
      );
      if (preview.consent_required === undefined) {
        logFlowResult(ctx, `git-flow ${action} · ${label}`, preview);
        return setMode({ kind: "result", action, result: preview });
      }
      setMode({ kind: "confirm-prod", input, preview });
    },
    [cursor, ctx, targets, executeFlow],
  );

  // `y` in confirm-prod: only a process with no agent marker publishes, and only
  // the plan the preview showed, for exactly the sources it listed.
  // A preview is answered once: a second `y` that reaches a listener Ink has
  // not swapped yet would otherwise grant a second consent for the same plan.
  const answeredPreview = useRef<GitFlowResult | null>(null);
  const publishProd = useCallback(
    (input: GitFlowInput, preview: GitFlowResult) => {
      const need = preview.consent_required;
      if (need === undefined || answeredPreview.current === preview) return;
      answeredPreview.current = preview;
      const label = input.sources ? "all sources" : (input.source ?? "");
      const who = attributeTuiKeypress(ctx.env);
      if (!who.person) {
        void ctx.logger?.warn(formatTuiEvent(`git-flow to-prod · ${label}`, "refused", who.reason));
        return setMode({
          kind: "notice",
          tone: "err",
          lines: [
            "La publicación en PROD la hace la persona: desde el TUI o desde su propia terminal.",
            `No se publicó: ${who.reason}.`,
          ],
        });
      }
      const consent = grantProdConsent(who, need.sources, need.plan);
      if (consent === null) return;
      void executeFlow({ ...input, consent }, label);
    },
    [ctx, executeFlow],
  );

  // Remove a source from the workspace, preserving legacy local artifacts.
  const doRemove = useCallback(
    async (alias: string) => {
      setMode({ kind: "busy", label: `Quitando ${alias}…` });
      const res = await removeSource({ fs: ctx.fs, env: ctx.env, paths: ctx.paths }, alias);
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
              lines: [`Quitada ${alias} del hub.`],
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
      if (input === "c") return onConfigureSources?.();
      if (!hasSources) return;
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(targets.length - 1, c + 1));
      if (key.return) {
        setActionCursor(0);
        setMode({ kind: "detail" });
      }
    },
    [hasSources, onConfigureSources, onRunAction, targets.length],
  );

  // Side panel actions (↑↓ navigate · ⏎ run · esc close).
  const handleDetailKey = useCallback(
    (key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
      if (key.upArrow) return setActionCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setActionCursor((c) => Math.min(detailItems.length - 1, c + 1));
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        runSourceAction(detailItems[actionCursor], currentSource, setMode, runFlow);
      }
    },
    [actionCursor, detailItems, currentSource, runFlow],
  );

  // input — delegates to the handler of the active mode.
  useInput(
    (input, key) => {
      if (!isActive) return;
      if (mode.kind === "list") return handleListKey(input, key);
      if (mode.kind === "detail") return handleDetailKey(key);
      if (mode.kind === "confirm-remove") {
        confirmSourceRemoval(input, key, mode.alias, setMode, doRemove);
        return;
      }
      if (mode.kind === "notice") {
        if (key.escape || key.return) setMode({ kind: "list" });
        return;
      }
      // `result` and `confirm-prod` handle their own keys: FlowResultView owns the cursor, the
      // horizontal window and the conflict detail, and calls back for the two
      // consequences that are the tab's (re-run, and back+reload). Keeping a
      // branch here too would give `r` and `esc` two handlers — Ink delivers
      // input to every active hook.
    },
    { isActive },
  );

  const modeView = renderProjectMode(mode, isActive, publishProd, runFlow, setMode, onReload);
  if (modeView !== null) return modeView;

  const detailActions: DetailAction[] = detailItems.map((it) => {
    if (it.kind === "remove") {
      return { name: "Quitar del hub", description: "detach + poda bloque" };
    }
    const fa = FLOW_ACTIONS.find((a) => a.id === it.action);
    return { name: fa?.name ?? it.action, description: fa?.description ?? "" };
  });

  return (
    <Box flexDirection="column">
      <PageHead title={`Hub · ${shortName}`} action={<Text color={colors.faint}>{wsPath}</Text>} />
      {description ? (
        <Box marginBottom={1}>
          <Text color={colors.dim} wrap="truncate-end">
            {description}
          </Text>
        </Box>
      ) : null}

      {/* Degraded-data notice: some subfetch failed (see the daily log for detail). */}
      {renderProjectWarnings(data.warnings)}

      {/* Health cards */}
      {renderProjectHealth(data, dirty, totalSources, dirtySources, workingEntries.length)}

      {/* Layout with detail panel: the sources list on the left, actions panel
          on the right when a source is selected. */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          {renderSourceList(
            hasSources,
            totalSources,
            rangeHint,
            detailOpen,
            targets,
            win.start,
            winEnd,
            data,
            cursor,
            stdout?.columns,
          )}
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
            { key: "c", label: "configurar fuentes" },
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
  // Commits carried by the branch itself; "—" when it cannot be measured (on
  // the main branch, no local base). Sits next to the dirty/in-sync chip: one
  // says what is committed, the other what is not.
  const commits: MetaChip =
    source.commitCount === null
      ? { label: "—", tone: "dim" }
      : { label: `+${source.commitCount}`, tone: "accent" };
  return (
    <ListRow
      icon={icons.diamond}
      iconActive={true}
      title={source.alias}
      subtitle={source.error ?? `main ${source.mainBranch}`}
      meta={[commits, { label: status, tone: source.dirty ? "warn" : "ok" }]}
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

function runSourceAction(
  item: DetailItem | undefined,
  currentSource: ProjectSource | null,
  setMode: Dispatch<SetStateAction<Mode>>,
  runFlow: (action: GitFlowAction) => Promise<void>,
) {
  if (!item) return;
  if (item.kind === "remove") {
    if (currentSource) return setMode({ kind: "confirm-remove", alias: currentSource.alias });
    return;
  }
  void runFlow(item.action);
}

function confirmSourceRemoval(
  input: string,
  key: { escape?: boolean },
  alias: string,
  setMode: Dispatch<SetStateAction<Mode>>,
  doRemove: (alias: string) => Promise<void>,
) {
  // Cancel returns to the detail panel the confirm was launched from
  // (same as the MCP/Skills tabs), not all the way to the list.
  if (key.escape || input === "n" || input === "N") setMode({ kind: "detail" });
  else if (input === "y" || input === "Y") void doRemove(alias);
  return;
}

function renderProjectMode(
  mode: Mode,
  isActive: boolean,
  publishProd: (input: GitFlowInput, preview: GitFlowResult) => void,
  runFlow: (action: GitFlowAction) => Promise<void>,
  setMode: Dispatch<SetStateAction<Mode>>,
  onReload: InitializedProps["onReload"],
) {
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

  if (mode.kind === "confirm-prod") {
    return (
      <FlowResultView
        action="to-prod"
        result={mode.preview}
        isActive={isActive}
        confirm={{
          onPublish: () => publishProd(mode.input, mode.preview),
          onCancel: () => setMode({ kind: "detail" }),
        }}
      />
    );
  }

  if (mode.kind === "result") {
    return (
      <FlowResultView
        action={mode.action}
        result={mode.result}
        isActive={isActive}
        onRerun={() => void runFlow(mode.action)}
        onBack={() => {
          setMode({ kind: "list" });
          void onReload?.();
        }}
      />
    );
  }

  if (mode.kind === "busy") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Hub" hint={mode.label} />
        <Box marginLeft={2} marginTop={1}>
          <Text color={colors.warn}>
            {icons.spinner} {mode.label}
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode.kind === "confirm-remove") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Quitar del hub" marginTop={0} />
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text color={colors.warn}>¿Quitar {mode.alias} del hub?</Text>
          <Box marginLeft={2} marginTop={1} flexDirection="column">
            <Text color={colors.dim}>
              Sale del bloque del hub (Fuentes + ramas), de la visibilidad multi-root,
            </Text>
            <Text color={colors.dim}>conserva los artefactos y procesos locales anteriores.</Text>
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

  return null;
}

function renderProjectHealth(
  data: ProjectTabData,
  dirty: number,
  totalSources: number,
  dirtySources: number,
  workingCount: number,
) {
  return (
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
        value={`${workingCount}`}
        sub={workingCount > 0 ? "declared" : "none"}
        tone={workingCount > 0 ? "accent" : "dim"}
      />
    </Box>
  );
}

function renderSourceList(
  hasSources: boolean,
  totalSources: number,
  rangeHint: string | undefined,
  detailOpen: boolean,
  targets: string[],
  start: number,
  winEnd: number,
  data: ProjectTabData,
  cursor: number,
  columns: number | undefined,
) {
  return hasSources ? (
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
        {targets.slice(start, winEnd).map((target, offset) => {
          const i = start + offset;
          // The last target is the "all sources" sentinel, not a source.
          const source = target === ALL_SOURCES ? undefined : data.sources[i];
          return source ? (
            <SourceRow
              key={source.alias}
              source={source}
              active={i === cursor}
              widthHint={rowWidth(columns, detailOpen, SOURCES_ROWS_INDENT)}
            />
          ) : (
            <ListRow
              key={ALL_SOURCES}
              icon={icons.diamond}
              title="all sources"
              subtitle={`aplica a las ${totalSources} fuentes`}
              chevron
              active={i === cursor}
              widthHint={rowWidth(columns, detailOpen, SOURCES_ROWS_INDENT)}
            />
          );
        })}
      </Box>
    </>
  ) : null;
}

function renderProjectWarnings(warnings: string[]) {
  return warnings.length > 0 ? (
    <Box marginBottom={1} flexDirection="column">
      <Text color={colors.warn} wrap="truncate-end">
        {icons.alertDot} {warnings.length} advertencia
        {warnings.length > 1 ? "s" : ""} al cargar el hub (datos parciales)
      </Text>
      {warnings.slice(0, 3).map((w, i) => (
        <Text key={`${i}-${w.slice(0, 16)}`} color={colors.faint} wrap="truncate-end">
          {"  "}
          {w}
        </Text>
      ))}
    </Box>
  ) : null;
}
