/**
 * The project block of a hub whose markers were stamped by an older namespace.
 *
 * The markers are DERIVED from the namespace (`<NS>-PROJECT-START`), so a hub
 * created while this tool was called `agent-workflow` wears
 * `AGENT-WORKFLOW-PROJECT-*` and the CLI running as `workflow` does not
 * recognize it. Nothing fails loudly: the writer finds no current markers and
 * APPENDS a second block, and from then on the CLI reads the block it just
 * created — sources it never learned, branches nobody declared — while every
 * declaration the workspace ever made sits untouched a few lines above.
 * Renaming the markers is what makes the rich block the one that answers.
 */

import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import {
  type ParsedProjectBlock,
  type ProjectBlockMarkers,
  parseProjectBlock,
} from "../parsers/project-block.js";

/** The hub files, in the order `readWorkspaceBlock` consults them. */
const HUB_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/**
 * Any project block, whatever namespace stamped it.
 *
 * Deliberately not a list of known-legacy prefixes: the marker is a function of
 * the namespace, so the set of "old" ones is open and a hardcoded list would go
 * stale the next time the tool is renamed. What the block wears is read off the
 * file; what it should wear comes from the running namespace.
 */
const BLOCK_START = /<!--\s*([A-Z0-9_-]+)-PROJECT-START\s*-->/;
const EVERY_BLOCK_START = new RegExp(BLOCK_START.source, "g");

function markersFor(prefix: string): ProjectBlockMarkers {
  return {
    start: `<!-- ${prefix}-PROJECT-START -->`,
    end: `<!-- ${prefix}-PROJECT-END -->`,
  };
}

export interface HubMarkerRewrite {
  /** Absolute path of the hub file. */
  path: string;
  /** Namespace prefix the block wears today. */
  from: string;
  /** Namespace prefix it will wear. */
  to: string;
  /** A second block, already in the current markers, that this one removes. */
  drops_duplicate: boolean;
  /**
   * The exact bytes the file will hold.
   *
   * Derived ONCE, by the read-only pass, so what a person approves in the
   * preview and what `--apply` writes cannot be two different renderings.
   */
  text: string;
}

export interface HubMarkerRefusal {
  reason: "marcadores_ambiguos" | "bloque_ilegible" | "duplicado_con_contenido";
  detail: string;
}

export type HubMarkerOutcome =
  | { kind: "rewrite"; rewrite: HubMarkerRewrite }
  | { kind: "refused"; refusal: HubMarkerRefusal }
  | { kind: "nothing" };

/** Every hub file that exists under `root`, with its bytes. */
export async function readHubFiles(
  fs: FileSystemPort,
  root: string,
): Promise<{ path: string; text: string }[]> {
  const hubs: { path: string; text: string }[] = [];
  for (const name of HUB_FILES) {
    const path = join(root, name);
    if (!(await fs.exists(path))) continue;
    hubs.push({ path, text: await fs.readText(path) });
  }
  return hubs;
}

/**
 * What this file needs, if anything: rename its block, or refuse to touch it.
 *
 * Pure on purpose — the decision is a function of the bytes and of the running
 * namespace, and nothing else. Reading the file is the caller's I/O.
 */
export function planHubMarkers(
  path: string,
  text: string,
  current: ProjectBlockMarkers,
): HubMarkerOutcome {
  const currentPrefix = prefixOf(current.start);
  const prefixes = blockPrefixes(text);
  const foreign = prefixes.filter((prefix) => prefix !== currentPrefix);
  const outdated = foreign[0];
  if (outdated === undefined) return { kind: "nothing" };
  if (foreign.length > 1) {
    return refuse(
      "marcadores_ambiguos",
      `${path} lleva ${foreign.length} bloques de namespaces distintos (${foreign.join(", ")}): cuál es el vigente lo decide una persona`,
    );
  }

  const from = markersFor(outdated);
  const adopted = parseProjectBlock(text, from);
  if (adopted === null) {
    return refuse("bloque_ilegible", `el bloque ${outdated} de ${path} no se pudo parsear`);
  }
  if (!prefixes.includes(currentPrefix)) {
    return rewriteOf(path, outdated, currentPrefix, false, renameMarkers(text, from, current));
  }

  // The block the CLI appended when it could not find the current markers. It is
  // usually the empty shell of a workspace that had already declared everything
  // above it — but "usually" is not a licence to delete, so what it declares is
  // compared before it goes.
  const duplicate = parseProjectBlock(text, current);
  const extra = duplicate === null ? [] : extraDeclarations(duplicate, adopted);
  if (extra.length > 0) {
    return refuse(
      "duplicado_con_contenido",
      `el bloque ${currentPrefix} de ${path} declara lo que el bloque ${outdated} no tiene (${extra.join("; ")}): fusionalos a mano y reintentá`,
    );
  }
  const dropped = dropBlock(text, current);
  return rewriteOf(path, outdated, currentPrefix, true, renameMarkers(dropped, from, current));
}

function rewriteOf(
  path: string,
  from: string,
  to: string,
  dropsDuplicate: boolean,
  text: string,
): HubMarkerOutcome {
  return { kind: "rewrite", rewrite: { path, from, to, drops_duplicate: dropsDuplicate, text } };
}

function refuse(reason: HubMarkerRefusal["reason"], detail: string): HubMarkerOutcome {
  return { kind: "refused", refusal: { reason, detail } };
}

/** `<!-- WORKFLOW-PROJECT-START -->` → `WORKFLOW`. */
function prefixOf(startMarker: string): string {
  return BLOCK_START.exec(startMarker)?.[1] ?? "";
}

/** Namespace prefixes of every COMPLETE block the text carries, in order, deduped. */
function blockPrefixes(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(EVERY_BLOCK_START)) {
    const prefix = match[1];
    if (prefix === undefined || found.includes(prefix)) continue;
    // A start without its end is not a block: cutting or renaming half of one
    // would leave the file worse than it was found.
    if (!text.includes(markersFor(prefix).end)) continue;
    found.push(prefix);
  }
  return found;
}

/**
 * Rename in place: the content between the markers is not re-rendered.
 *
 * Re-rendering through `renderProjectBlock` would round-trip the block through
 * the parser and hand back only what the parser understands — every line it
 * does not model (a note, a section this version never learned) would be gone.
 * A rename touches two lines and nothing else.
 */
function renameMarkers(text: string, from: ProjectBlockMarkers, to: ProjectBlockMarkers): string {
  return text.replaceAll(from.start, to.start).replaceAll(from.end, to.end);
}

/** Cut a whole block out, leaving one blank line where it used to separate two. */
function dropBlock(text: string, markers: ProjectBlockMarkers): string {
  const start = text.indexOf(markers.start);
  const end = text.indexOf(markers.end, start);
  if (start < 0 || end < 0) return text;
  const head = text.slice(0, start).replace(/\n+$/, "");
  const tail = text.slice(end + markers.end.length).replace(/^\n+/, "");
  if (head === "") return tail;
  if (tail === "") return `${head}\n`;
  return `${head}\n\n${tail}`;
}

/**
 * What the appended block declares that the adopted one does not.
 *
 * Empty means dropping it loses nothing, which is the only condition under
 * which it gets dropped. `last_activity` is deliberately not compared: it is a
 * timestamp the writer stamps on every write, not something a workspace
 * declared, and the appended block always carries the fresher one.
 */
function extraDeclarations(candidate: ParsedProjectBlock, adopted: ParsedProjectBlock): string[] {
  const extra: string[] = [];
  if (isDeclared(candidate.proyecto) && candidate.proyecto !== adopted.proyecto) {
    extra.push(`Proyecto: ${firstLine(candidate.proyecto)}`);
  }
  for (const fuente of candidate.fuentes) {
    const same = adopted.fuentes.some((f) => f.alias === fuente.alias && f.path === fuente.path);
    if (!same) extra.push(`Fuente: ${fuente.alias} → ${fuente.path}`);
  }
  extra.push(...extraEntries("Stack", candidate.stack, adopted.stack));
  extra.push(
    ...extraEntries("Rama por defecto", candidate.default_branches, adopted.default_branches),
  );
  extra.push(
    ...extraEntries("Rama de trabajo", candidate.working_branches, adopted.working_branches),
  );
  extra.push(...extraEntries("Rama QA", candidate.qa_branches, adopted.qa_branches));
  return extra;
}

function extraEntries(label: string, candidate: object, adopted: object): string[] {
  const known = new Map(Object.entries(adopted));
  const extra: string[] = [];
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (known.get(key) === value) continue;
    extra.push(`${label} ${key}: ${value}`);
  }
  return extra;
}

/**
 * A `## Proyecto` somebody wrote, as opposed to the placeholder the renderer
 * emits when nobody has (`_Describe el proyecto aquí…_`).
 */
function isDeclared(proyecto: string): boolean {
  const text = proyecto.trim();
  return text.length > 0 && !(text.startsWith("_") && text.endsWith("_"));
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? text;
}
