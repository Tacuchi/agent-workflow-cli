import { createHash } from "node:crypto";
import type { SessionState } from "./state-reader.js";

/**
 * The trailing seal: a digest of the very bytes this module emitted.
 *
 * The guard that decided whether a CHECKPOINT could be regenerated used to look
 * for `_[AI:`, a string this template ALWAYS writes (critical context, skills
 * used, one per touched file). Sentinel and generator were the same string, so
 * the only protected state was "not a single marker left anywhere" and every
 * partially filled checkpoint counted as a disposable draft — the default
 * lifecycle route destroyed written prose with exit 0 and no warning.
 *
 * A digest is the one thing filling the template in cannot reproduce: it holds
 * only while the file is still exactly what the CLI wrote.
 */
const SEAL_RE =
  /<!-- written by agent-workflow\.checkpoint at [^\n]* · template sha256=([0-9a-f]{64}) -->\n?$/;

export function formatCheckpointMd(state: SessionState): string {
  const lines: string[] = [];
  appendHeader(lines, state);
  appendDecisions(lines, state);
  appendFilesTouched(lines, state);
  appendContext(lines);
  appendRefs(lines, state);
  // Body first, seal second: the seal states a fact ABOUT the body, so it can
  // never be part of what it measures.
  const body = `${lines.join("\n")}\n\n`;
  return `${body}<!-- written by agent-workflow.checkpoint at ${state.timestamp} · template sha256=${digestOf(body)} -->\n`;
}

/**
 * True only when `text` is byte for byte what `formatCheckpointMd` produced —
 * an untouched template that can be regenerated without losing anything.
 *
 * An UNSEALED file (written before this seal existed) is not pristine either.
 * The asymmetry is deliberate: keeping a stale template by mistake costs one
 * regeneration behind `--force`, dropping a filled checkpoint by mistake costs
 * the work it recorded.
 */
export function isPristineCheckpoint(text: string): boolean {
  const match = text.match(SEAL_RE);
  const sealed = match?.[1];
  if (sealed === undefined || match?.index === undefined) return false;
  return digestOf(text.slice(0, match.index)) === sealed;
}

function digestOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function appendHeader(lines: string[], state: SessionState): void {
  const progress = state.progress_pct;
  const progressLine =
    progress !== null
      ? `${progress}% (${state.tasks.closed} of ${state.tasks.total} tasks complete)`
      : "_progress unknown (TASKS.md missing or empty)_";
  lines.push(
    `# Checkpoint — ${state.folder}`,
    "",
    `- Updated: ${state.timestamp}`,
    `- Progress: ${progressLine}`,
    "",
    "## Last action",
    "",
    "_[AI: 1-3 sentences on the last concrete progress. Review recent diffs and the latest entry in DECISIONS.md.]_",
    "",
    "## Next step",
    "",
    "_[AI: 1-2 sentences on what remains. Review the first open item in TASKS.md.]_",
    "",
  );
}

function appendDecisions(lines: string[], state: SessionState): void {
  lines.push("## Recent decisions", "");
  if (state.last_decision) {
    lines.push(`- ${state.last_decision.id}: ${state.last_decision.excerpt}`);
  } else {
    lines.push("_No decisions recorded._");
  }
}

function appendFilesTouched(lines: string[], state: SessionState): void {
  lines.push("", "## Files touched (post-last-commit)", "");
  const files = state.files_touched;
  if (files.length === 0) {
    lines.push("_No uncommitted changes detected in cwd._");
    return;
  }
  for (const f of files.slice(0, 20)) {
    lines.push(`- ${f.path} (+${f.added} -${f.removed}) — _[AI: purpose in 1 line]_`);
  }
  if (files.length > 20) {
    lines.push(`- _… and ${files.length - 20} more_`);
  }
}

function appendContext(lines: string[]): void {
  lines.push("", "## Critical context to resume", "");
  lines.push(
    "_[AI: 2-3 paragraphs with the minimum info needed to continue without re-exploring. What was discovered, what decisions are settled, what to keep in mind.]_",
  );
}

function appendRefs(lines: string[], state: SessionState): void {
  lines.push("", "## Refs", "");
  if (state.origen) lines.push(`- Origin: ${state.origen}`);
  const present = collectArtefacts(state.artefacts);
  if (present.length > 0) {
    lines.push(`- Artifacts present: ${present.join(", ")}`);
  }
  lines.push("- Skills used: _[AI: list the skills invoked during the session]_");
}

function collectArtefacts(artefacts: Record<string, boolean | number>): string[] {
  const present: string[] = [];
  for (const [k, v] of Object.entries(artefacts)) {
    if (k === "scripts_count") continue;
    if (v === true) present.push(k);
  }
  const scriptsCount = artefacts.scripts_count;
  if (typeof scriptsCount === "number" && scriptsCount > 0) {
    present.push(`scripts(${scriptsCount})`);
  }
  return present;
}
