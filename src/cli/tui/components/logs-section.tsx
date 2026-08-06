import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { humanizeRelativeEs } from "../../../application/humanize-es.js";
import type { LogEntry } from "../data/logs.js";
import { useInputLock } from "../input-lock.js";
import { useNotificationItems } from "../notification-center.js";
import { colors } from "../theme.js";
import { useListWindow, windowRangeHint } from "../use-list-window.js";
import { notificationStackRows } from "./notification-stack.js";
import { SectionHead } from "./section-head.js";

export interface LogsSectionProps {
  logs: LogEntry[];
  /** When true, this section owns the keyboard (↑↓/⏎/a/esc). */
  focused: boolean;
  /** Clock for relative ages; defaults to now. */
  now?: Date;
  /** Last app used with "open with…", prefilled into the prompt. */
  lastApp?: string;
  /** Open the entry with the OS default text editor. */
  onOpen: (entry: LogEntry) => void;
  /** Open the entry with a specific app. */
  onOpenWith: (entry: LogEntry, app: string) => void;
  /** Leave the section (return focus to the tiles strip). */
  onExit: () => void;
  /** Design cap on visible rows; the window may show fewer on short terminals. */
  cap?: number;
}

// Terminal rows eaten around the logs list when it lives in the Status tab —
// the window hook subtracts them so the selected row never clips. Accounting:
// - app shell: ScreenFrame border+paddingY (4) + HomeHeader (3) + TabBar (3)
//   + tab content box border+paddingY (4) + HomeFooter (2) = 16
// - StatusTab above: PageHead (2) + tiles strip (3 + 1 margin) + divider (1)
//   + SectionHead "Skill coverage" (1 + 1 margin) + progress line (1)
//   + host chips row (2 — flexWrap wraps on narrow terminals) = 12
// - this section: SectionHead "Logs" (1 + 1 margin) + hints / app-input line
//   (1 + 1 margin) = 4
// - 1 slack: better one row short than a clipped selected row.
// Plus, added per render at the call site: the NotificationStack height
// (notificationStackRows — 0 unless a banner is visible).
const LOGS_LIST_RESERVED_ROWS = 33;

/** One row per daily log; `~/…` for brevity, newest first (already sorted). */
export function LogsSection({
  logs,
  focused,
  now,
  lastApp,
  onOpen,
  onOpenWith,
  onExit,
  cap = 8,
}: LogsSectionProps) {
  const [sel, setSel] = useState(0);
  // null = list mode; string = typing an app name for "open with…".
  const [appInput, setAppInput] = useState<string | null>(null);
  const { lock, unlock } = useInputLock();

  // While typing an app name, mute the global keys (q/r/1-6/i) or a typed
  // letter would quit, remount the tab or switch tabs — config-tab's pattern.
  useEffect(() => {
    if (appInput !== null) lock();
    else unlock();
  }, [appInput, lock, unlock]);

  useEffect(() => () => unlock(), [unlock]);

  const clampedSel = Math.min(sel, Math.max(0, logs.length - 1));

  useInput(
    (input, key) => {
      if (!focused) return;
      if (appInput !== null) {
        if (key.return) {
          const entry = logs[clampedSel];
          const app = appInput.trim();
          if (entry && app) onOpenWith(entry, app);
          setAppInput(null);
          return;
        }
        if (key.escape) {
          setAppInput(null);
          return;
        }
        if (key.backspace || key.delete) {
          setAppInput((v) => (v ?? "").slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setAppInput((v) => (v ?? "") + input);
        }
        return;
      }
      if (key.upArrow) {
        setSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSel((s) => Math.min(logs.length - 1, s + 1));
        return;
      }
      if (key.return) {
        const entry = logs[clampedSel];
        if (entry) onOpen(entry);
        return;
      }
      if (input === "a") {
        if (logs[clampedSel]) setAppInput(lastApp ?? "");
        return;
      }
      if (key.escape) onExit();
    },
    { isActive: focused },
  );

  const clock = now ?? new Date();
  // Windowed view: `cap` stays the design cap, but on a short terminal the
  // window shrinks further and FOLLOWS `sel` — the selected row is always
  // rendered, so ⏎ can never open an off-screen entry.
  const notifItems = useNotificationItems();
  const win = useListWindow(
    logs.length,
    clampedSel,
    LOGS_LIST_RESERVED_ROWS + notificationStackRows(notifItems),
    cap,
  );
  const winEnd = win.start + win.visible;
  const shown = logs.slice(win.start, winEnd);

  return (
    <Box flexDirection="column">
      <SectionHead
        label="Logs"
        count={logs.length}
        hint={windowRangeHint(win, logs.length) ?? "global · más nuevo primero"}
        marginTop={1}
      />
      <Box marginLeft={2} flexDirection="column">
        {logs.length === 0 ? (
          <Text color={colors.faint}> (sin logs todavía — el CLI aún no registró actividad)</Text>
        ) : (
          shown.map((entry, i) => {
            const active = focused && win.start + i === clampedSel;
            return (
              <Box key={entry.path}>
                <Text color={active ? colors.accent : colors.dim}>{active ? "› " : "  "}</Text>
                <Text color={active ? colors.text : colors.dim}>
                  {entry.date} · {humanizeRelativeEs(entry.mtime, clock)} ·{" "}
                  {formatSize(entry.sizeBytes)}
                </Text>
                <Text color={colors.faint}> {contractHome(entry.path)}</Text>
              </Box>
            );
          })
        )}
        {appInput !== null ? (
          <Box marginTop={1}>
            <Text color={colors.accent}>abrir con: </Text>
            <Text color={colors.text}>{appInput}</Text>
            <Text color={colors.accent}>▏</Text>
            <Text color={colors.faint}> (⏎ abrir · esc cancelar)</Text>
          </Box>
        ) : focused ? (
          <Text color={colors.faint}>↑↓ seleccionar · ⏎ abrir · a abrir con… · esc</Text>
        ) : null}
      </Box>
    </Box>
  );
}

/** Human byte size: B / KB / MB with one decimal above a KB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Contract a leading `/Users/<u>` or `/home/<u>` home dir to `~` for brevity. */
function contractHome(path: string): string {
  return path.replace(/^(\/Users|\/home)\/[^/]+/, "~");
}
