/**
 * Available width (in cells) for a row inside the screen frame: its border
 * and paddingX take 6, plus 2 of slack and the rows container's own
 * `indent`. A row built wider than its container wraps in Yoga, and a
 * one-row-per-item list would then lose its rows.
 */
export function rowWidth(termCols: number | undefined, indent = 0): number {
  return Math.max(16, (termCols ?? 100) - 8 - indent);
}

/**
 * Truncates `s` to at most `max` cells, appending `…` when cut. Measures in
 * code points (matching the row layout math) while slicing in code units.
 */
export function truncateCells(s: string, max: number): string {
  if ([...s].length <= max) return s;
  return max <= 1 ? "" : `${s.slice(0, max - 1)}…`;
}
