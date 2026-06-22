import { DETAIL_PANEL_ROW_OVERHEAD } from "./components/detail-panel.js";

/**
 * Ancho disponible (en celdas) para un `ListRow` dentro de un tab, según si el
 * detail panel lateral está abierto y cuánto indenta el contenedor de la lista.
 *
 * Helper compartido por los tabs que listan con `ListRow` (Project / MCP / Skills),
 * antes triplicado como `computeRowWidth` en cada uno.
 *
 * Overhead horizontal:
 * - ScreenFrame border + paddingX = 6
 * - tab content Box border + paddingX = 6
 * - list paddingRight = 2
 *   → base = 14
 * - `indent`: marginLeft del contenedor de rows (Project usa 2 para SOURCES; MCP/Skills 0).
 *   Si no se descuenta, el row se construye más ancho que su contenedor → Yoga lo
 *   envuelve → línea en blanco entre filas.
 * - detail panel abierto: {@link DETAIL_PANEL_ROW_OVERHEAD} (panel + marco + gap).
 */
export function rowWidth(termCols: number | undefined, detailOpen: boolean, indent = 0): number {
  const cols = termCols ?? 100;
  const baseOverhead = 14 + indent;
  const detailOverhead = detailOpen ? DETAIL_PANEL_ROW_OVERHEAD : 0;
  return Math.max(16, cols - baseOverhead - detailOverhead);
}
