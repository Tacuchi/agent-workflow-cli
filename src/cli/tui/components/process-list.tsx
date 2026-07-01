import { Box, Text } from "ink";
import type { ProcessRecord, ProcessState } from "../../../application/process-registry-service.js";
import { colors, icons } from "../theme.js";
import { ListRow } from "./list-row.js";
import { SectionHead } from "./section-head.js";

export interface ProcessListProps {
  processes: ProcessRecord[];
  /** Index of the focused process row (only meaningful when `focused`). */
  cursor: number;
  /** Whether the process region currently has navigation focus. */
  focused: boolean;
  widthHint: number;
}

const STATE_TONE: Record<ProcessState, "ok" | "warn" | "dim"> = {
  running: "ok",
  stopped: "warn",
  exited: "dim",
};

const STATE_LABEL: Record<ProcessState, string> = {
  running: "running",
  stopped: "stopped",
  exited: "exited",
};

/** Clock portion (HH:MM) of an ISO timestamp; "?" when unparseable. */
function startedClock(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? "?";
}

/**
 * "Procesos lanzados" — the launched source processes (in a visible terminal, or
 * background when no terminal was available), with their reconciled state.
 * Navigable in process mode.
 */
export function ProcessList({ processes, cursor, focused, widthHint }: ProcessListProps) {
  const rightAction =
    processes.length > 0
      ? focused
        ? "↑↓ select · x stop · r relaunch · o log · esc"
        : "p manage"
      : undefined;
  return (
    <>
      <SectionHead
        label="Procesos lanzados"
        count={processes.length}
        marginTop={1}
        {...(rightAction ? { rightAction } : {})}
      />
      <Box marginLeft={2} flexDirection="column">
        {processes.length === 0 ? (
          <Text color={colors.faint}>(sin procesos — lanzá un source con ⏎ → Lanzar en local)</Text>
        ) : (
          processes.map((p, i) => (
            <ProcessRow
              key={p.id}
              record={p}
              active={focused && i === cursor}
              widthHint={widthHint}
            />
          ))
        )}
      </Box>
    </>
  );
}

function ProcessRow({
  record,
  active,
  widthHint,
}: {
  record: ProcessRecord;
  active: boolean;
  widthHint: number;
}) {
  const profile = record.profile ?? "default";
  const mode =
    record.launchMode === "terminal"
      ? " · terminal"
      : record.launchMode === "background"
        ? " · bg"
        : "";
  return (
    <ListRow
      icon={icons.diamond}
      title={`${record.sourceAlias} · ${profile}`}
      subtitle={`PID ${record.pid} · desde ${startedClock(record.startedAt)}${mode}`}
      meta={[{ label: STATE_LABEL[record.state], tone: STATE_TONE[record.state] }]}
      state={{ label: record.command, tone: "dim" }}
      active={active}
      widthHint={widthHint}
    />
  );
}
