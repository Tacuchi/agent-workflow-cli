// Windowed view over a list cursor: which slice of rows fits the terminal and
// how much overflow sits hidden above/below. The app shell clips tall tabs
// (`overflowY="hidden"` in app.tsx + ScreenFrame), so a list that renders all
// its rows lets the cursor walk off-screen — the active row becomes invisible.
// This hook keeps the cursor inside the rendered window:
// render `rows.slice(start, start + visible)` and, when `hiddenAbove` or
// `hiddenBelow` are non-zero, surface the range somewhere in the chrome.
//
// The window only moves when the cursor would leave it (edge scroll), so it
// needs memory; the adjustment runs during render to avoid committing a stale
// frame (React's "adjust state during render" pattern — guarded, no loop).
//
// `rows = 0` (non-TTY: pipes, CI, ink-testing-library) means "no viewport":
// the window covers the whole list, matching the ScreenFrame contract
// (use-terminal-size.ts).

import { useState } from "react";
import { useTerminalSize } from "./use-terminal-size.js";

export interface ListWindow {
  /** First visible row index — render from here. */
  start: number;
  /** How many rows fit. Equals `count` when the height is unknown (non-TTY). */
  visible: number;
  /** Rows hidden above the window (=== start). */
  hiddenAbove: number;
  /** Rows hidden below the window. */
  hiddenBelow: number;
}

export function useListWindow(
  count: number,
  cursor: number,
  /** Rows eaten around the list (app chrome + tab chrome + sections below). */
  reservedRows: number,
  /** Hard cap on `visible` even when the viewport is taller (e.g. logs: 8). */
  maxVisible?: number,
): ListWindow {
  const { rows } = useTerminalSize();
  const available = rows > 0 ? Math.max(1, rows - reservedRows) : count;
  const visible = Math.max(0, Math.min(count, available, maxVisible ?? count));

  const [rawStart, setRawStart] = useState(0);
  const maxStart = Math.max(0, count - visible);
  let start = Math.min(rawStart, maxStart);
  if (cursor < start) start = cursor;
  else if (cursor >= start + visible) start = cursor - visible + 1;
  start = Math.max(0, Math.min(start, maxStart));
  if (start !== rawStart) setRawStart(start);

  return {
    start,
    visible,
    hiddenAbove: start,
    hiddenBelow: count - (start + visible),
  };
}

/**
 * Visible-range label for chrome (typically the SectionHead `hint` slot, so it
 * spends no extra terminal row): `` `${start + 1}–${end} de ${count}` `` when
 * the window hides rows above or below, `undefined` when the whole list fits.
 */
export function windowRangeHint(win: ListWindow, count: number): string | undefined {
  if (win.hiddenAbove === 0 && win.hiddenBelow === 0) return undefined;
  return `${win.start + 1}–${Math.min(count, win.start + win.visible)} de ${count}`;
}
