import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import {
  type GitFlowAction,
  type GitFlowInput,
  type GitFlowResult,
  type GitFlowSourceResult,
  runGitFlow,
} from "../../../application/git-flow-service.js";
import type { CliContext } from "../../types.js";
import { colors, icons } from "../theme.js";
import { SectionHead } from "./section-head.js";

/**
 * Per-source git-flow actions affordance for the Project tab.
 *
 * Renders a small target picker (one row per source + an "all sources" row) and
 * dispatches one of the three flows — `sync` (Actualizar), `to-qa` (→ QA),
 * `to-prod` (→ Prod) — against the selected target via {@link runGitFlow}. The
 * run executes real git through `ctx.git`; progress is rendered step-by-step and,
 * on a merge conflict, the paused branch + conflicted files + a "resolve and
 * re-run" hint are shown (re-running the same action resumes from git state).
 *
 * Keys: ↑/↓ move target · a Actualizar · q → QA · p → Prod · esc back.
 */
export interface GitFlowActionsProps {
  ctx: CliContext;
  /** Source aliases declared in the WORKSPACE block. */
  aliases: string[];
  isActive?: boolean;
  onClose: () => void;
}

type Phase =
  | { kind: "pick" }
  | { kind: "running"; action: GitFlowAction; label: string }
  | { kind: "done"; action: GitFlowAction; result: GitFlowResult };

const ACTION_LABEL: Record<GitFlowAction, string> = {
  sync: "Actualizar",
  "to-qa": "→ QA",
  "to-prod": "→ Prod",
};

/** Single-key shortcuts → action. */
const ACTION_KEY: Record<string, GitFlowAction | undefined> = {
  a: "sync",
  q: "to-qa",
  p: "to-prod",
};

/** Subset of ink's Key we read in this component. */
interface GitFlowKey {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
}

export function GitFlowActions({ ctx, aliases, isActive = true, onClose }: GitFlowActionsProps) {
  // Targets: each declared source, then an "all sources" sentinel (index = length).
  const targets = useMemo(() => [...aliases, ALL_TARGET], [aliases]);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });

  const run = useCallback(
    async (action: GitFlowAction) => {
      const selected = targets[cursor] ?? ALL_TARGET;
      const isAll = selected === ALL_TARGET;
      const label = `${ACTION_LABEL[action]} · ${isAll ? "all sources" : selected}`;
      setPhase({ kind: "running", action, label });
      const input: GitFlowInput = isAll ? { action, all: true } : { action, source: selected };
      try {
        const result = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input);
        setPhase({ kind: "done", action, result });
      } catch (err) {
        setPhase({
          kind: "done",
          action,
          result: {
            action,
            dry_run: false,
            status: "error",
            results: [],
            error: (err as Error).message,
          },
        });
      }
    },
    [cursor, ctx, targets],
  );

  const handlePick = useCallback(
    (input: string, key: GitFlowKey) => {
      if (key.upArrow) {
        setCursor((c) => (c - 1 + targets.length) % targets.length);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % targets.length);
        return;
      }
      const action = ACTION_KEY[input];
      if (action) void run(action);
    },
    [run, targets.length],
  );

  const handleDone = useCallback(
    (input: string, key: GitFlowKey, action: GitFlowAction) => {
      // ⏎ / r re-runs the same action (resume on conflict); any nav key returns.
      if (key.return || input === "r") {
        void run(action);
        return;
      }
      if (key.upArrow || key.downArrow) setPhase({ kind: "pick" });
    },
    [run],
  );

  useInput(
    (input, key) => {
      if (phase.kind === "running") return;
      if (key.escape) {
        if (phase.kind === "done") setPhase({ kind: "pick" });
        else onClose();
        return;
      }
      if (phase.kind === "done") handleDone(input, key, phase.action);
      else handlePick(input, key);
    },
    { isActive },
  );

  if (phase.kind === "running") {
    return (
      <Box flexDirection="column">
        <SectionHead label="Git flow" hint={phase.label} />
        <Box marginLeft={2} marginTop={1}>
          <Text color={colors.warn}>{icons.spinner} ejecutando…</Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "done") {
    return <FlowResultView action={phase.action} result={phase.result} />;
  }

  return (
    <Box flexDirection="column">
      <SectionHead
        label="Git flow"
        hint="pick target"
        rightAction="↑↓ target · a Actualizar · q → QA · p → Prod · esc back"
      />
      <Box marginLeft={2} marginTop={1} flexDirection="column">
        {targets.map((t, idx) => {
          const focused = idx === cursor;
          const isAll = t === ALL_TARGET;
          return (
            <Box key={t}>
              <Text color={focused ? colors.accent : colors.faint}>
                {focused ? icons.focusBar : " "}{" "}
              </Text>
              <Text color={focused ? colors.bright : colors.dim} bold={focused}>
                {isAll ? "all sources" : t}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function FlowResultView({
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

const ALL_TARGET = " all";
