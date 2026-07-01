import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { humanizeRelativeEs } from "../../../application/humanize-es.js";
import type { LogEntry } from "../data/logs.js";
import { colors } from "../theme.js";
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
  /** Max rows shown before a "+N más" hint. */
  cap?: number;
}

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
  const shown = logs.slice(0, cap);
  const extra = logs.length - shown.length;

  return (
    <Box flexDirection="column">
      <SectionHead
        label="Logs"
        count={logs.length}
        hint="global · más nuevo primero"
        marginTop={1}
      />
      <Box marginLeft={2} flexDirection="column">
        {logs.length === 0 ? (
          <Text color={colors.faint}> (sin logs todavía — el CLI aún no registró actividad)</Text>
        ) : (
          shown.map((entry, i) => {
            const active = focused && i === clampedSel;
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
        {extra > 0 ? <Text color={colors.faint}> +{extra} más</Text> : null}
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
