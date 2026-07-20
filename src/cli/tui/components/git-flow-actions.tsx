import { Box, Text } from "ink";
import type {
  GitFlowAction,
  GitFlowResult,
  GitFlowSourceResult,
} from "../../../application/git-flow-service.js";
import { colors, icons } from "../theme.js";
import { SectionHead } from "./section-head.js";

/**
 * Read-only render of a git-flow run for the Project tab: overall status +
 * per-source step sequence and, on a merge conflict, the paused branch +
 * conflicted files + a "resolve and re-run" hint (re-running the same action
 * resumes from git state).
 */

const ACTION_LABEL: Record<GitFlowAction, string> = {
  sync: "Actualizar",
  "to-dev": "→ Dev",
  "to-qa": "→ QA",
  "to-prod": "→ Prod",
};

export function FlowResultView({
  action,
  result,
}: {
  action: GitFlowAction;
  result: GitFlowResult;
}) {
  const tone =
    result.status === "ok" ? colors.ok : result.status === "conflict" ? colors.warn : colors.err;
  const summary =
    result.status === "ok"
      ? "completed"
      : result.status === "conflict"
        ? "paused on conflict"
        : (result.error ?? "error");
  return (
    <Box flexDirection="column">
      <SectionHead
        label={`Git flow · ${ACTION_LABEL[action]}`}
        rightAction="⏎/r re-run · esc back"
      />
      <Box marginLeft={2} marginTop={1}>
        <Text color={tone} bold>
          {result.status === "ok"
            ? icons.check
            : result.status === "conflict"
              ? icons.pending
              : icons.cross}{" "}
        </Text>
        <Text color={tone}>{summary}</Text>
      </Box>
      {result.error && result.results.length === 0 ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color={colors.err}>{result.error}</Text>
        </Box>
      ) : null}
      {result.results.map((r) => (
        <SourceResultView key={r.source} result={r} />
      ))}
    </Box>
  );
}

function SourceResultView({ result }: { result: GitFlowSourceResult }) {
  return (
    <Box marginLeft={2} marginTop={1} flexDirection="column">
      <Box>
        <Text color={colors.accent}>{icons.diamond} </Text>
        <Text color={colors.bright} bold>
          {result.source}
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {result.steps.map((s, idx) => (
          <Box key={`${idx}-${s.step}`}>
            <Text color={stepColor(s.status)}>{stepGlyph(s.status)} </Text>
            <Text color={s.status === "ok" ? colors.text : colors.dim}>{s.step}</Text>
            {s.detail ? <Text color={colors.faint}> · {s.detail}</Text> : null}
          </Box>
        ))}
      </Box>
      {result.status === "conflict" ? (
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text color={colors.warn}>
            {icons.pending} merge conflict on {result.paused_at}
          </Text>
          <Box marginLeft={2} flexDirection="column">
            {(result.conflicted_files ?? []).map((f) => (
              <Text key={f} color={colors.dim}>
                {icons.bullet} {f}
              </Text>
            ))}
          </Box>
          <Text color={colors.mute}>
            resolve the conflicts, commit, then re-run (⏎) to continue
          </Text>
        </Box>
      ) : null}
      {result.status === "error" && result.error ? (
        <Box marginLeft={2}>
          <Text color={colors.err}>{result.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function stepColor(status: GitFlowSourceResult["steps"][number]["status"]): string {
  if (status === "ok") return colors.ok;
  if (status === "conflict") return colors.warn;
  return colors.faint;
}

function stepGlyph(status: GitFlowSourceResult["steps"][number]["status"]): string {
  if (status === "ok") return icons.check;
  if (status === "conflict") return icons.pending;
  return icons.bullet;
}
