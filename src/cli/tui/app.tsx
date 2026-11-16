import { basename } from "node:path";
import { Box, type Key, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GitFlowAction,
  type GitFlowInput,
  type GitFlowResult,
  runGitFlow,
} from "../../application/git-flow-service.js";
import { formatGitFlowSourceLine, formatTuiEvent } from "../../application/logging/log-events.js";
import { attributeTuiKeypress, grantProdConsent } from "../../application/prod-consent.js";
import { runSources } from "../../application/sources-service.js";
import type { ExitCode } from "../../domain/types.js";
import type { CliContext } from "../types.js";
import { ACTION_LABEL, FlowResultView } from "./components/git-flow-actions.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { SectionHead } from "./components/section-head.js";
import { hubRoot } from "./hub-root.js";
import { type PendingRead, readPending } from "./public-status.js";
import { rowWidth, truncateCells } from "./row-width.js";
import { colors, icons } from "./theme.js";
import { moveWithArrows, useListWindow, windowRangeHint } from "./use-list-window.js";
import { useTerminalSize } from "./use-terminal-size.js";

/** `update` leaves the TUI so the CLI runs `aw self update` on the main screen. */
export type TuiResult = { kind: "update" } | { kind: "exit"; exitCode: ExitCode };

export const ALL_SOURCES = "todas las fuentes";

const FLOW_ACTIONS: readonly GitFlowAction[] = ["sync", "to-dev", "to-qa", "to-prod"];

/** Pending items shown before the rest collapse into one «+N más» line. */
const MAX_PENDING = 5;

/**
 * Rows the frame spends whatever the view: border + paddingY (4), title (1),
 * body marginTop (1), footer (1 + 1 marginTop) and 1 of slack.
 */
const CHROME_ROWS = 9;

/** A git-flow view's own rows above its list: SectionHead (1) + its summary line with marginY (3). */
const FLOW_VIEW_ROWS = 4;

interface SourceLine {
  alias: string;
  branch: string | null;
  dirty: boolean | null;
  error: string | null;
}

type Sources =
  | { state: "loading" }
  | { state: "none" }
  | { state: "failed"; message: string }
  | { state: "ready"; lines: SourceLine[] };

type Mode =
  | { kind: "home" }
  | { kind: "actions" }
  | { kind: "running"; label: string }
  | { kind: "result"; action: GitFlowAction; result: GitFlowResult }
  | { kind: "confirm-prod"; input: GitFlowInput; preview: GitFlowResult }
  | { kind: "notice"; lines: string[] };

export interface AppProps {
  version: string;
  ctx: CliContext;
  onResult: (result: TuiResult) => void;
}

/**
 * The whole TUI: one screen that answers «where is my work and what can I do
 * now?» — the hub's pending items, its sources with their branch and state,
 * the git flow over one source or all of them, and the update line.
 */
export function App({ version, ctx, onResult }: AppProps) {
  const { exit } = useApp();
  const [pending, setPending] = useState<PendingRead | null>(null);
  const [sources, setSources] = useState<Sources>({ state: "loading" });
  const [latest, setLatest] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "home" });
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadNonce` is the refresh trigger.
  useEffect(() => {
    let live = true;
    void readPending(ctx).then((read) => live && setPending(read));
    void loadSources(ctx).then((read) => live && setSources(read));
    void latestVersion(ctx, version).then((v) => live && setLatest(v));
    return () => {
      live = false;
    };
  }, [ctx, version, reloadNonce]);

  const lines = sources.state === "ready" ? sources.lines : [];
  const targets = lines.length > 0 ? [...lines.map((s) => s.alias), ALL_SOURCES] : [];
  const target = targets[Math.min(cursor, targets.length - 1)] ?? ALL_SOURCES;

  const quit = useCallback(
    (result: TuiResult) => {
      onResult(result);
      exit();
    },
    [onResult, exit],
  );

  const backHome = useCallback(() => {
    setMode({ kind: "home" });
    setReloadNonce((n) => n + 1);
  }, []);

  const executeFlow = useCallback(
    async (input: GitFlowInput, label: string) => {
      const { action } = input;
      setMode({ kind: "running", label: `${ACTION_LABEL[action]} · ${label}` });
      const event = `git-flow ${action} · ${label === ALL_SOURCES ? "all-sources" : label}`;
      const result = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input).catch(
        (err): GitFlowResult => failedRun(action, (err as Error).message),
      );
      logFlowResult(ctx, event, result);
      // The plan moved between the preview and the yes: nothing ran, and the
      // person is asked again over the preview of what would run now.
      if (result.consent_required !== undefined) {
        const { consent: _spent, ...fresh } = input;
        return setMode({ kind: "confirm-prod", input: fresh, preview: result });
      }
      setMode({ kind: "result", action, result });
    },
    [ctx],
  );

  // «Enviar a PROD» never runs straight away: it opens confirm-prod over the
  // service's own preview. "All sources" becomes the explicit list of declared
  // sources (the service refuses `all` for PROD).
  const runFlow = useCallback(
    async (action: GitFlowAction) => {
      const isAll = target === ALL_SOURCES;
      if (action !== "to-prod") {
        return executeFlow(isAll ? { action, all: true } : { action, source: target }, target);
      }
      setMode({ kind: "running", label: `${ACTION_LABEL[action]} · vista previa · ${target}` });
      const input: GitFlowInput = isAll
        ? { action, sources: lines.map((s) => s.alias) }
        : { action, source: target };
      const preview = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input).catch(
        (err): GitFlowResult => failedRun(action, (err as Error).message),
      );
      if (preview.consent_required === undefined) {
        logFlowResult(ctx, `git-flow ${action} · ${target}`, preview);
        return setMode({ kind: "result", action, result: preview });
      }
      setMode({ kind: "confirm-prod", input, preview });
    },
    [ctx, target, lines, executeFlow],
  );

  // `y` in confirm-prod: only a process with no agent marker publishes, only
  // the plan the preview showed, and each preview is answered once.
  const answeredPreview = useRef<GitFlowResult | null>(null);
  const publishProd = useCallback(
    (input: GitFlowInput, preview: GitFlowResult) => {
      const need = preview.consent_required;
      if (need === undefined || answeredPreview.current === preview) return;
      answeredPreview.current = preview;
      const label = input.sources ? ALL_SOURCES : (input.source ?? "");
      const who = attributeTuiKeypress(ctx.env);
      if (!who.person) {
        void ctx.logger?.warn(formatTuiEvent(`git-flow to-prod · ${label}`, "refused", who.reason));
        return setMode({
          kind: "notice",
          lines: [
            "La publicación en PROD la hace la persona: desde la TUI o desde su propia terminal.",
            `No se publicó: ${who.reason}.`,
          ],
        });
      }
      const consent = grantProdConsent(who, need.sources, need.plan);
      if (consent !== null) void executeFlow({ ...input, consent }, label);
    },
    [ctx, executeFlow],
  );

  const onActionsKey = (key: Key) => {
    if (key.escape) return setMode({ kind: "home" });
    if (moveWithArrows(key, FLOW_ACTIONS.length, setActionCursor)) return;
    const action = FLOW_ACTIONS[actionCursor];
    if (key.return && action) void runFlow(action);
  };

  const onHomeKey = (input: string, key: Key) => {
    if (input === "r") return setReloadNonce((n) => n + 1);
    if (targets.length === 0 || moveWithArrows(key, targets.length, setCursor)) return;
    if (key.return) {
      setActionCursor(0);
      setMode({ kind: "actions" });
    }
  };

  useInput(
    (input, key) => {
      if (input === "q") return quit({ kind: "exit", exitCode: 0 });
      const global = mode.kind === "home" || mode.kind === "actions";
      if (input === "u" && latest !== null && global) return quit({ kind: "update" });
      if (mode.kind === "notice" && key.escape) return backHome();
      if (mode.kind === "actions") return onActionsKey(key);
      if (mode.kind === "home") onHomeKey(input, key);
    },
    { isActive: mode.kind !== "running" && mode.kind !== "confirm-prod" },
  );

  const updateKey = latest !== null ? " · u actualizar" : "";
  const chrome = CHROME_ROWS + (latest !== null ? 1 : 0);

  return (
    <ScreenFrame>
      <Text>
        <Text color={colors.accent} bold>
          agent-workflow
        </Text>
        <Text color={colors.dim}> · {basename(hubRoot(ctx))}</Text>
      </Text>
      {latest !== null ? (
        <Text color={colors.warn}>
          Versión nueva: v{version} {icons.arrow} v{latest}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {mode.kind === "running" ? (
          <Text color={colors.dim}>
            {icons.spinner} {mode.label}…
          </Text>
        ) : null}
        {mode.kind === "result" ? (
          <FlowResultView
            action={mode.action}
            result={mode.result}
            reservedRows={chrome + FLOW_VIEW_ROWS}
            isActive
            onBack={backHome}
          />
        ) : null}
        {mode.kind === "confirm-prod" ? (
          <FlowResultView
            action="to-prod"
            result={mode.preview}
            reservedRows={chrome + FLOW_VIEW_ROWS}
            isActive
            confirm={{
              onPublish: () => publishProd(mode.input, mode.preview),
              onCancel: () => setMode({ kind: "home" }),
            }}
          />
        ) : null}
        {mode.kind === "notice"
          ? mode.lines.map((line) => (
              <Text key={line} color={colors.err}>
                {line}
              </Text>
            ))
          : null}
        {mode.kind === "actions" ? <ActionList target={target} cursor={actionCursor} /> : null}
        {mode.kind === "home" ? (
          <Home
            pending={pending}
            sources={sources}
            targets={targets}
            cursor={cursor}
            chrome={chrome}
          />
        ) : null}
      </Box>
      {footerFor(mode, targets.length > 0, updateKey)}
    </ScreenFrame>
  );
}

function footerFor(mode: Mode, hasTargets: boolean, updateKey: string) {
  const keys =
    mode.kind === "home"
      ? `${hasTargets ? "↑↓ mover · ⏎ acciones · " : ""}r refrescar · q salir${updateKey}`
      : mode.kind === "actions"
        ? `↑↓ mover · ⏎ ejecutar · esc volver · q salir${updateKey}`
        : mode.kind === "notice"
          ? "esc volver · q salir"
          : null;
  if (keys === null) return null;
  return (
    <Box marginTop={1}>
      <Text color={colors.mute}>{keys}</Text>
    </Box>
  );
}

function Home({
  pending,
  sources,
  targets,
  cursor,
  chrome,
}: {
  pending: PendingRead | null;
  sources: Sources;
  targets: string[];
  cursor: number;
  chrome: number;
}) {
  const { cols } = useTerminalSize();
  const width = rowWidth(cols, 2);
  const items = pending?.state === "available" ? pending.items : [];
  const shown = items.slice(0, MAX_PENDING);
  const pendingRows = 2 + Math.max(1, shown.length * 2) + (items.length > MAX_PENDING ? 1 : 0);
  // Pending block + sources SectionHead (1); the window keeps the cursor visible.
  const win = useListWindow(targets.length, cursor, chrome + pendingRows + 1);
  const range = windowRangeHint(win, targets.length);

  return (
    <Box flexDirection="column">
      <SectionHead label="Pendientes" count={pending?.state === "available" ? items.length : ""} />
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        {pending === null ? <Text color={colors.dim}>{icons.spinner} leyendo…</Text> : null}
        {pending?.state === "unavailable" ? (
          <Text color={colors.dim}>No se pudo leer `aw status`.</Text>
        ) : null}
        {pending?.state === "available" && items.length === 0 ? (
          <Text color={colors.dim}>Sin trabajo pendiente.</Text>
        ) : null}
        {shown.map((item) => (
          <Box key={item.file} flexDirection="column">
            <Text color={colors.text}>
              {truncateCells(`${item.file} ${icons.bullet} ${item.next}`, width)}
            </Text>
            <Text color={colors.dim}>{truncateCells(`  ${item.command ?? "—"}`, width)}</Text>
          </Box>
        ))}
        {items.length > MAX_PENDING ? (
          <Text color={colors.mute}>+{items.length - MAX_PENDING} más · aw status</Text>
        ) : null}
      </Box>
      <SectionHead label="Fuentes" {...(range ? { hint: range } : {})} />
      <Box flexDirection="column" marginLeft={2}>
        {sources.state === "loading" ? (
          <Text color={colors.dim}>{icons.spinner} leyendo…</Text>
        ) : null}
        {sources.state === "none" ? (
          <Text color={colors.dim}>
            Sin fuentes declaradas: declaralas con `aw add-source` o `aw hub-init --source …`.
          </Text>
        ) : null}
        {sources.state === "failed" ? (
          <Text color={colors.err}>No se pudieron leer las fuentes: {sources.message}</Text>
        ) : null}
        {sources.state === "ready"
          ? targets.slice(win.start, win.start + win.visible).map((alias, i) => {
              const active = win.start + i === cursor;
              const line = sources.lines.find((s) => s.alias === alias);
              return (
                <Text key={alias}>
                  <Text color={active ? colors.accent : colors.faint}>
                    {active ? icons.focusBar : " "}{" "}
                  </Text>
                  <Text color={active ? colors.bright : colors.text} bold={active}>
                    {alias}
                  </Text>
                  {line ? <Text color={colors.dim}> {sourceState(line)}</Text> : null}
                </Text>
              );
            })
          : null}
      </Box>
    </Box>
  );
}

function ActionList({ target, cursor }: { target: string; cursor: number }) {
  return (
    <Box flexDirection="column">
      <SectionHead label={target} />
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {FLOW_ACTIONS.map((action, i) => (
          <Text key={action} color={i === cursor ? colors.bright : colors.text} bold={i === cursor}>
            <Text color={i === cursor ? colors.accent : colors.faint}>
              {i === cursor ? icons.focusBar : " "}{" "}
            </Text>
            {ACTION_LABEL[action]}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function sourceState(line: SourceLine): string {
  if (line.error !== null) return line.error;
  const branch = line.branch ?? "sin rama";
  if (line.dirty === null) return branch;
  return `${branch} ${icons.bullet} ${line.dirty ? "con cambios sin confirmar" : "limpia"}`;
}

async function loadSources(ctx: CliContext): Promise<Sources> {
  try {
    const out = await runSources(ctx.fs, ctx.env, ctx.git, ctx.paths, {});
    if (out.error === "no_sources_declared") return { state: "none" };
    return {
      state: "ready",
      lines: out.sources.map((s) => ({
        alias: s.alias ?? "?",
        branch: s.current_branch ?? null,
        dirty: s.dirty ?? null,
        error: s.error ?? null,
      })),
    };
  } catch (err) {
    const message = (err as Error).message;
    void ctx.logger?.warn(formatTuiEvent("sources", "failed", message));
    return { state: "failed", message };
  }
}

/**
 * The newer published version, or `null`. No network, a registry error or the
 * same version all mean no line: a failed check is logged, never shown.
 */
async function latestVersion(ctx: CliContext, version: string): Promise<string | null> {
  try {
    const result = await ctx.process.run("npm", ["view", ctx.runtime.packageName, "version"], {});
    const latest = result.code === 0 ? result.stdout.trim() : "";
    if (result.code !== 0) {
      void ctx.logger?.warn(formatTuiEvent("update check", "failed", result.stderr.trim()));
    }
    return latest !== "" && latest !== version ? latest : null;
  } catch (err) {
    void ctx.logger?.warn(formatTuiEvent("update check", "failed", (err as Error).message));
    return null;
  }
}

function failedRun(action: GitFlowAction, error: string): GitFlowResult {
  return { action, dry_run: false, status: "error", results: [], error };
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
