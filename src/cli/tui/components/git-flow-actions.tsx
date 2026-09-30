import { Box, type Key, Text, useInput } from "ink";
import { type Dispatch, type ReactNode, type SetStateAction, useMemo, useState } from "react";
import type {
  GitFlowAction,
  GitFlowResult,
  GitFlowSourceResult,
} from "../../../application/git-flow-service.js";
import { useNotificationItems } from "../notification-center.js";
import { rowWidth, truncateCells } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { useListWindow, windowRangeHint } from "../use-list-window.js";
import { useTerminalSize } from "../use-terminal-size.js";
import { notificationStackRows } from "./notification-stack.js";
import { SectionHead } from "./section-head.js";

/**
 * Interactive render of a git-flow run for the Project tab: overall status +
 * exactly ONE non-wrapping row per source, each carrying its whole ordered
 * step chain.
 *
 * The shell clips overflow (`overflowY="hidden"` in app.tsx + ScreenFrame), so
 * the previous block-per-source layout (a header, a row per step, extra blocks
 * for conflict/error) left the last sources unreachable: no cursor, no window,
 * and the terminal's own scroll cannot get there. Here the list is windowed
 * like SOURCES (↑/↓) and a chain wider than the row is reached with ←/→ instead
 * of wrapping — the alias and the status never move out of their fixed zone.
 *
 * The keys live here and not in ProjectTab: the tab keeps the run and the
 * global lock and gets `onRerun` / `onBack`, so `r` has exactly one consequence
 * and `Enter` is free to open the conflict/error detail.
 */

const ACTION_LABEL: Record<GitFlowAction, string> = {
  sync: "Actualizar",
  "to-dev": "→ Dev",
  "to-qa": "→ QA",
  "to-prod": "→ Prod",
};

const SOURCE_STATUS_LABEL: Record<GitFlowSourceResult["status"], string> = {
  ok: "ok",
  conflict: "conflict",
  error: "error",
};

/** Cells one ←/→ press moves the chain window. */
const CHAIN_SCROLL_CELLS = 8;

/** Cells the selection marker and its trailing space take on every row. */
const MARKER_CELLS = 2;

/** marginLeft of the rows container, passed to {@link rowWidth} as `indent`. */
const ROWS_INDENT = 2;

/**
 * Cap on the alias column. A workspace alias is short; letting an unusually long
 * one size the column would starve the chain zone on every OTHER row. Past this
 * the alias is truncated (with `…`) and stays identifiable, which is what the
 * row owes — the chain remains reachable with ←/→, which is what it must not lose.
 */
const ALIAS_MAX_CELLS = 24;

/**
 * Floor on the alias column. A narrow terminal prioritizes the fixed zone: with
 * fewer than this the alias would render empty (`truncateCells(s, 1)` is `""`)
 * and the row would lose the identity it exists to keep. The chain keeps the
 * rest and stays reachable with ←/→ however little it gets.
 */
const ALIAS_MIN_CELLS = 4;

// Terminal rows eaten around the result list, handed to `useListWindow` so the
// selected row never clips under app.tsx's `overflowY="hidden"` (same accounting
// style as SOURCES_LIST_RESERVED_ROWS in project-tab):
// - app shell: ScreenFrame border+paddingY (4) + HomeHeader (2 lines + 1 margin)
//   + TabBar (1 line + 2 border) + tab content box border+paddingY (4)
//   + HomeFooter (1 line + 1 margin) = 16
// - this view, fixed: SectionHead (1) + status summary (1 line + 1 marginTop) = 3
// - 1 slack: better one row short than a clipped selected row.
// The NotificationStack height (0 unless a banner is visible) is added per
// render. The visible range rides in the SectionHead `hint` slot precisely so
// it costs no row of its own.
const RESULT_LIST_RESERVED_ROWS = 20;

/** `confirm-prod` adds its footer (1 line + 1 marginTop); its warning takes the summary's rows. */
const CONFIRM_FOOTER_ROWS = 2;

/**
 * `confirm-prod` (SCR-002@r7): the same compact list, fed by the service's
 * preview instead of a run. The tab decides what `y` does — this view only
 * reports which key the person pressed.
 */
export interface FlowConfirm {
  onPublish: () => void;
  onCancel: () => void;
}

export function FlowResultView({
  action,
  result,
  isActive = false,
  onRerun,
  onBack,
  confirm,
}: {
  action: GitFlowAction;
  result: GitFlowResult;
  isActive?: boolean;
  /** Present → render `confirm-prod` over `result` as a preview. */
  confirm?: FlowConfirm;
  /** `r`: re-runs the same action (= resumes after a resolved conflict). */
  onRerun?: () => void;
  /** `esc` from the list: back to the Project listing. */
  onBack?: () => void;
}) {
  const sources = result.results;
  const [cursor, setCursor] = useState(0);
  const [chainOffset, setChainOffset] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailCursor, setDetailCursor] = useState(0);

  // A new run is a new result object: selection, offset and detail start over.
  // Carrying a cursor across runs would point at another source's row.
  //
  // The reset runs during render (React's "adjust state when props change" —
  // guarded, no loop; the same pattern use-list-window.ts uses) so the stale
  // cursor never reaches a committed frame, which an effect would let through.
  const [seenResult, setSeenResult] = useState(result);
  if (seenResult !== result) {
    setSeenResult(result);
    setCursor(0);
    setChainOffset(0);
    setDetailOpen(false);
    setDetailCursor(0);
  }

  const { cols } = useTerminalSize();
  const notifItems = useNotificationItems();
  const reservedRows = reservedRowsFor(confirm !== undefined) + notificationStackRows(notifItems);
  const rowW = rowWidth(cols, false, ROWS_INDENT);

  // Fixed zone = marker + alias + status; only the chain scrolls, so a source
  // stays identifiable at any horizontal offset.
  const longestAlias = useMemo(
    () => Math.max(1, ...sources.map((r) => [...r.source].length)),
    [sources],
  );
  const statusWidth = useMemo(
    () => Math.max(2, ...sources.map((r) => SOURCE_STATUS_LABEL[r.status].length)),
    [sources],
  );
  // Everything that is not the alias or the chain: marker, the two separators
  // and the two gutters that carry `‹`/`›` on the selected row (blank elsewhere,
  // so every row's chain starts at the same column).
  const fixedCells = MARKER_CELLS + 1 + statusWidth + 1 + 2;
  // The row must NEVER build wider than `rowW`: Yoga would wrap it and one
  // source would take two rows — exactly what this view exists to avoid. So the
  // alias is capped against the width actually available, not only against
  // ALIAS_MAX_CELLS: a 20-column terminal plus a long alias would otherwise
  // reserve a fixed zone bigger than the whole row.
  const aliasWidth = Math.min(
    ALIAS_MAX_CELLS,
    longestAlias,
    Math.max(ALIAS_MIN_CELLS, rowW - fixedCells - CHAIN_SCROLL_CELLS),
  );
  const chainInner = Math.max(1, rowW - fixedCells - aliasWidth);

  const selected = sources[cursor];
  const chainFor = chainRendererFor(confirm !== undefined);
  const selectedChain = selected ? chainFor(selected) : "";
  const selectedChainCells = [...selectedChain];
  // Clamping on the way OUT (not on the keypress) is what makes a resize
  // correct: a wider terminal shrinks `maxOffset` and the row re-anchors
  // instead of showing a window past the end of the chain.
  const maxOffset = Math.max(0, selectedChainCells.length - chainInner);
  const offset = Math.min(chainOffset, maxOffset);

  const detailRows = useMemo(() => (selected ? detailLines(selected, rowW) : []), [selected, rowW]);

  const win = useListWindow(sources.length, cursor, reservedRows);
  const detailWin = useListWindow(detailRows.length, detailCursor, reservedRows);

  useInput(
    (input, key) => {
      if (detailOpen) {
        return handleFlowDetailKey(key, detailRows.length, setDetailOpen, setDetailCursor);
      }
      const leave = leavingKey(input, key, confirm, onBack, onRerun);
      if (leave !== undefined) return leave();
      if (key.upArrow) {
        setChainOffset(0);
        return setCursor((c) => Math.max(0, c - 1));
      }
      if (key.downArrow) {
        setChainOffset(0);
        return setCursor((c) => Math.min(Math.max(0, sources.length - 1), c + 1));
      }
      if (key.leftArrow) return setChainOffset(Math.max(0, offset - CHAIN_SCROLL_CELLS));
      if (key.rightArrow) return setChainOffset(Math.min(maxOffset, offset + CHAIN_SCROLL_CELLS));
      // Enter opens the detail ONLY on a conflict or an error: a successful
      // source already shows everything it has in its chain, and in `result`
      // Enter is no longer an alias for re-running (`r` is the only one).
      if (key.return && selected && selected.status !== "ok") {
        setDetailCursor(0);
        setDetailOpen(true);
      }
    },
    { isActive },
  );

  if (detailOpen && selected) {
    return (
      <Box flexDirection="column">
        <SectionHead
          label={`Git flow · ${ACTION_LABEL[action]} · ${selected.source}`}
          {...spreadHint(windowRangeHint(detailWin, detailRows.length))}
          rightAction="↑↓ recorrer · esc volver"
        />
        <Box marginLeft={ROWS_INDENT} marginTop={1}>
          <Text color={statusColor(selected.status)} bold>
            {statusGlyph(selected.status)}{" "}
          </Text>
          <Text color={statusColor(selected.status)}>{SOURCE_STATUS_LABEL[selected.status]}</Text>
        </Box>
        <Box marginLeft={ROWS_INDENT} flexDirection="column">
          {detailRows.slice(detailWin.start, detailWin.start + detailWin.visible).map((line, i) => (
            <Text key={`${detailWin.start + i}-${line}`} color={colors.text}>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  const tone =
    result.status === "ok" ? colors.ok : result.status === "conflict" ? colors.warn : colors.err;
  const summary =
    result.status === "ok"
      ? "completed"
      : result.status === "conflict"
        ? "paused on conflict"
        : (result.error ?? "error");
  const range = windowRangeHint(win, sources.length);

  const rows = (
    <Box marginLeft={ROWS_INDENT} flexDirection="column">
      {sources.slice(win.start, win.start + win.visible).map((r, i) => {
        const index = win.start + i;
        const active = index === cursor;
        const chain = active ? selectedChain : chainFor(r);
        // The active row slices its exact window (the `‹›` gutters say what
        // is outside it); an inactive one marks its cut with `…` so a chain
        // that does not fit never looks complete.
        const shown = active
          ? selectedChainCells.slice(offset, offset + chainInner).join("")
          : truncateCells(chain, chainInner);
        return (
          <Box key={r.source}>
            <Text color={active ? colors.accent : colors.faint} bold={active}>
              {active ? icons.focusBar : " "}{" "}
            </Text>
            <Text color={active ? colors.bright : colors.text} bold={active}>
              {truncateCells(r.source, aliasWidth).padEnd(aliasWidth)}{" "}
            </Text>
            <Text color={statusColor(r.status)}>
              {SOURCE_STATUS_LABEL[r.status].padEnd(statusWidth)}{" "}
            </Text>
            <Text color={colors.mute}>{chainEdge(active, offset > 0, "‹")}</Text>
            <Text color={colors.text}>{shown}</Text>
            <Text color={colors.mute}>
              {chainEdge(active, offset + chainInner < selectedChainCells.length, "›")}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  if (confirm) return <ConfirmProdFrame range={range} rows={rows} />;

  return (
    <Box flexDirection="column">
      <SectionHead
        label={`Git flow · ${ACTION_LABEL[action]}`}
        {...spreadHint(range ? `fuentes ${range}` : undefined)}
        rightAction="↑↓ ←→ · ⏎ detalle · r re-run · esc back"
      />
      <Box marginLeft={ROWS_INDENT} marginTop={1}>
        <Text color={tone} bold>
          {statusGlyph(result.status)}{" "}
        </Text>
        <Text color={tone}>{summary}</Text>
      </Box>
      {result.error && sources.length === 0 ? (
        <Box marginLeft={ROWS_INDENT} marginTop={1}>
          <Text color={colors.err}>{result.error}</Text>
        </Box>
      ) : null}
      {rows}
    </Box>
  );
}

/**
 * The source's whole ordered chain as ONE line:
 * `✓ merge prod→work → ✓ push work`.
 *
 * `GitFlowStep.step` is the canonical label of the operation and its branches —
 * the git planner owns it — so it is rendered verbatim: re-parsing it here would
 * duplicate that planner and drift from it. The per-step state travels in the
 * glyph, never in the color alone, which is also why the chain renders as a
 * single Text (the offset slices one string, not a row of children).
 *
 * A source with no steps failed a precondition: its chain IS the reason, the
 * only thing it has to show.
 */
function chainOf(result: GitFlowSourceResult): string {
  if (result.steps.length === 0) return result.error ?? "sin pasos";
  return result.steps
    .map((s) => `${stepGlyph(s.status)} ${s.step}${s.detail ? ` · ${s.detail}` : ""}`)
    .join(` ${icons.arrow} `);
}

/** `confirm-prod`'s frame around the preview rows: the warning above, the keys below. */
function ConfirmProdFrame({ range, rows }: { range: string | undefined; rows: ReactNode }) {
  return (
    <Box flexDirection="column">
      <SectionHead
        label="Enviar a PROD"
        {...spreadHint(range ? `fuentes ${range}` : undefined)}
        rightAction="↑↓ ←→ · ⏎ detalle"
      />
      <Box marginLeft={ROWS_INDENT} marginTop={1}>
        <Text color={colors.warn}>Se publicará en la rama de PROD de cada fuente listada.</Text>
      </Box>
      {rows}
      <Box marginLeft={ROWS_INDENT} marginTop={1}>
        <Text color={colors.faint}>y publicar · n/esc cancelar</Text>
      </Box>
    </Box>
  );
}

/** A preview has no state to show; a run's chain carries one glyph per step. */
function chainRendererFor(confirming: boolean): (result: GitFlowSourceResult) => string {
  return confirming ? previewChainOf : chainOf;
}

function reservedRowsFor(confirming: boolean): number {
  return RESULT_LIST_RESERVED_ROWS + (confirming ? CONFIRM_FOOTER_ROWS : 0);
}

/**
 * The key that leaves the list, and what it does: `y`/`n`/`esc` in
 * `confirm-prod`, `esc`/`r` in `result`. Undefined for every other key.
 */
function leavingKey(
  input: string,
  key: { escape?: boolean },
  confirm: FlowConfirm | undefined,
  onBack: (() => void) | undefined,
  onRerun: (() => void) | undefined,
): (() => void) | undefined {
  if (confirm) {
    if (input === "y" || input === "Y") return confirm.onPublish;
    if (key.escape || input === "n" || input === "N") return confirm.onCancel;
    return undefined;
  }
  if (key.escape) return onBack ?? (() => {});
  if (input === "r") return onRerun ?? (() => {});
  return undefined;
}

/**
 * The preview's chain: what would run, with the real branch names, and no state
 * glyph — nothing ran, so there is no state to show.
 */
function previewChainOf(result: GitFlowSourceResult): string {
  if (result.steps.length === 0) return result.error ?? "sin pasos";
  return result.steps.map((s) => s.preview ?? s.step).join(` ${icons.arrow} `);
}

/**
 * The conflict/error detail as lines already hard-wrapped to `width`, so one
 * line is exactly one rendered row: the vertical window counts rows, and
 * letting Ink wrap would make a long path cost two rows nobody reserved.
 * Truncating is not an option either — this view exists to show the paused
 * branch, EVERY conflicted file and the COMPLETE error message.
 */
function detailLines(result: GitFlowSourceResult, width: number): string[] {
  const raw: string[] = [];
  const failed = result.steps.find((s) => s.status === "conflict");
  if (failed) raw.push(`paso: ${failed.step}${failed.detail ? ` · ${failed.detail}` : ""}`);
  if (result.paused_at) {
    raw.push(`pausado en: ${result.paused_at}`);
    raw.push(`traído por: ${result.merge_origin ?? "git no sabe nombrar la rama que lo trajo"}`);
  }
  const files = result.conflicted_files ?? [];
  if (files.length > 0) {
    raw.push(`archivos en conflicto (${files.length}):`);
    for (const f of files) raw.push(`  ${icons.bullet} ${f}`);
  }
  if (result.error) raw.push(`error: ${result.error}`);
  if (result.status === "conflict") {
    raw.push("resolvé los conflictos, commiteá, volvé con esc y ejecutá r para continuar");
  }
  return raw.flatMap((line) => wrapCells(line, width));
}

/**
 * `hint` only when there is one: under `exactOptionalPropertyTypes` an explicit
 * `undefined` is not the same as an absent prop (same idiom as the SOURCES head).
 */
function spreadHint(hint: string | undefined): { hint?: string } {
  return hint ? { hint } : {};
}

/** Hard-wrap into `width`-cell chunks. Measures code points, like truncateCells. */
function wrapCells(s: string, width: number): string[] {
  const cells = [...s];
  if (cells.length <= width) return [s];
  const out: string[] = [];
  for (let i = 0; i < cells.length; i += width) out.push(cells.slice(i, i + width).join(""));
  return out;
}

function statusColor(status: GitFlowSourceResult["status"]): string {
  if (status === "ok") return colors.ok;
  if (status === "conflict") return colors.warn;
  return colors.err;
}

function statusGlyph(status: GitFlowSourceResult["status"]): string {
  if (status === "ok") return icons.check;
  if (status === "conflict") return icons.pending;
  return icons.cross;
}

function stepGlyph(status: GitFlowSourceResult["steps"][number]["status"]): string {
  if (status === "ok") return icons.check;
  if (status === "conflict") return icons.pending;
  return icons.bullet;
}

function handleFlowDetailKey(
  key: Key,
  length: number,
  setDetailOpen: Dispatch<SetStateAction<boolean>>,
  setDetailCursor: Dispatch<SetStateAction<number>>,
) {
  // The detail scrolls its own lines and returns; it never changes source,
  // so selection and both offsets survive the round trip untouched.
  if (key.escape) return setDetailOpen(false);
  if (key.upArrow) return setDetailCursor((c) => Math.max(0, c - 1));
  if (key.downArrow) {
    return setDetailCursor((c) => Math.min(Math.max(0, length - 1), c + 1));
  }
  return;
}

function chainEdge(active: boolean, overflow: boolean, glyph: string): string {
  return active && overflow ? glyph : " ";
}
