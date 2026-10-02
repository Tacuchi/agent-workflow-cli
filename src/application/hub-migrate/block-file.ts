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
}

export interface BlockFileDivergence {
  path: string;
  only_claude: string[];
  only_agents: string[];
}

export type BlockFileOutcome =
  | { kind: "migrate"; migration: BlockFileMigration }
  | { kind: "divergent"; divergence: BlockFileDivergence }
  | { kind: "nothing" };

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
  const legacyBlock = renderedBlock(legacy.block, render);
  const agentsBlock = agents === null ? null : renderedBlock(agents.block, render);
  if (legacyBlock === null) return { kind: "nothing" };

  let source: KeepChoice = LEGACY_BLOCK_FILE;
  if (agentsBlock !== null && agentsBlock !== legacyBlock) {
    if (keep === undefined) {
      return {
        kind: "divergent",
        divergence: {
          path: join(hub, LEGACY_BLOCK_FILE),
          only_claude: linesMissing(legacyBlock, agentsBlock),
          only_agents: linesMissing(agentsBlock, legacyBlock),
        },
      };
    }
    source = keep;
  } else if (agentsBlock !== null) {
    source = BLOCK_FILE;
  }
  const surviving = source === BLOCK_FILE && agentsBlock !== null ? agentsBlock : legacyBlock;
  return {
    kind: "migrate",
    migration: {
      legacy: legacyPlan(hub, legacy.outside),
      agents: agentsPlan(hub, texts.agents, agents, surviving),
      adds_import: needsImport(legacy.outside),
      source,
    },
  };
}

function legacyPlan(hub: string, outside: string): BlockFileMigration["legacy"] {
  const path = join(hub, LEGACY_BLOCK_FILE);
  const own = outside.trim();
  if (own.length === 0) return { path, action: "retire", text: null };
  const text = needsImport(outside) ? `${AGENTS_IMPORT}\n\n${own}\n` : `${own}\n`;
  return { path, action: "strip", text };
}

function needsImport(outside: string): boolean {
  const own = outside.trim();
  return own.length > 0 && !own.split("\n").some((line) => line.trim() === AGENTS_IMPORT);
}

function agentsPlan(
  hub: string,
  current: string | null,
  split: { block: string; outside: string; before: string; after: string } | null,
  block: string,
): BlockFileMigration["agents"] {
  const path = join(hub, BLOCK_FILE);
  let text: string;
  if (current === null) text = `${block}\n`;
  else if (split === null) text = `${current.replace(/\n*$/, "")}\n\n${block}\n`;
  else text = `${split.before}${block}${split.after}`;
  return text === current ? null : { path, text };
}

/** The block (markers included) and what surrounds it; null when the file has none. */
function splitBlock(
  text: string,
  markers: HubBlockMarkers,
): { block: string; outside: string; before: string; after: string } | null {
  const start = text.indexOf(markers.start);
  const end = start < 0 ? -1 : text.indexOf(markers.end, start + markers.start.length);
  if (start < 0 || end < 0) return null;
  const stop = end + markers.end.length;
  const before = text.slice(0, start);
  const after = text.slice(stop);
  return { block: text.slice(start, stop), outside: `${before}\n${after}`, before, after };
}

function renderedBlock(
  block: string,
  render: { markers: HubBlockMarkers; historicoPath?: string },
): string | null {
  const parsed = parseHubBlock(block, render.markers);
  if (parsed === null) return null;
  return blockFromParsed(parsed, {
    markers: render.markers,
    ...(render.historicoPath !== undefined ? { historicoPath: render.historicoPath } : {}),
  });
}

function linesMissing(from: string, other: string): string[] {
  const present = new Set(other.split("\n"));
  return from.split("\n").filter((line) => line.trim().length > 0 && !present.has(line));
}
