import { useInput } from "ink";
import { type Dispatch, type SetStateAction, useState } from "react";

/** Which key map is live; "off" while a wizard/busy overlay owns the input. */
export type ListDetailPhase = "list" | "detail" | "confirm" | "off";

export interface ListDetailKeysOptions {
  isActive: boolean;
  phase: ListDetailPhase;
  listLen: number;
  actionsLen: number;
  /** 'a' in list phase (open the tab's add wizard). */
  onAdd: () => void;
  /** ⏎ in list phase on a real row (action cursor already reset to 0). */
  onOpenDetail: () => void;
  /** esc in detail phase. */
  onCloseDetail: () => void;
  /** ⏎ in detail phase — the tab resolves `index` against its own actions. */
  onRunAction: (index: number) => void;
  /** y (`true`) · n/esc (`false`) in confirm phase. */
  onConfirm: (yes: boolean) => void;
}

/**
 * Shared list → detail → confirm key machinery for the list-based tabs
 * (MCP, Skills): clamped ↑↓ cursors, ⏎/esc routing and y/n confirmation.
 * Owns both cursors; `setCursor` is exposed because refreshes re-derive or
 * clamp the selection outside the hook.
 */
export function useListDetailKeys(opts: ListDetailKeysOptions): {
  cursor: number;
  setCursor: Dispatch<SetStateAction<number>>;
  actionCursor: number;
} {
  const { isActive, phase, listLen, actionsLen } = opts;
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (phase === "list") {
        if (input === "a" || input === "A") return opts.onAdd();
        if (key.upArrow) return void setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) {
          return void setCursor((c) => (listLen === 0 ? 0 : Math.min(listLen - 1, c + 1)));
        }
        if (key.return && listLen > 0) {
          setActionCursor(0);
          opts.onOpenDetail();
        }
        return;
      }
      if (phase === "detail") {
        // Mirrors the tabs' `!current` guard: the cursor is clamped to the
        // list, so no current row ⇔ empty list.
        if (listLen === 0) return;
        if (key.upArrow) return void setActionCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) {
          return void setActionCursor((c) => Math.min(Math.max(0, actionsLen - 1), c + 1));
        }
        if (key.escape) return opts.onCloseDetail();
        if (key.return) opts.onRunAction(actionCursor);
        return;
      }
      if (phase === "confirm") {
        if (input === "y" || input === "Y") opts.onConfirm(true);
        else if (key.escape || input === "n" || input === "N") opts.onConfirm(false);
      }
    },
    { isActive },
  );

  return { cursor, setCursor, actionCursor };
}
