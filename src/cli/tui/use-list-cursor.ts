// Clamped list cursor with ↑↓ navigation (cursor + up/down + clamp), reusable
// by any TUI list.

import { useState } from "react";

export interface ListCursor {
  /** Active index, always within [0, count-1] (0 when count=0). */
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
