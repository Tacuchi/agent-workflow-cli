import { createHash } from "node:crypto";
import {
  CONTEXTUAL_LIMIT,
  type FilesTouched,
  type TouchedFile,
  WORKSPACE_UNIT,
} from "./files-touched.js";
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
  /<!-- written by agent-workflow\.checkpoint at ([^\n]*?) · template sha256=([0-9a-f]{64}) -->\n?$/;

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
  return `${body}${sealFor(state.timestamp, body)}`;
}

/**
 * True only when `text` is byte for byte what the CLI itself wrote — its own
 * template, plus whatever the CLI later folded into the sealed body (see
 * {@link appendSealedBlock}) — so regenerating it loses nothing of anybody's.
 *
 * An UNSEALED file (written before this seal existed) is not pristine either.
 * The asymmetry is deliberate: keeping a stale template by mistake costs one
 * regeneration behind `--force`, dropping a filled checkpoint by mistake costs
 * the work it recorded.
 */
export function isPristineCheckpoint(text: string): boolean {
  const match = text.match(SEAL_RE);
  const sealed = match?.[2];
  if (sealed === undefined || match?.index === undefined) return false;
  return digestOf(text.slice(0, match.index)) === sealed;
}

/**
 * Add `block` to a checkpoint without lying about who wrote the file.
 *
 * A checkpoint still byte for byte the CLI's own sealed output gets the block
 * INSIDE the body and a seal recomputed over it, so the file keeps being
 * demonstrably the CLI's and {@link isPristineCheckpoint} keeps answering the
 * question it exists to answer: "is there anybody's prose in here?". Appending
 * PAST the seal instead was what turned the CLI's own template into "content to
 * preserve" — from the first adopted refuge on, every later lifecycle run
 * preserved a file nobody had written, so the checkpoint froze for the rest of
 * the session's life and the only way forward, `--force`, dropped the adopted
 * text along with the template.
 *
 * Anything else — filled in, hand-edited, written before the seal existed — is
 * appended to plainly. Re-sealing there would claim the CLI wrote somebody's
 * prose and hand the next run permission to regenerate over it.
 *
 * `block` is body-shaped: it starts with its own heading and ends with a blank
 * line, which is the invariant the sealed body keeps.
 */
export function appendSealedBlock(text: string, block: string): string {
  const match = text.match(SEAL_RE);
  const timestamp = match?.[1];
  const sealed = match?.[2];
  if (timestamp === undefined || sealed === undefined || match?.index === undefined) {
    return plainAppend(text, block);
  }
  const body = text.slice(0, match.index);
  if (digestOf(body) !== sealed) return plainAppend(text, block);
  const grown = `${body}${block}`;
  return `${grown}${sealFor(timestamp, grown)}`;
}

/**
 * The `heading` sections a checkpoint already carries, each as a `block` that
 * {@link appendSealedBlock} accepts back.
 *
 * Regeneration replaces the template, and a section the CLI folded in (an
 * adopted refuge) is not part of any template: without carrying it across, a
 * regeneration — the ordinary one over a pristine file, or a `--force` — would
 * drop state that was parked precisely so it would NOT be lost, and the refuge
 * file it came from is already gone from disk.
 */
export function blocksUnder(text: string, heading: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.replace(SEAL_RE, "").split("\n")) {
    if (line === heading || line.startsWith(`${heading} `)) {
      if (current !== null) blocks.push(closeBlock(current));
      current = [line];
      continue;
    }
    if (current === null) continue;
    // Any other heading ends it: a block owns its own lines and nothing else's.
    if (line.startsWith("#")) {
      blocks.push(closeBlock(current));
      current = null;
      continue;
    }
    current.push(line);
  }
  if (current !== null) blocks.push(closeBlock(current));
  return blocks;
}

function closeBlock(lines: string[]): string {
  return `${lines.join("\n").trimEnd()}\n\n`;
}

function plainAppend(text: string, block: string): string {
  const tail = block.replace(/\n+$/, "\n");
  if (text.length === 0) return tail;
  return `${text.endsWith("\n") ? text : `${text}\n`}\n${tail}`;
}

function sealFor(timestamp: string, body: string): string {
  return `<!-- written by agent-workflow.checkpoint at ${timestamp} · template sha256=${digestOf(body)} -->\n`;
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

/**
 * The heading no longer says "post-last-commit".
 *
 * It promised a window this section never delivered — the inventory is the
 * CURRENT state of the tree, and reading it as "what changed since the last
 * commit of this session" is what made an operator distrust it. The reference
 * each unit is actually compared against is now stated in the section itself,
 * which is both honest and more useful than a label in the heading. The former
 * headings stay readable: they are kept as aliases in the heading table.
 */
function appendFilesTouched(lines: string[], state: SessionState): void {
  const touched = state.files_touched;
  lines.push("", "## Files touched", "");
  lines.push(scopeLine(touched), "");
  for (const unit of touched.unobserved) {
    lines.push(`- **Not observed — ${unit.alias}** at \`${unit.boundary}\`: ${unit.reason}`);
  }
  if (touched.unobserved.length > 0) lines.push("");

  // Claimed paths first: the readable cap applies to the rest, so nothing the
  // session actually produced can be pushed out of sight by unrelated noise.
  const shown = [...touched.linked, ...touched.contextual];
  if (shown.length === 0) {
    // "Nothing changed" is only sayable when something was read. A collection
    // that failed is declared above and must never be spelled as a clean tree.
    lines.push(
      touched.observed.length === 0
        ? "_No unit in scope could be read — see the declaration above._"
        : "_No uncommitted changes inside the scope above._",
    );
    return;
  }
  for (const file of shown) {
    lines.push(`- ${labelOf(file)}${countsOf(file)} — _[AI: purpose in 1 line]_`);
  }
  if (touched.omitted.length > 0) {
    // Named by unit, not merely counted: "30 more" over two units reads as if
    // both were shown, and a reader has no way to tell which one was cut.
    const total = touched.omitted.reduce((sum, entry) => sum + entry.count, 0);
    const noun = total === 1 ? "change" : "changes";
    const perUnit = touched.omitted.map((entry) => `${entry.unit} ${entry.count}`).join(", ");
    lines.push(
      `- _… and ${total} more contextual ${noun} not listed (cap ${CONTEXTUAL_LIMIT}): ${perUnit}_`,
    );
  }
}

/** States the boundary and the reference, so the inventory explains itself. */
function scopeLine(touched: FilesTouched): string {
  if (touched.observed.length === 0) {
    return "_Scope: no unit could be read. What this section reports is the current working-tree state, never a window over the session._";
  }
  const units = touched.observed.map((unit) => {
    const reference =
      unit.reference === null ? "no commit yet" : `vs ${unit.reference.slice(0, 7)}`;
    return `${unit.alias} at \`${unit.boundary}\` (${reference})`;
  });
  return `_Scope: ${units.join("; ")}. Current working-tree state, untracked files included — not a window over the session._`;
}

/** A path from another unit is spelled with its alias: two units can share one. */
function labelOf(file: TouchedFile): string {
  return file.unit === WORKSPACE_UNIT ? file.path : `${file.unit}:${file.path}`;
}

function countsOf(file: TouchedFile): string {
  if (file.added === null || file.removed === null) return "";
  // git spells a binary file's deltas as `-`, and `(+- --)` reads like a
  // rendering bug rather than like "this file has no line count".
  if (file.added === "-" || file.removed === "-") return " (binary)";
  return ` (+${file.added} -${file.removed})`;
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
