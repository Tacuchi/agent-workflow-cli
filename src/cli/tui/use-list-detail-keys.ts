import { type Key, useInput } from "ink";
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
  const { isActive, phase } = opts;
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (phase === "list") return handleListKey(input, key, opts, setCursor, setActionCursor);
      if (phase === "detail") return handleDetailKey(key, opts, actionCursor, setActionCursor);
      if (phase === "confirm") handleConfirmKey(input, key, opts);
    },
    { isActive },
  );

  return { cursor, setCursor, actionCursor };
}

function handleListKey(
  input: string,
  key: Key,
  opts: ListDetailKeysOptions,
  setCursor: Dispatch<SetStateAction<number>>,
  setActionCursor: Dispatch<SetStateAction<number>>,
) {
  const { listLen } = opts;
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

function handleDetailKey(
  key: Key,
  opts: ListDetailKeysOptions,
  actionCursor: number,
  setActionCursor: Dispatch<SetStateAction<number>>,
) {
  const { listLen, actionsLen } = opts;
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

function handleConfirmKey(input: string, key: Key, opts: ListDetailKeysOptions) {
  if (input === "y" || input === "Y") opts.onConfirm(true);
  else if (key.escape || input === "n" || input === "N") opts.onConfirm(false);
}
