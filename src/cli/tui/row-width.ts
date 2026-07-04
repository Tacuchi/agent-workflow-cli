import { DETAIL_PANEL_ROW_OVERHEAD } from "./components/detail-panel.js";

/**
 * Available width (in cells) for a `ListRow` inside a tab, depending on
 * whether the side detail panel is open and how much the list container
 * indents. Shared by the tabs that list with `ListRow` (Project / MCP /
 * Skills).
 *
 * Horizontal overhead:
 * - ScreenFrame border + paddingX = 6
 * - tab content Box border + paddingX = 6
 * - list paddingRight = 2
 *   → base = 14
 * - `indent`: marginLeft of the rows container (Project uses 2 for SOURCES;
 *   MCP/Skills 0). If not subtracted, the row builds wider than its container
 *   → Yoga wraps it → blank line between rows.
 * - detail panel open: {@link DETAIL_PANEL_ROW_OVERHEAD} (panel + frame + gap).
 */
export function rowWidth(termCols: number | undefined, detailOpen: boolean, indent = 0): number {
  const cols = termCols ?? 100;
  const baseOverhead = 14 + indent;
  const detailOverhead = detailOpen ? DETAIL_PANEL_ROW_OVERHEAD : 0;
  return Math.max(16, cols - baseOverhead - detailOverhead);
}
