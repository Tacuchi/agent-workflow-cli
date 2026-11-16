import { Box, type Key, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type {
  GitFlowAction,
  GitFlowResult,
  GitFlowSourceResult,
} from "../../../application/git-flow-service.js";
import { rowWidth, truncateCells } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { moveWithArrows, useListWindow, windowRangeHint } from "../use-list-window.js";
import { useTerminalSize } from "../use-terminal-size.js";
import { SectionHead } from "./section-head.js";

/**
 * A git-flow run, or the PROD preview, as exactly ONE non-wrapping row per
 * source carrying its ordered step chain. The list is windowed (↑↓) so the
 * last sources stay reachable inside the clipped frame; ⏎ on a conflict or an
 * error opens its full detail, which is where nothing is ever truncated.
 */

export const ACTION_LABEL: Record<GitFlowAction, string> = {
  sync: "Alinear con PROD",
  "to-dev": "Enviar a desarrollo",
  "to-qa": "Enviar a QA",
  "to-prod": "Enviar a PROD",
};

/** marginLeft of the rows container, passed to {@link rowWidth} as `indent`. */
const ROWS_INDENT = 2;

/** Cap on the alias column, so one long alias never starves every other chain. */
const ALIAS_MAX_CELLS = 24;

/**
 * `confirm-prod`: the same list, fed by the service's preview instead of a
 * run. The screen decides what `y` does; this view only reports the key.
 */
export interface FlowConfirm {
  onPublish: () => void;
  onCancel: () => void;
}

export function FlowResultView({
  action,
  result,
  reservedRows,
  isActive = false,
  onBack,
  confirm,
}: {
  action: GitFlowAction;
  result: GitFlowResult;
  /** Terminal rows the screen spends around this view. */
  reservedRows: number;
  isActive?: boolean;
  /** Present → render `confirm-prod` over `result` as a preview. */
  confirm?: FlowConfirm;
  /** `esc` from the list: back to the sources. */
  onBack?: () => void;
}) {
  const sources = result.results;
  const [cursor, setCursor] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailCursor, setDetailCursor] = useState(0);

  // A new result starts over: a cursor carried across runs would point at
  // another source's row. Adjusted during render so no stale frame commits.
  const [seenResult, setSeenResult] = useState(result);
  if (seenResult !== result) {
    setSeenResult(result);
    setCursor(0);
    setDetailOpen(false);
    setDetailCursor(0);
  }

  const { cols } = useTerminalSize();
  const rowW = rowWidth(cols, ROWS_INDENT);
  const aliasWidth = Math.min(
    ALIAS_MAX_CELLS,
    Math.max(1, ...sources.map((r) => [...r.source].length)),
  );
  // marker (2) + alias + space + status (8) + space
  const chainWidth = Math.max(1, rowW - aliasWidth - 12);
  const chainOf = confirm ? previewChainOf : runChainOf;

  const selected = sources[cursor];
  const failed = sources.some((r) => r.status !== "ok");
  const detailRows = useMemo(() => (selected ? detailLines(selected, rowW) : []), [selected, rowW]);
  const win = useListWindow(sources.length, cursor, reservedRows);
  const detailWin = useListWindow(detailRows.length, detailCursor, reservedRows);

  const onListKey = (input: string, key: Key) => {
    const leave = leavingKey(input, key, confirm, onBack);
    if (leave) return leave();
    if (moveWithArrows(key, sources.length, setCursor)) return;
    // Only a conflict or an error has more than its row already shows.
    if (key.return && selected && selected.status !== "ok") {
      setDetailCursor(0);
      setDetailOpen(true);
    }
  };

  useInput(
    (input, key) => {
      if (!detailOpen) return onListKey(input, key);
      if (key.escape) return setDetailOpen(false);
      moveWithArrows(key, detailRows.length, setDetailCursor);
    },
    { isActive },
  );

  if (detailOpen && selected) {
    return (
      <Box flexDirection="column">
        <SectionHead
          label={`${ACTION_LABEL[action]} · ${selected.source}`}
          {...spreadHint(windowRangeHint(detailWin, detailRows.length))}
          rightAction="↑↓ mover · esc volver"
        />
        <Box marginLeft={ROWS_INDENT} flexDirection="column" marginTop={1}>
          <Text color={statusColor(selected.status)} bold>
            {statusGlyph(selected.status)} {selected.status}
          </Text>
          {detailRows.slice(detailWin.start, detailWin.start + detailWin.visible).map((line, i) => (
            <Text key={`${detailWin.start + i}-${line}`} color={colors.text}>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  const detailKey = failed ? " · ⏎ detalle" : "";
  const range = windowRangeHint(win, sources.length);
  const rows = (
    <Box marginLeft={ROWS_INDENT} flexDirection="column">
      {sources.slice(win.start, win.start + win.visible).map((r, i) => {
        const active = win.start + i === cursor;
        return (
          <Box key={r.source}>
            <Text color={active ? colors.accent : colors.faint} bold={active}>
              {active ? icons.focusBar : " "}{" "}
            </Text>
            <Text color={active ? colors.bright : colors.text} bold={active}>
              {truncateCells(r.source, aliasWidth).padEnd(aliasWidth)}{" "}
            </Text>
            <Text color={statusColor(r.status)}>{r.status.padEnd(8)} </Text>
            <Text color={colors.text}>{truncateCells(chainOf(r), chainWidth)}</Text>
          </Box>
        );
      })}
    </Box>
  );

  if (confirm) {
    return (
      <Box flexDirection="column">
        <SectionHead
          label={ACTION_LABEL["to-prod"]}
          {...spreadHint(range ? `fuentes ${range}` : undefined)}
          rightAction={`↑↓ mover${detailKey} · y publicar · n/esc cancelar`}
        />
        <Box marginLeft={ROWS_INDENT} marginY={1}>
          <Text color={colors.warn}>Se publicará en la rama de PROD de cada fuente listada.</Text>
        </Box>
        {rows}
      </Box>
    );
  }

  const tone = statusColor(result.status);
  const summary =
    result.status === "ok"
      ? "completado"
      : result.status === "conflict"
        ? "en pausa por un conflicto"
        : (result.error ?? "error");
  return (
    <Box flexDirection="column">
      <SectionHead
        label={ACTION_LABEL[action]}
        {...spreadHint(range ? `fuentes ${range}` : undefined)}
        rightAction={`↑↓ mover${detailKey} · esc volver · q salir`}
      />
      <Box marginLeft={ROWS_INDENT} marginY={1}>
        <Text color={tone} bold>
          {statusGlyph(result.status)} {summary}
        </Text>
      </Box>
      {result.error && sources.length === 0 ? (
        <Box marginLeft={ROWS_INDENT}>
          <Text color={colors.err}>{result.error}</Text>
        </Box>
      ) : null}
      {rows}
    </Box>
  );
}

/** What leaves the list: `y`/`n`/`esc` over a preview, `esc` over a result. */
function leavingKey(
  input: string,
  key: Key,
  confirm: FlowConfirm | undefined,
  onBack: (() => void) | undefined,
): (() => void) | undefined {
  const answer = input.toLowerCase();
  if (!confirm) return key.escape ? onBack : undefined;
  if (answer === "y") return confirm.onPublish;
  return key.escape || answer === "n" ? confirm.onCancel : undefined;
}

/**
 * The source's ordered chain as ONE line: `✓ merge prod→work → ✓ push work`.
 * `GitFlowStep.step` is the planner's own label, rendered verbatim. A source
 * with no steps failed a precondition: its chain IS the reason.
 */
function runChainOf(result: GitFlowSourceResult): string {
  if (result.steps.length === 0) return result.error ?? "sin pasos";
  return result.steps
    .map((s) => `${stepGlyph(s.status)} ${s.step}${s.detail ? ` · ${s.detail}` : ""}`)
    .join(` ${icons.arrow} `);
}

/** The preview's chain: what would run, with the real branch names, and no state. */
function previewChainOf(result: GitFlowSourceResult): string {
  if (result.steps.length === 0) return result.error ?? "sin pasos";
  return result.steps.map((s) => s.preview ?? s.step).join(` ${icons.arrow} `);
}

/**
 * The conflict/error detail hard-wrapped to `width`, so one line is one row
 * for the window: it shows the paused branch, EVERY conflicted file and the
 * COMPLETE error message.
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
    raw.push("resolvé los conflictos, commiteá y volvé a ejecutar la acción");
  }
  return raw.flatMap((line) => wrapCells(line, width));
}

/** `hint` only when there is one (`exactOptionalPropertyTypes`). */
function spreadHint(hint: string | undefined): { hint?: string } {
  return hint ? { hint } : {};
}

function wrapCells(s: string, width: number): string[] {
  const cells = [...s];
  if (cells.length <= width) return [s];
  const out: string[] = [];
  for (let i = 0; i < cells.length; i += width) out.push(cells.slice(i, i + width).join(""));
  return out;
}

function statusColor(status: GitFlowResult["status"]): string {
  if (status === "ok") return colors.ok;
  if (status === "conflict") return colors.warn;
  return colors.err;
}

function statusGlyph(status: GitFlowResult["status"]): string {
  if (status === "ok") return icons.check;
  if (status === "conflict") return icons.pending;
  return icons.cross;
}

function stepGlyph(status: GitFlowSourceResult["steps"][number]["status"]): string {
  if (status === "ok") return icons.check;
  if (status === "conflict") return icons.pending;
  return icons.bullet;
}
