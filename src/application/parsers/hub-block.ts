import { join, resolve } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { absoluteOnAnyHost, localSourcePath, readHubLocalConfig } from "../hub-local-config.js";
import { parseMdSection } from "../markdown.js";

/**
 * Read the hub block from `<dir>/AGENTS.md`, falling back to the legacy
 * `<dir>/CLAUDE.md` of a hub not yet migrated (first file whose parsed block
 * satisfies `accept` wins) — the single home of the read loop.
 */
export async function readHubBlock(
  fs: FileSystemPort,
  dir: string,
  markers: HubBlockMarkers,
  accept: (block: ParsedHubBlock) => boolean = () => true,
): Promise<ParsedHubBlock | null> {
  const namespace = namespaceOfMarkers(markers);
  const local = await readHubLocalConfig(fs, join(dir, `.${namespace}`, "local.json"));
  for (const name of BLOCK_READ_FILES) {
    const path = join(dir, name);
    if (!(await fs.exists(path))) continue;
    const parsed = parseHubBlock(await fs.readText(path), markers);
    const block = parsed === null ? null : resolveHubBlockSources(parsed, dir, local);
    if (block !== null && accept(block)) return block;
  }
  return null;
}

/** The only file Workline writes the hub block to; every host reads it, Claude Code since 2.1.277. */
export const BLOCK_FILE = "AGENTS.md";
/** Where pre-30 hubs mirrored the block; read as a fallback until `aw hub-migrate` retires it. */
export const LEGACY_BLOCK_FILE = "CLAUDE.md";
/** Read order: the block file first, then the legacy mirror of a hub not yet migrated. */
export const BLOCK_READ_FILES = [BLOCK_FILE, LEGACY_BLOCK_FILE] as const;

export interface HubFuente {
  alias: string;
  path: string | null;
  /** The original table cell; never replace it with a machine-local coordinate. */
  declared_path?: string;
  path_reason?: string;
  /** Declared base branch. `null` when the Fuentes cell is empty → the hub default applies. */
  main_branch: string | null;
}

/**
 * Resolve one source coordinate read from a hub block.
 *
 * New configuration persists absolute paths, but legacy blocks may still hold
 * a relative one. A block is scoped to the resolved Workline root that holds
 * it, never to whichever process cwd happens to read it later. Keep absolute
 * values byte-for-byte so a configured source is not rewritten merely by being
 * consumed.
 */
export function resolveHubSourcePath(hub: string, sourcePath: string): string {
  if (sourcePath.length === 0 || absoluteOnAnyHost(sourcePath)) return sourcePath;
  return resolve(hub, sourcePath);
}

export class SourcePathMissingError extends Error {
  readonly code = "SOURCE_PATH_MISSING";
  constructor(alias: string, reason: string) {
    super(
      `la ruta de la fuente ${alias} no existe en este host (${reason}); declárala con aw add-source ${alias}:<ruta>`,
    );
    this.name = "SourcePathMissingError";
  }
}

export async function requireSourcePath(fs: FileSystemPort, source: HubFuente): Promise<string> {
  if (source.path === null || !(await fs.exists(source.path))) {
    throw new SourcePathMissingError(source.alias, source.path_reason ?? "ruta ausente");
  }
  return source.path;
}

/** Apply the hub source-coordinate rule to a parsed block. */
export function resolveHubBlockSources(
  block: ParsedHubBlock,
  hub: string,
  local: Awaited<ReturnType<typeof readHubLocalConfig>> = {
    config: { version: 1, sources: {} },
    error: null,
  },
): ParsedHubBlock {
  const fuentes = block.fuentes.map((source) => {
    const declared = source.declared_path ?? source.path ?? "";
    const localPath = localSourcePath(local.config, source.alias);
    const legacyLocal = declared === "(local)" || declared === join(hub, "(local)");
    const path = resolvedSourceCoordinate(hub, declared, localPath, legacyLocal, local.error);
    return {
      ...source,
      declared_path: declared,
      path,
      ...(path === null
        ? {
            path_reason:
              local.error !== null ? `local.json ilegible: ${local.error}` : "sin ruta local",
          }
        : {}),
    };
  });
  return { ...block, fuentes };
}

/**
 * Hub-level branch defaults (`## Status > Ramas por defecto`). Each role
 * falls back to these when a source declares no value of its own; see
 * `branch-resolver.ts` for the resolution chain.
 */
export interface DefaultBranches {
  principal?: string;
  desarrollo?: string;
  qa?: string;
}

export interface HubStack {
  language?: string;
  framework?: string;
  db?: string;
  build?: string;
}

/** A declared pipeline command, or an explicit omission. Missing keys are undeclared. */
export type SourcePipelineDeclaration = Partial<Record<"build" | "test", string>>;
export type HubPipeline = Record<string, SourcePipelineDeclaration>;

/** A pipeline record has one alias on one line, even when two sources share commands. */
export function parsePipelineRecord(
  line: string,
): { alias: string; value: SourcePipelineDeclaration } | null {
  const match = /^- ([^:\s]+):\s+(.+)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return null;
  const value: SourcePipelineDeclaration = {};
  const parts = match[2].split(/\s+·\s+/);
  for (const part of parts) {
    const field = /^(build|test)\s+(`[^`\r\n]+`|ninguno)$/.exec(part);
    if (!field?.[1] || !field[2] || value[field[1] as "build" | "test"] !== undefined) return null;
    value[field[1] as "build" | "test"] =
      field[2] === "ninguno" ? "ninguno" : field[2].slice(1, -1);
  }
  return Object.keys(value).length ? { alias: match[1], value } : null;
}

export function formatPipelineRecord(alias: string, value: SourcePipelineDeclaration): string {
  const fields = (["build", "test"] as const).flatMap((key) => {
    const command = value[key];
    return command === undefined
      ? []
      : [`${key} ${command === "ninguno" ? command : `\`${command}\``}`];
  });
  return `- ${alias}: ${fields.join(" · ")}`;
}

/**
 * Where a preserved line goes back when the block is re-rendered. The Status
 * slots name the recognized entry the line followed, so a rewrite puts a hand
 * written note back exactly where its author left it.
 */
export type PreservedSlot =
  | "workline"
  | "fuentes"
  | "stack"
  | "pipeline"
  | "status:start"
  | "status:defaults"
  | "status:working"
  | "status:qa"
  | "status:exceptions"
  | "status:edit-mode"
  | "status:activity"
  | "status:historico"
  /**
   * A whole `##` section the block does not own, heading included, re-emitted at
   * the end. The four known sections are read by name, so anything under another
   * heading was invisible to the parser and simply never came back — and a `##`
   * is how a person naturally adds their own content to a Markdown block.
   */
  | "trailing";

/**
 * A line inside the block that the block does not own. It is carried through the
 * rewrite verbatim: the block stays CLI property (it is not free-form Markdown),
 * but rewriting it must never destroy what a person wrote inside it.
 */
export interface PreservedLine {
  slot: PreservedSlot;
  /** The line as written — leading indentation kept, trailing blanks trimmed. */
  text: string;
}

export interface ParsedHubBlock {
  proyecto: string;
  fuentes: HubFuente[];
  stack: HubStack;
  pipeline?: HubPipeline;
  default_branches: DefaultBranches;
  working_branches: Record<string, string>;
  qa_branches: Record<string, string>;
  exception_branches?: Record<string, string>;
  edit_mode?: "in-place" | "unit";
  last_activity: string | null;
  /** Foreign lines kept verbatim. Absent (not empty) when the block is clean. */
  preserved_lines?: PreservedLine[];
  /**
   * CLI-OWNED records the block can no longer honour: a branch entry whose
   * source is not declared any more, a default role that does not exist. They do
   * not survive the rewrite, so callers declare them instead of dropping them in
   * silence. Absent (not empty) when there are none.
   */
  dropped_lines?: string[];
}

export interface HubBlockMarkers {
  start: string;
  end: string;
}

/** The hub block markers of a namespace: `<!-- <NS>-HUB-START -->` … `<!-- <NS>-HUB-END -->`. */
export function hubBlockMarkers(namespace: string): HubBlockMarkers {
  const upper = namespace.toUpperCase();
  return { start: `<!-- ${upper}-HUB-START -->`, end: `<!-- ${upper}-HUB-END -->` };
}

/** The namespace a pair of hub block markers was derived from. */
export function namespaceOfMarkers(markers: HubBlockMarkers): string {
  return (
    /^<!-- ([A-Z][A-Z0-9_-]*)-HUB-START -->$/.exec(markers.start)?.[1]?.toLowerCase() ?? "workflow"
  );
}

export const DEFAULT_HUB_BLOCK_MARKERS: HubBlockMarkers = hubBlockMarkers("workflow");

const LEGACY_BLOCK_START = /<!-- ([A-Z0-9_-]+)-PROJECT-START -->/g;

/**
 * The markers of the first complete block that still wears the pre-29
 * `<NS>-PROJECT-*` form, of any namespace, or `null`.
 *
 * Such a block is detected, never read as the hub's: reading it would keep the
 * old name alive as an alias, and missing it would make the writer append a
 * second, empty block. `aw hub-migrate --apply` is the only way forward.
 */
export function legacyBlockMarkers(text: string): HubBlockMarkers | null {
  for (const match of text.matchAll(LEGACY_BLOCK_START)) {
    const markers = {
      start: `<!-- ${match[1]}-PROJECT-START -->`,
      end: `<!-- ${match[1]}-PROJECT-END -->`,
    };
    if (text.includes(markers.end, (match.index ?? 0) + markers.start.length)) return markers;
  }
  return null;
}

/** The block files under `dir` that still carry a pre-29 block. */
export async function legacyBlockFiles(fs: FileSystemPort, dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of BLOCK_READ_FILES) {
    const path = join(dir, name);
    if ((await fs.exists(path)) && legacyBlockMarkers(await fs.readText(path)) !== null)
      found.push(name);
  }
  return found;
}

/** The pre-29 block of the first block file that has one, read only to answer "does it declare X". */
export async function readLegacyBlock(
  fs: FileSystemPort,
  dir: string,
): Promise<ParsedHubBlock | null> {
  for (const name of BLOCK_READ_FILES) {
    const path = join(dir, name);
    if (!(await fs.exists(path))) continue;
    const text = await fs.readText(path);
    const markers = legacyBlockMarkers(text);
    const block = markers === null ? null : parseWithMarkers(text, markers);
    if (block !== null) return resolveHubBlockSources(block, dir);
  }
  return null;
}

/**
 * Lines the render emits by itself when a section has no data. They belong to
 * the CLI, never to a person: preserving one would duplicate it on the next
 * write (the render re-emits it AND the carried copy would come back too).
 */
export const BLOCK_PLACEHOLDER_PROYECTO = "_Describe el hub aquí: qué es y por qué existe._";
export const BLOCK_PLACEHOLDER_FUENTES =
  "_Sin fuentes declaradas. Usa `aw add-source <alias>:<ruta>:<rama>`._";
const LEGACY_FUENTES_PLACEHOLDER =
  "_Sin fuentes declaradas. Edita manualmente o usa `hub-block --init`._";
export const BLOCK_PLACEHOLDER_STACK = "_Stack sin detectar._";
/** Starts the CLI line under `## Fuentes` that says where `(local)` paths resolve. */
const LOCAL_PATHS_NOTE_PREFIX = "Rutas `(local)`:";

/** Where a `(local)` source path lives: emitted under the table only when a row uses it. */
export function localPathsNote(namespace: string): string {
  return `${LOCAL_PATHS_NOTE_PREFIX} viven en \`.${namespace}/local.json\` de cada máquina; \`aw sources\` las muestra.`;
}

/** `## Workline`: pointers for an agent without the Workline skills, never doctrine. */
export function orientationLines(namespace: string): string[] {
  return [
    "- Estado y pendientes: `aw status`; cómo retomar: `aw resume`.",
    "- `docs/` es la zona permanente: specs, planes y entregables.",
    `- \`.${namespace}/sessions/\` es interno del CLI: no se edita a mano.`,
  ];
}
/** Emitted by the pre-TypeScript generator for an undetectable stack. */
const LEGACY_STACK_PLACEHOLDER = "Edita manualmente si aplica.";

const STACK_KEY_MAP: Record<string, keyof HubStack> = {
  lenguaje: "language",
  framework: "framework",
  bd: "db",
  build: "build",
};

export function parseHubBlock(
  text: string,
  markers: HubBlockMarkers = DEFAULT_HUB_BLOCK_MARKERS,
): ParsedHubBlock | null {
  return parseWithMarkers(text, markers);
}

function parseWithMarkers(text: string, markers: HubBlockMarkers): ParsedHubBlock | null {
  if (!text.includes(markers.start) || !text.includes(markers.end)) {
    return null;
  }
  const start = text.indexOf(markers.start) + markers.start.length;
  const end = text.indexOf(markers.end, start);
  if (end < 0) return null;
  const inner = text.slice(start, end);

  // A pre-29 block, read only to migrate it, keeps its description under `## Proyecto`.
  const heading = markers.start.endsWith("-PROJECT-START -->") ? "Proyecto" : "Hub";
  const proyectoText = parseMdSection(inner, heading) ?? "";
  const fuentesText = parseMdSection(inner, "Fuentes") ?? "";
  const stackText = parseMdSection(inner, "Stack") ?? "";
  const statusText = parseMdSection(inner, "Status") ?? "";
  const pipelineText = parseMdSection(inner, "Pipeline") ?? "";
  const worklineText = parseMdSection(inner, "Workline") ?? "";

  const fuentes = parseFuentesTable(fuentesText);
  const stack = parseStackList(stackText);
  // Aliases first: a Status entry is a branch because it names a DECLARED
  // source, not because of where it sits (see `readNestedRecord`).
  const status = parseStatusBlock(statusText, new Set(fuentes.fuentes.map((f) => f.alias)));
  const { pipeline, pipelinePreserved, pipelineDropped } = parsePipelineBlock(
    pipelineText,
    new Set(fuentes.fuentes.map((f) => f.alias)),
  );

  const block: ParsedHubBlock = {
    proyecto: stripLegacyModeLine(proyectoText),
    fuentes: fuentes.fuentes,
    stack: stack.stack,
    ...(Object.keys(pipeline).length > 0 ? { pipeline } : {}),
    default_branches: status.defaultBranches,
    working_branches: status.workingBranches,
    qa_branches: status.qaBranches,
    ...(Object.keys(status.exceptionBranches).length
      ? { exception_branches: status.exceptionBranches }
      : {}),
    ...(status.editMode ? { edit_mode: status.editMode } : {}),
    last_activity: status.lastActivity,
  };
  const preserved = [
    ...orientationNotes(worklineText, namespaceOfMarkers(markers)),
    ...fuentes.preserved,
    ...stack.preserved,
    ...status.preserved,
    ...pipelinePreserved,
    ...foreignSections(inner),
  ];
  if (preserved.length > 0) block.preserved_lines = preserved;
  const projectedBranches = fuentes.workingColumn.filter(
    (row) => row.value !== (status.workingBranches[row.alias] ?? ""),
  );
  if (status.dropped.length + pipelineDropped.length + projectedBranches.length > 0)
    block.dropped_lines = [
      ...status.dropped,
      ...pipelineDropped,
      ...projectedBranches.map((row) => row.raw),
    ];
  return block;
}

/** The `##` sections this block owns; anything else under a heading is somebody else's. */
const OWNED_SECTIONS: ReadonlySet<string> = new Set([
  "hub",
  "workline",
  "fuentes",
  "stack",
  "status",
  "pipeline",
]);

/**
 * Whole sections the block does not own, heading included.
 *
 * The four owned ones are read BY NAME, so a `## Notas` a person adds was never
 * seen by the parser and never came back — the silent loss this parser exists to
 * stop, arriving through the one shape Markdown makes most natural. They are
 * re-emitted last, after everything the CLI owns, because their original order
 * relative to generated sections is not something a rewrite can honour.
 */
function foreignSections(inner: string): PreservedLine[] {
  const kept: PreservedLine[] = [];
  let foreign = false;
  for (const raw of inner.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(raw.trim());
    if (heading !== null) {
      foreign = !OWNED_SECTIONS.has((heading[1] ?? "").trim().toLowerCase());
    }
    if (!foreign) continue;
    if (raw.trim().length === 0 && kept.length === 0) continue;
    kept.push({ slot: "trailing", text: trimTrailing(raw) });
  }
  while (kept.length > 0 && (kept[kept.length - 1]?.text ?? "").length === 0) kept.pop();
  return kept;
}

/** What a person added under `## Workline`; the CLI's own pointers are re-rendered, not carried. */
function orientationNotes(text: string, namespace: string): PreservedLine[] {
  const own = new Set(orientationLines(namespace));
  return text
    .split("\n")
    .filter((raw) => raw.trim().length > 0 && !own.has(raw.trim()))
    .map((raw) => ({ slot: "workline", text: trimTrailing(raw) }));
}

/** Trailing blanks carry nothing and would churn the rewrite; indentation is content. */
function trimTrailing(raw: string): string {
  return raw.replace(/\s+$/, "");
}

interface FuentesParse {
  fuentes: HubFuente[];
  preserved: PreservedLine[];
  workingColumn: Array<{ alias: string; value: string; raw: string }>;
}

function parseFuentesTable(text: string): FuentesParse {
  const fuentes: HubFuente[] = [];
  const preserved: PreservedLine[] = [];
  const workingColumn: FuentesParse["workingColumn"] = [];
  let header: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!line.startsWith("|")) {
      if (
        line !== BLOCK_PLACEHOLDER_FUENTES &&
        line !== LEGACY_FUENTES_PLACEHOLDER &&
        !line.startsWith(LOCAL_PATHS_NOTE_PREFIX)
      ) {
        preserved.push({ slot: "fuentes", text: trimTrailing(raw) });
      }
      continue;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^[-:\s]*$/.test(c))) {
      continue;
    }
    if (header === null) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    appendFuenteRow(cells, header, raw, { fuentes, preserved, workingColumn });
  }
  return { fuentes, preserved, workingColumn };
}

interface StackParse {
  stack: HubStack;
  preserved: PreservedLine[];
}

function parseStackList(text: string): StackParse {
  const stack: HubStack = {};
  const preserved: PreservedLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line === BLOCK_PLACEHOLDER_STACK || line === LEGACY_STACK_PLACEHOLDER) continue;
    const m = line.match(/^[-*]\s+(Lenguaje|Framework|BD|Build):\s*(.+)$/i);
    const key = m?.[1] ? STACK_KEY_MAP[m[1].toLowerCase()] : undefined;
    if (key && m?.[2]) {
      stack[key] = m[2].trim();
      continue;
    }
    preserved.push({ slot: "stack", text: trimTrailing(raw) });
  }
  return { stack, preserved };
}

interface StatusBlock {
  defaultBranches: DefaultBranches;
  workingBranches: Record<string, string>;
  qaBranches: Record<string, string>;
  exceptionBranches: Record<string, string>;
  editMode?: "in-place" | "unit";
  lastActivity: string | null;
  preserved: PreservedLine[];
  dropped: string[];
}

type StatusSection = "none" | "defaults" | "working" | "qa" | "exceptions";
type StatusSlot = Extract<PreservedSlot, `status:${string}`>;

const DEFAULT_BRANCH_KEYS: ReadonlySet<string> = new Set(["principal", "desarrollo", "qa"]);

/**
 * Read `## Status`. Every line falls in exactly one of three buckets and none of
 * them vanishes: a recognized entry (parsed), a CLI record the block can no
 * longer honour (dropped, and declared by the caller), or anything else — kept
 * verbatim at the slot it was found in.
 */
function parseStatusBlock(text: string, knownAliases: ReadonlySet<string>): StatusBlock {
  const defaultBranches: DefaultBranches = {};
  const workingBranches: Record<string, string> = {};
  const qaBranches: Record<string, string> = {};
  const exceptionBranches: Record<string, string> = {};
  let editMode: "in-place" | "unit" | undefined;
  const preserved: PreservedLine[] = [];
  const dropped: string[] = [];
  let lastActivity: string | null = null;
  let section: StatusSection = "none";
  let slot: StatusSlot = "status:start";

  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (stripped.length === 0) continue;
    const transition = transitionSection(stripped);
    if (transition.handled) {
      section = transition.next;
      slot = transition.slot;
      if (transition.lastActivity !== undefined) {
        lastActivity = transition.lastActivity;
      }
      if (transition.editMode !== undefined) editMode = transition.editMode;
      continue;
    }
    appendStatusRecord(
      raw,
      stripped,
      section,
      slot,
      { defaultBranches, workingBranches, qaBranches, exceptionBranches },
      knownAliases,
      preserved,
      dropped,
    );
  }

  return {
    defaultBranches,
    workingBranches,
    qaBranches,
    exceptionBranches,
    ...(editMode ? { editMode } : {}),
    lastActivity,
    preserved,
    dropped,
  };
}

/**
 * A `- key: value` entry — the shape the render emits for its own records.
 *
 * Position is NOT the signature: that is how a note written after the branch
 * header used to be adopted as a working branch and re-emitted nested under it,
 * perpetuating itself from the first re-run. What identifies a record is its
 * SHAPE plus a key the block already declares (`acceptRecord`).
 *
 * Indentation is deliberately NOT required. The render indents its own entries,
 * but a block hand-edited or written by an older CLI carries them flush left,
 * and demanding the indent would be the positional rule coming back in through
 * another door: those branches would stop being branches, and four consumers
 * read them.
 */
function readNestedRecord(_raw: string, stripped: string): { key: string; value: string } | null {
  if (!stripped.startsWith("- ")) return null;
  const entry = stripped.slice(2).trim();
  const colon = entry.indexOf(":");
  if (colon <= 0) return null;
  const key = entry.slice(0, colon).trim();
  const value = entry.slice(colon + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

interface StatusRecords {
  defaultBranches: DefaultBranches;
  workingBranches: Record<string, string>;
  qaBranches: Record<string, string>;
  exceptionBranches: Record<string, string>;
}

/** True when the record was stored; false when the block cannot honour it. */
function acceptRecord(
  section: Exclude<StatusSection, "none">,
  record: { key: string; value: string },
  out: StatusRecords,
  knownAliases: ReadonlySet<string>,
): boolean {
  if (section === "defaults") {
    const role = record.key.toLowerCase();
    if (!DEFAULT_BRANCH_KEYS.has(role)) return false;
    out.defaultBranches[role as keyof DefaultBranches] = record.value;
    return true;
  }
  if (!knownAliases.has(record.key)) return false;
  const target =
    section === "working"
      ? out.workingBranches
      : section === "qa"
        ? out.qaBranches
        : out.exceptionBranches;
  target[record.key] = record.value;
  return true;
}

function transitionSection(stripped: string): {
  handled: boolean;
  next: StatusSection;
  slot: StatusSlot;
  lastActivity?: string | null;
  editMode?: "in-place" | "unit";
} {
  if (stripped === "- Modo de edición: in-place" || stripped === "- Modo de edición: unit")
    return {
      handled: true,
      next: "none",
      slot: "status:edit-mode",
      editMode: stripped.endsWith("in-place") ? "in-place" : "unit",
    };
  if (stripped.startsWith("- Ramas por defecto:"))
    return { handled: true, next: "defaults", slot: "status:defaults" };
  if (stripped.startsWith("- Ramas de trabajo actuales:"))
    return { handled: true, next: "working", slot: "status:working" };
  if (stripped.startsWith("- Ramas QA actuales:"))
    return { handled: true, next: "qa", slot: "status:qa" };
  if (stripped.startsWith("- Ramas de excepción:"))
    return { handled: true, next: "exceptions", slot: "status:exceptions" };
  if (stripped.startsWith("- Última actividad:")) {
    const idx = stripped.indexOf(":");
    return {
      handled: true,
      next: "none",
      slot: "status:activity",
      lastActivity: idx >= 0 ? stripped.slice(idx + 1).trim() : null,
    };
  }
  if (stripped.startsWith("- Histórico") || stripped.startsWith("- Historico")) {
    return { handled: true, next: "none", slot: "status:historico" };
  }
  return { handled: false, next: "none", slot: "status:start" };
}

/**
 * Drop any legacy `Mode:` line from the hub description. The old two-mode
 * concept was removed (a hub simply has 1+ sources), so the value is
 * ignored — but historic blocks may still carry the line, and it must not leak
 * into the parsed `proyecto`.
 */
function stripLegacyModeLine(text: string): string {
  const cleanLines = text.split("\n").filter((line) => !/^\s*Mode:\s*\S/i.test(line));
  return cleanLines.join("\n").trim();
}

function resolvedSourceCoordinate(
  hub: string,
  declared: string,
  localPath: string | undefined,
  legacyLocal: boolean,
  error: string | null,
): string | null {
  const path =
    error !== null
      ? null
      : localPath !== undefined
        ? resolveHubSourcePath(hub, localPath)
        : declared.length === 0 || legacyLocal
          ? null
          : resolveHubSourcePath(hub, declared);
  return path;
}

function parsePipelineBlock(pipelineText: string, known: ReadonlySet<string>) {
  const pipeline: HubPipeline = {};
  const pipelinePreserved: PreservedLine[] = [];
  const pipelineDropped: string[] = [];
  for (const raw of pipelineText.split("\n")) {
    if (!raw.trim()) continue;
    const record = parsePipelineRecord(raw);
    if (record === null) {
      pipelinePreserved.push({ slot: "pipeline", text: trimTrailing(raw) });
    } else if (!known.has(record.alias)) {
      pipelineDropped.push(trimTrailing(raw));
    } else {
      pipeline[record.alias] = { ...pipeline[record.alias], ...record.value };
    }
  }

  return { pipeline, pipelinePreserved, pipelineDropped };
}

function appendFuenteRow(
  cells: string[],
  header: string[],
  raw: string,
  { fuentes, preserved, workingColumn }: FuentesParse,
): void {
  const alias = cells[0];
  const path = cells[1];
  const mainBranch = cells[2];
  if (cells.length < 3 || alias === undefined || path === undefined) {
    // A row the table shape cannot read: keep it rather than swallow it.
    preserved.push({ slot: "fuentes", text: trimTrailing(raw) });
    return;
  }
  fuentes.push({
    alias,
    path,
    // Empty cell = undeclared: the hub default applies at resolution time.
    main_branch: mainBranch !== undefined && mainBranch.length > 0 ? mainBranch : null,
  });
  if (header[3] === "rama de trabajo")
    workingColumn.push({ alias, value: cells[3] ?? "", raw: trimTrailing(raw) });
}

function appendStatusRecord(
  raw: string,
  stripped: string,
  section: StatusSection,
  slot: StatusSlot,
  out: Pick<
    StatusBlock,
    "defaultBranches" | "workingBranches" | "qaBranches" | "exceptionBranches"
  >,
  knownAliases: ReadonlySet<string>,
  preserved: PreservedLine[],
  dropped: string[],
): void {
  const record = readNestedRecord(raw, stripped);
  if (record === null || section === "none") {
    preserved.push({ slot, text: trimTrailing(raw) });
    return;
  }
  if (acceptRecord(section, record, out, knownAliases)) return;
  // Shape matched but the block cannot honour the key. Indentation decides
  // WHERE it goes, and only here: an indented entry is one this CLI wrote, so
  // a key nobody declares anymore is its own residue — pruned, and declared.
  // A flush-left one is somebody's note that happens to read like `- k: v`,
  // and deleting it is the very loss this parser exists to stop.
  if (/^\s/.test(raw)) dropped.push(trimTrailing(raw));
  else preserved.push({ slot, text: trimTrailing(raw) });
}
