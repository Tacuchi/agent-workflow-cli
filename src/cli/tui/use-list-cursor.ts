// Cursor de lista clampeado con navegación ↑↓. Extraído del patrón repetido en
// los tabs (cursor + up/down + clamp). Reutilizable por cualquier lista del TUI.

import { useState } from "react";

export interface ListCursor {
  /** Índice activo, siempre en [0, count-1] (0 si count=0). */
  cursor: number;
  moveUp: () => void;
  moveDown: () => void;
}

export function useListCursor(count: number): ListCursor {
  const [raw, setRaw] = useState(0);
  const cursor = count > 0 ? Math.min(raw, count - 1) : 0;
  return {
    cursor,
    moveUp: () => setRaw(Math.max(0, cursor - 1)),
    moveDown: () => setRaw(Math.min(count - 1, cursor + 1)),
  };
}
