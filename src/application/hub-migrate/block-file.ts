/**
 * Retiring the legacy CLAUDE.md mirror of the hub block.
 *
 * Before 30.0.0 the block was written to CLAUDE.md and AGENTS.md at once.
 * Claude Code reads AGENTS.md by itself since 2.1.277, but ANY CLAUDE.md in the
 * hub (or above it) makes it read CLAUDE.md files only — so a mirror left
 * behind would keep feeding Claude a block nobody updates any more.
 *
 * The block that survives is re-rendered with the current format. Two blocks
 * that render the same are one block; two that do not are a decision the
 * migration never takes on its own: it reports both sides and waits for
 * `--keep`.
 */

import { join } from "node:path";
import {
  BLOCK_FILE,
  type HubBlockMarkers,
  LEGACY_BLOCK_FILE,
  parseHubBlock,
} from "../parsers/hub-block.js";
import { blockFromParsed } from "../render/hub-block.js";

/** The line that makes Claude Code read AGENTS.md from a CLAUDE.md that must stay. */
export const AGENTS_IMPORT = "@AGENTS.md";
const AGENTS_IMPORT_LINE = /^@(\.\/)?AGENTS\.md$/;

/**
 * The two commands that resolve a divergent pair. Never one string with `|`:
 * a shell reads that as a pipe and would run `--keep AGENTS.md` unasked.
 */
export const KEEP_COMMANDS = [
  "aw hub-migrate --apply --keep AGENTS.md",
  "aw hub-migrate --apply --keep CLAUDE.md",
] as const;
/** How the choice is named in prose: the two commands, joined by words. */
export const KEEP_CHOICE_TEXT = `\`${KEEP_COMMANDS[0]}\` o \`${KEEP_COMMANDS[1]}\``;

/** Which block survives a divergent pair: the person's answer to `--keep`. */
export type KeepChoice = typeof BLOCK_FILE | typeof LEGACY_BLOCK_FILE;

export interface BlockFileMigration {
  /** `retire`: CLAUDE.md held only the block and goes away; `strip`: it keeps its own content. */
  legacy: { path: string; action: "retire" | "strip"; text: string | null };
  /** The new AGENTS.md, or null when it already holds exactly this block. */
  agents: { path: string; text: string } | null;
  /** True when the stripped CLAUDE.md gains the import at its top. */
  adds_import: boolean;
  /** Which file the surviving block came from. */
  source: KeepChoice;
  /** CLI records neither block can honour (the parser's `dropped_lines`): declared, never silent. */
  dropped_lines: string[];
}

export interface BlockFileDivergence {
  path: string;
  only_claude: string[];
  only_agents: string[];
  /** `lines`: each side declares something the other lacks; `order`: same lines, reordered; `blank-lines`: they differ only in blank lines. */
  difference: "lines" | "order" | "blank-lines";
}

export type BlockFileOutcome =
  | { kind: "migrate"; migration: BlockFileMigration }
  | { kind: "divergent"; divergence: BlockFileDivergence }
  | {
      kind: "refused";
      path: string;
      reason: "bloque_duplicado" | "claude_md_enlazado";
      detail: string;
    }
  | { kind: "nothing" };

interface Rendered {
  block: string;
  dropped: string[];
}

/**
 * What the legacy mirror of one hub needs. `texts` are the files as the marker
 * rename leaves them, so both steps of one migration agree on the bytes.
 */
export function planBlockFile(
  hub: string,
  texts: { agents: string | null; claude: string | null },
  render: { markers: HubBlockMarkers; historicoPath?: string },
  keep?: KeepChoice,
): BlockFileOutcome {
  const legacy = texts.claude === null ? null : splitBlock(texts.claude, render.markers);
  if (legacy === null) return { kind: "nothing" };
  const agents = texts.agents === null ? null : splitBlock(texts.agents, render.markers);
  const duplicated = duplicatedBlock(hub, { legacy, agents }, render.markers);
  if (duplicated !== null) return duplicated;
  const legacyBlock = renderedBlock(legacy.block, render);
  const agentsBlock = agents === null ? null : renderedBlock(agents.block, render);
  if (legacyBlock === null) return { kind: "nothing" };

  const differs = agentsBlock !== null && agentsBlock.block !== legacyBlock.block;
  if (differs && keep === undefined)
    return divergentOutcome(hub, legacyBlock.block, agentsBlock.block);
  return migrateOutcome(
    hub,
    texts,
    { legacy, agents },
    { legacy: legacyBlock, agents: agentsBlock },
    differs ? keep : undefined,
  );
}

/** `keep` only matters when the two blocks differ; equal blocks keep AGENTS.md's bytes. */
function migrateOutcome(
  hub: string,
  texts: { agents: string | null; claude: string | null },
  splits: {
    legacy: { remainder: string };
    agents: { before: string; after: string } | null;
  },
  rendered: { legacy: Rendered; agents: Rendered | null },
  keep: KeepChoice | undefined,
): BlockFileOutcome {
  let source: KeepChoice = rendered.agents === null ? LEGACY_BLOCK_FILE : BLOCK_FILE;
  if (keep !== undefined) source = keep;
  const surviving =
    source === BLOCK_FILE && rendered.agents !== null ? rendered.agents : rendered.legacy;
  const remainder = splits.legacy.remainder;
  return {
    kind: "migrate",
    migration: {
      legacy: legacyPlan(hub, texts.claude ?? "", splits.legacy),
      agents: agentsPlan(hub, texts.agents, splits.agents, surviving.block),
      adds_import: hasOwnContent(remainder) && !importsAgents(remainder),
      source,
      dropped_lines: [
        ...new Set([...rendered.legacy.dropped, ...(rendered.agents?.dropped ?? [])]),
      ],
    },
  };
}

/** A file with a second block left after the first: which one stays is the person's call. */
function duplicatedBlock(
  hub: string,
  splits: { legacy: { remainder: string }; agents: { remainder: string } | null },
  markers: HubBlockMarkers,
): BlockFileOutcome | null {
  const has = (text: string | undefined) =>
    text !== undefined && lineStart(text, markers.start, 0) >= 0;
  const file = has(splits.legacy.remainder)
    ? LEGACY_BLOCK_FILE
    : has(splits.agents?.remainder)
      ? BLOCK_FILE
      : null;
  if (file === null) return null;
  return {
    kind: "refused",
    path: join(hub, file),
    reason: "bloque_duplicado",
    detail: `${file} tiene más de un bloque del hub: dejá uno solo y reintentá`,
  };
}

function divergentOutcome(hub: string, claude: string, agents: string): BlockFileOutcome {
  const onlyClaude = linesMissing(claude, agents);
  const onlyAgents = linesMissing(agents, claude);
  return {
    kind: "divergent",
    divergence: {
      path: join(hub, LEGACY_BLOCK_FILE),
      only_claude: onlyClaude,
      only_agents: onlyAgents,
      difference: differenceOf(claude, agents, onlyClaude.length + onlyAgents.length),
    },
  };
}

function differenceOf(
  claude: string,
  agents: string,
  missing: number,
): BlockFileDivergence["difference"] {
  if (missing > 0) return "lines";
  const sorted = (text: string) => text.split("\n").sort().join("\n");
  return sorted(claude) === sorted(agents) ? "order" : "blank-lines";
}

/** The person's content stays byte for byte: only the block leaves, and the gap it left closes. */
function legacyPlan(
  hub: string,
  original: string,
  split: { remainder: string },
): BlockFileMigration["legacy"] {
  const path = join(hub, LEGACY_BLOCK_FILE);
  if (!hasOwnContent(split.remainder)) return { path, action: "retire", text: null };
  if (importsAgents(split.remainder)) return { path, action: "strip", text: split.remainder };
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  return { path, action: "strip", text: `${AGENTS_IMPORT}${eol}${eol}${split.remainder}` };
}

function hasOwnContent(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * An `@AGENTS.md` line outside code: Claude Code ignores imports inside a fence
 * or an indented code block (four spaces or a tab), so those do not count.
 */
function importsAgents(text: string): boolean {
  let fence: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]?.charAt(0) ?? null;
    if (marker !== null) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    } else if (fence === null && /^ {0,3}\S/.test(raw) && AGENTS_IMPORT_LINE.test(raw.trim()))
      return true;
  }
  return false;
}

function agentsPlan(
  hub: string,
  current: string | null,
  split: { before: string; after: string } | null,
  block: string,
): BlockFileMigration["agents"] {
  const path = join(hub, BLOCK_FILE);
  let text: string;
  const eol = current?.includes("\r\n") ? "\r\n" : "\n";
  const own = block.replace(/\n/g, eol);
  if (current === null || current.trim().length === 0) text = `${own}${eol}`;
  else if (split === null) text = `${current.replace(/(\r?\n)+$/, "")}${eol}${eol}${own}${eol}`;
  else text = `${split.before}${own}${split.after}`;
  return text === current ? null : { path, text };
}

/**
 * The block (markers included), what surrounds it, and the file without it:
 * the gap closes to one blank line, as `dropBlock` does for a duplicated block.
 */
function splitBlock(
  text: string,
  markers: HubBlockMarkers,
): { block: string; before: string; after: string; remainder: string } | null {
  const start = lineStart(text, markers.start, 0);
  // Only the start is anchored to a line: an end marker typed after content still closes the block, as the parsers read it.
  const end = start < 0 ? -1 : text.indexOf(markers.end, start + markers.start.length);
  if (start < 0 || end < 0) return null;
  const stop = end + markers.end.length;
  const before = text.slice(0, start);
  const after = text.slice(stop);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const head = before.replace(/(\r?\n)+$/, "").replace(/^(\r?\n)+/, "");
  const tail = after.replace(/^(\r?\n)+/, "");
  let remainder: string;
  if (head.trim() === "") remainder = tail;
  else if (tail.trim() === "") remainder = `${head}${eol}`;
  else remainder = `${head}${eol}${eol}${tail}`;
  return { block: text.slice(start, stop), before, after, remainder };
}

/** A marker counts only at the start of a line: one quoted in the person's prose is prose. */
function lineStart(text: string, marker: string, from: number): number {
  let index = text.indexOf(marker, from);
  while (index > 0 && text.charAt(index - 1) !== "\n") index = text.indexOf(marker, index + 1);
  return index;
}

function renderedBlock(
  block: string,
  render: { markers: HubBlockMarkers; historicoPath?: string },
): Rendered | null {
  const parsed = parseHubBlock(block.replace(/\r\n/g, "\n"), render.markers);
  if (parsed === null) return null;
  return {
    block: blockFromParsed(parsed, {
      markers: render.markers,
      ...(render.historicoPath !== undefined ? { historicoPath: render.historicoPath } : {}),
    }),
    dropped: parsed.dropped_lines ?? [],
  };
}

/** Lines of `from` that `other` lacks, counting repeats, so a duplicated line is not hidden. */
function linesMissing(from: string, other: string): string[] {
  const available = new Map<string, number>();
  for (const line of other.split("\n")) available.set(line, (available.get(line) ?? 0) + 1);
  const missing: string[] = [];
  for (const line of from.split("\n")) {
    const count = available.get(line) ?? 0;
    if (count > 0) available.set(line, count - 1);
    else if (line.trim().length > 0) missing.push(line);
  }
  return missing;
}
