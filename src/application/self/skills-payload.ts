// The exact bytes a selection would materialize (Spec 043 · AC-04, AC-05),
// staged OUTSIDE any host root: preparing changes no installation.
//
// Three things this owns and nothing else does:
//   - the payload of a chosen path — the whole folder, minus the subtrees that
//     are OTHER skills, because a root must not drag its descendants in;
//   - the resources that folder really needs — local Markdown links read
//     outside fenced code blocks, transitively, with cycle control; a path
//     quoted inside an example is documentation, not a dependency;
//   - the provenance: the licence files the source offers and the record of
//     every byte imported or link rewritten.
//
// What it refuses instead of guessing: a reference that escapes the source, a
// symlink, a collision in the imported tree, a target that does not resolve,
// and a needed resource that embeds ANOTHER operational skill — that one comes
// back as an expansion the person has to choose, never as a hidden extra.
//
// It never executes anything it acquired. It reads, digests and copies.

import type { Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scanMarkdown } from "../markdown.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { hasValidFrontmatter } from "./install-plugin-skills.js";
import type { AcquiredSource, SkillCandidate } from "./skills-discovery.js";
import { skillFrontmatterName } from "./skills-manager.js";

const MANIFEST = "SKILL.md";
/** Where an auxiliary resource from outside the folder lands, identified. */
export const IMPORTED_DIR = join("references", "workline-imported");
/** Where the source's licence and this record of the acquisition land. */
export const PROVENANCE_DIR = join("references", "workline-provenance");
const PROVENANCE_FILE = "PROVENANCE.md";
const LICENCE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE)(\..+)?$/i;
/** A payload wider than this is a source that needs a narrower selection. */
const MAX_PAYLOAD_FILES = 2000;

export interface PayloadFile {
  /** Path relative to the skill's own root. */
  path: string;
  bytes: number;
  digest: string;
}

export interface PreparedLicence {
  /** Where it was found, relative to the source root. */
  from: string;
  /** Where it lands inside the payload. */
  to: string;
  digest: string;
}

export interface ImportedResource {
  /** Path relative to the source root. */
  from: string;
  /** Path relative to the skill's own root. */
  to: string;
  digest: string;
}

export interface LinkRewrite {
  /** Payload-relative Markdown file whose link was adjusted. */
  file: string;
  from: string;
  to: string;
}

/** A reference satisfied by ANOTHER skill of the same selection: both land as
 *  siblings under the managed root, so the link is re-pointed there instead of
 *  copying somebody else's bytes in. */
export interface SiblingReference {
  skill: string;
  from: string;
  to: string;
}

export interface SkillProvenance {
  source: string;
  requestedRef: string | null;
  resolvedRef: string | null;
  /** Path inside the source the selection resolved. */
  path: string;
  directory: string;
  licences: PreparedLicence[];
  imported: ImportedResource[];
  rewrites: LinkRewrite[];
  /** References another chosen skill answers — declared, never hidden. */
  siblings: SiblingReference[];
  /** What this analysis could NOT see. A limit, never a clean bill of health. */
  notes: string[];
}

export interface PreparedSkill {
  /** Invocable identity the payload declares. */
  name: string;
  path: string;
  /** Absolute staging dir — outside every host discovery root. */
  stagedAt: string;
  files: PayloadFile[];
  /** Every SKILL.md the payload materializes: its operational identities. */
  manifests: { path: string; name: string }[];
  provenance: SkillProvenance;
  /** Seal over the inventory — what freezes a local source too. */
  digest: string;
}

export interface RequiredExpansion {
  /** The operational skill a needed resource belongs to. */
  name: string;
  /** Its path inside the source: what the selection has to add. */
  path: string;
  reason: string;
}

export interface PayloadRejection {
  code: string;
  message: string;
}

export type PayloadOutcome =
  | { status: "prepared"; skills: PreparedSkill[] }
  | { status: "needs-expansion"; expansions: RequiredExpansion[] }
  | { status: "rejected"; rejection: PayloadRejection };

/** The directories of a source that are skills in their own right. */
function skillDirsOf(candidates: readonly SkillCandidate[]): Map<string, SkillCandidate> {
  return new Map(candidates.map((c) => [c.path, c]));
}

/** The skill a source-relative path belongs to, other than `own`. */
function owningSkill(
  relPath: string,
  skillDirs: Map<string, SkillCandidate>,
  own: string,
): SkillCandidate | null {
  let cursor = relPath;
  while (cursor !== "" && cursor !== ".") {
    cursor = cursor.includes("/") ? cursor.slice(0, cursor.lastIndexOf("/")) : "";
    const found = skillDirs.get(cursor);
    if (found && found.path !== own) return found;
  }
  const root = skillDirs.get("");
  return root && root.path !== own ? root : null;
}

interface WalkedPayload {
  files: string[];
  /** Other skills found inside, excluded unless a resource needs them. */
  excluded: string[];
  truncated: boolean;
}

/**
 * The payload's own files: everything under the folder except the subtrees
 * that carry a SKILL.md of their own. Symlinks are skipped, never followed.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the walk is one traversal with one budget and one early exit; splitting the loop from its accumulators would put the truncation rule in a different place from the walk it truncates.
async function walkPayload(dir: string, ownRel: string): Promise<WalkedPayload> {
  const files: string[] = [];
  const excluded: string[] = [];
  let truncated = false;
  const pending: string[] = [dir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_PAYLOAD_FILES) {
        truncated = true;
        return { files: files.sort(), excluded: excluded.sort(), truncated };
      }
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      const verdict = await payloadEntry(entry, full);
      if (verdict === "file") files.push(rel);
      else if (verdict === "descend") pending.push(full);
      else if (verdict === "other-skill") excluded.push(ownRel === "" ? rel : `${ownRel}/${rel}`);
    }
  }
  return { files: files.sort(), excluded: excluded.sort(), truncated };
}

/**
 * What the walk does with one entry.
 *
 * A directory carrying its own manifest is ANOTHER skill: the payload of a
 * root stops there instead of dragging it along. A link's `Dirent` is neither
 * a directory nor a file, so it falls through to `skip` — which is how a
 * payload never carries one.
 */
async function payloadEntry(
  entry: Dirent,
  full: string,
): Promise<"file" | "descend" | "other-skill" | "skip"> {
  if (entry.isFile()) return "file";
  if (!entry.isDirectory()) return "skip";
  if (entry.name === ".git" || entry.name === "node_modules") return "skip";
  const manifest = await readFile(join(full, MANIFEST), "utf8").catch(() => null);
  return manifest !== null && hasValidFrontmatter(manifest) ? "other-skill" : "descend";
}

/** Link targets a Markdown document really declares: outside fenced code. */
export function markdownLinkTargets(text: string): string[] {
  const scan = scanMarkdown(text);
  const targets: string[] = [];
  const inline = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const reference = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
  for (const [index, line] of scan.lines.entries()) {
    if (scan.fenced[index]) continue;
    for (const match of line.matchAll(inline)) {
      if (match[1]) targets.push(match[1]);
    }
    const ref = reference.exec(line);
    if (ref?.[1]) targets.push(ref[1]);
  }
  return targets;
}

/** A target that points at another file of this source, or nothing to chase. */
function localTarget(raw: string): string | null {
  const target = raw.split("#")[0]?.trim() ?? "";
  if (target.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith("//") || isAbsolute(target)) return null;
  return decodeURI(target);
}

interface ResourceContext {
  acquired: AcquiredSource;
  skillDirs: Map<string, SkillCandidate>;
  own: SkillCandidate;
  /** Paths of the WHOLE selection: what a cross-skill reference may rely on. */
  chosen: Map<string, SkillCandidate>;
  payloadDir: string;
  stagedDir: string;
}

interface ResourceOutcome {
  imported: ImportedResource[];
  rewrites: LinkRewrite[];
  siblings: SiblingReference[];
  expansions: RequiredExpansion[];
  rejection: PayloadRejection | null;
}

/** What a reference outside the payload turns out to be. */
type TargetVerdict =
  | { kind: "sibling"; sibling: SiblingReference }
  | { kind: "expansion"; expansion: RequiredExpansion }
  | { kind: "import"; sourceRel: string; destRel: string; absolute: string }
  | { kind: "rejection"; rejection: PayloadRejection };

/**
 * A staged document and where it came FROM inside the source.
 *
 * The origin is what a relative link is resolved against, and it is not the
 * staged location: an imported resource sits under `references/…` in the
 * payload while its own links still mean what they meant where it was
 * written. Resolving those from the staged path was chasing files that never
 * existed.
 */
interface StagedDocument {
  /** Payload-relative path of the staged file. */
  file: string;
  /** Source-relative directory the document was written in. */
  originDir: string;
}

/** Where a target points, decided before anything is copied or rewritten. */
async function classifyTarget(
  ctx: ResourceContext,
  doc: StagedDocument,
  raw: string,
  target: string,
): Promise<TargetVerdict | null> {
  const file = doc.file;
  const sourceRoot = resolve(ctx.acquired.root);
  const absoluteTarget = resolve(sourceRoot, doc.originDir, target);
  const ownRoot = resolve(sourceRoot, ctx.own.path);
  const insidePayload = relative(ownRoot, absoluteTarget);
  // Already part of this payload: it was staged with the folder.
  if (!insidePayload.startsWith("..") && !isAbsolute(insidePayload)) return null;

  const insideSource = relative(sourceRoot, absoluteTarget);
  if (insideSource.startsWith("..") || isAbsolute(insideSource)) {
    return {
      kind: "rejection",
      rejection: {
        code: "RESOURCE_OUTSIDE_SOURCE",
        message: `'${file}' referencia '${raw}', que queda fuera del origen: no se puede preservar`,
      },
    };
  }
  const sourceRel = insideSource.split(sep).join("/");
  const other = owningSkill(sourceRel, ctx.skillDirs, ctx.own.path);
  if (other === null) return classifyImport(ctx, file, raw, sourceRel);
  // Not chosen → the person has to choose it; nothing is copied in. Chosen →
  // both install as siblings of the managed root, so the link is re-pointed at
  // that layout instead of duplicating somebody else's bytes.
  if (!ctx.chosen.has(other.path)) {
    return {
      kind: "expansion",
      expansion: {
        name: other.name,
        path: other.path,
        reason: `'${file}' necesita '${sourceRel}', que pertenece a la skill '${other.name}'`,
      },
    };
  }
  const insideOther = other.path === "" ? sourceRel : sourceRel.slice(other.path.length + 1);
  return {
    kind: "sibling",
    sibling: { skill: other.name, from: raw, to: `../${other.name}/${insideOther}` },
  };
}

/** A plain auxiliary resource: it has to exist, be a file, and be no link. */
async function classifyImport(
  ctx: ResourceContext,
  file: string,
  raw: string,
  sourceRel: string,
): Promise<TargetVerdict> {
  const reject = (code: string, message: string): TargetVerdict => ({
    kind: "rejection",
    rejection: { code, message },
  });
  const materialized = await ctx.acquired.materializeFile(sourceRel);
  const stats = materialized === null ? null : await lstat(materialized).catch(() => null);
  if (materialized === null || stats === null) {
    return reject("RESOURCE_UNRESOLVED", `'${file}' referencia '${raw}' y no existe en el origen`);
  }
  if (stats.isSymbolicLink()) {
    return reject(
      "RESOURCE_IS_SYMLINK",
      `'${file}' referencia '${raw}', que es un enlace simbólico`,
    );
  }
  if (stats.isDirectory()) {
    return reject(
      "RESOURCE_IS_DIRECTORY",
      `'${file}' referencia el directorio '${raw}': declaralo como selección, no como recurso`,
    );
  }
  return {
    kind: "import",
    sourceRel,
    destRel: `${IMPORTED_DIR.split(sep).join("/")}/${sourceRel}`,
    absolute: materialized,
  };
}

/** Copies an imported resource once, refusing a collision. */
async function importResource(
  ctx: ResourceContext,
  verdict: Extract<TargetVerdict, { kind: "import" }>,
  out: ResourceOutcome,
): Promise<{ queued: string | null } | PayloadRejection> {
  if (out.imported.some((entry) => entry.to === verdict.destRel)) return { queued: null };
  const destAbs = join(ctx.stagedDir, verdict.destRel);
  if (await lstat(destAbs).catch(() => null)) {
    return {
      code: "RESOURCE_COLLISION",
      message: `'${verdict.destRel}' ya existe en el payload: la importación colisionaría`,
    };
  }
  await mkdir(dirname(destAbs), { recursive: true });
  await copyFile(verdict.absolute, destAbs);
  const content = await readFile(destAbs);
  out.imported.push({
    from: verdict.sourceRel,
    to: verdict.destRel,
    digest: semanticDigest(content.toString("utf8")),
  });
  return { queued: verdict.destRel.toLowerCase().endsWith(".md") ? verdict.destRel : null };
}

/**
 * Chases the references of every Markdown file already staged, transitively.
 *
 * A reference INSIDE the payload is already there. One outside it but inside
 * the source is imported under a path that says where it came from, and only
 * its own unambiguous link is rewritten. One that belongs to another skill is
 * an expansion to choose — or, when that skill is part of the same selection,
 * a sibling link. Anything else refuses.
 */
async function resolveResources(ctx: ResourceContext, staged: string[]): Promise<ResourceOutcome> {
  const out: ResourceOutcome = {
    imported: [],
    rewrites: [],
    siblings: [],
    expansions: [],
    rejection: null,
  };
  const seen = new Set<string>();
  // A payload file's origin is its own place inside the source; an imported
  // one carries the directory it was written in (see `StagedDocument`).
  const queue: StagedDocument[] = staged
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .map((file) => {
      const slash = file.lastIndexOf("/");
      const within = slash === -1 ? "" : file.slice(0, slash);
      const originDir = [ctx.own.path, within].filter((part) => part !== "").join("/");
      return { file, originDir };
    });

  while (queue.length > 0) {
    const doc = queue.shift();
    if (doc === undefined || seen.has(doc.file)) continue;
    seen.add(doc.file);
    const absolute = join(ctx.stagedDir, doc.file);
    const text = await readFile(absolute, "utf8").catch(() => null);
    if (text === null) continue;
    const rewritten = await resolveOneDocument(ctx, doc, text, out, queue);
    if (out.rejection !== null) return out;
    if (rewritten !== text) await writeFile(absolute, rewritten, "utf8");
  }
  return out;
}

/** What applying a verdict leaves behind: the link to write, if any. */
async function applyVerdict(
  ctx: ResourceContext,
  doc: StagedDocument,
  verdict: Exclude<TargetVerdict, { kind: "rejection" }>,
  out: ResourceOutcome,
  queue: StagedDocument[],
): Promise<{ link: string | null } | PayloadRejection> {
  if (verdict.kind === "expansion") {
    out.expansions.push(verdict.expansion);
    return { link: null };
  }
  if (verdict.kind === "sibling") {
    out.siblings.push(verdict.sibling);
    return { link: verdict.sibling.to };
  }
  const imported = await importResource(ctx, verdict, out);
  if ("code" in imported) return imported;
  if (imported.queued !== null) {
    const slash = verdict.sourceRel.lastIndexOf("/");
    queue.push({
      file: imported.queued,
      originDir: slash === -1 ? "" : verdict.sourceRel.slice(0, slash),
    });
  }
  return {
    link: relative(dirname(join(ctx.stagedDir, doc.file)), join(ctx.stagedDir, verdict.destRel))
      .split(sep)
      .join("/"),
  };
}

/**
 * Replaces a link ONLY where it is a link.
 *
 * The same string inside a fenced block is documentation about a path, and
 * rewriting it there would edit an example nobody asked to change.
 */
function rewriteOutsideFences(
  text: string,
  raw: string,
  link: string,
): { text: string; changed: boolean } {
  const scan = scanMarkdown(text);
  let changed = false;
  const lines = scan.lines.map((line, index) => {
    if (scan.fenced[index] || !line.includes(raw)) return line;
    changed = true;
    return line.split(raw).join(link);
  });
  return { text: changed ? lines.join("\n") : text, changed };
}

/** One document's references, applied to its text. */
async function resolveOneDocument(
  ctx: ResourceContext,
  doc: StagedDocument,
  text: string,
  out: ResourceOutcome,
  queue: StagedDocument[],
): Promise<string> {
  let rewritten = text;
  for (const raw of markdownLinkTargets(text)) {
    const target = localTarget(raw);
    if (target === null) continue;
    const verdict = await classifyTarget(ctx, doc, raw, target);
    if (verdict === null) continue;
    if (verdict.kind === "rejection") {
      out.rejection = verdict.rejection;
      return rewritten;
    }
    const applied = await applyVerdict(ctx, doc, verdict, out, queue);
    if ("code" in applied) {
      out.rejection = applied;
      return rewritten;
    }
    if (applied.link === null) continue;
    const swap = rewriteOutsideFences(rewritten, raw, applied.link);
    if (swap.changed) {
      rewritten = swap.text;
      out.rewrites.push({ file: doc.file, from: raw, to: applied.link });
    }
  }
  return rewritten;
}

/**
 * Licence files the source offers for this skill: its folder and every ancestor
 * INSIDE the source.
 *
 * The candidates come from the source's own listing rather than the working
 * copy: over a sparse clone the licence is in the commit and not yet on disk,
 * and reading the disk there would report "no licence" about a repo that has
 * one — the worst possible way to be wrong about a licence.
 */
async function collectLicences(
  acquired: AcquiredSource,
  ownPath: string,
  stagedDir: string,
): Promise<PreparedLicence[]> {
  const ancestors = new Set<string>([""]);
  const segments = ownPath === "" ? [] : ownPath.split("/");
  for (let i = 1; i <= segments.length; i++) ancestors.add(segments.slice(0, i).join("/"));

  const licences: PreparedLicence[] = [];
  const paths = (await acquired.listPaths()).filter((path) => isLicenceOf(path, ancestors));
  for (const path of paths) {
    const materialized = await acquired.materializeFile(path);
    const content =
      materialized === null ? null : await readFile(materialized, "utf8").catch(() => null);
    if (content === null) continue;
    const to = `${PROVENANCE_DIR.split(sep).join("/")}/${path.split("/").join("_")}`;
    await mkdir(join(stagedDir, PROVENANCE_DIR), { recursive: true });
    await writeFile(join(stagedDir, to), content, "utf8");
    licences.push({ from: path, to, digest: semanticDigest(content) });
  }
  return licences;
}

/** A licence file sitting in the skill's folder or one of its ancestors. */
function isLicenceOf(path: string, ancestors: ReadonlySet<string>): boolean {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  const file = slash === -1 ? path : path.slice(slash + 1);
  return ancestors.has(dir) && LICENCE_RE.test(file);
}

/** One `##` section, or nothing when there is nothing to say. */
function provenanceSection(title: string, rows: readonly string[]): string[] {
  return rows.length === 0 ? [] : ["", `## ${title}`, "", ...rows];
}

function provenanceDocument(provenance: SkillProvenance, name: string): string {
  const licences =
    provenance.licences.length > 0
      ? provenanceSection(
          "Licence files preserved",
          provenance.licences.map((licence) => `- ${licence.from} → ${licence.to}`),
        )
      : ["", "No LICENSE, COPYING or NOTICE file was offered by the source for this path."];
  return `${[
    `# Provenance — ${name}`,
    "",
    "Written by Workline when this skill was prepared. It records where the bytes",
    "came from and what was changed to keep them usable; it certifies nothing about",
    "the skill's behaviour or safety.",
    "",
    `- Source: ${provenance.source}`,
    `- Requested ref: ${provenance.requestedRef ?? "(default branch)"}`,
    `- Resolved commit: ${provenance.resolvedRef ?? "(local source — frozen by payload digest)"}`,
    `- Path in source: ${provenance.path === "" ? "(source root)" : provenance.path}`,
    `- Directory: ${provenance.directory}`,
    ...licences,
    ...provenanceSection(
      "Resources imported from outside the folder",
      provenance.imported.map((item) => `- ${item.from} → ${item.to}`),
    ),
    ...provenanceSection(
      "References answered by another installed skill",
      provenance.siblings.map(
        (item) => `- \`${item.from}\` → \`${item.to}\` (skill \`${item.skill}\`)`,
      ),
    ),
    ...provenanceSection(
      "Markdown links adjusted",
      provenance.rewrites.map((item) => `- ${item.file}: \`${item.from}\` → \`${item.to}\``),
    ),
    ...provenanceSection(
      "Limits of this record",
      provenance.notes.map((note) => `- ${note}`),
    ),
  ].join("\n")}\n`;
}

/** Bytes and digest of every staged file — the inventory that seals a payload. */
async function inventoryOf(stagedDir: string): Promise<PayloadFile[]> {
  const walked = await walkPayloadFlat(stagedDir);
  const files: PayloadFile[] = [];
  for (const rel of walked) {
    const content = await readFile(join(stagedDir, rel));
    files.push({
      path: rel,
      bytes: content.byteLength,
      digest: semanticDigest(content.toString("base64")),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every file of a staged payload, nested skills included: this is the list a
 *  host would discover, so it is the list the inventory has to show. */
async function walkPayloadFlat(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  await visit(dir);
  return out.sort();
}

/** The operational identities a payload materializes, whatever their depth. */
async function manifestsOf(stagedDir: string, files: readonly PayloadFile[]) {
  const manifests: { path: string; name: string }[] = [];
  for (const file of files) {
    if (file.path !== MANIFEST && !file.path.endsWith(`/${MANIFEST}`)) continue;
    const content = await readFile(join(stagedDir, file.path), "utf8").catch(() => null);
    if (content === null || !hasValidFrontmatter(content)) continue;
    manifests.push({
      path: file.path,
      name: skillFrontmatterName(content) ?? basename(dirname(file.path)),
    });
  }
  return manifests;
}

async function copyPayloadFiles(from: string, to: string, files: readonly string[]): Promise<void> {
  for (const rel of files) {
    const dest = join(to, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(from, rel), dest);
  }
}

/** What the payload could NOT establish, said as limits. */
function payloadNotes(
  walked: WalkedPayload,
  licences: readonly PreparedLicence[],
  resources: ResourceOutcome,
): string[] {
  const notes: string[] = [];
  if (walked.excluded.length > 0) {
    notes.push(`Subárboles excluidos por ser otras skills: ${walked.excluded.join(", ")}.`);
  }
  if (licences.length === 0) {
    notes.push("El origen no ofreció archivo de licencia para esta ruta.");
  }
  if (resources.siblings.length > 0) {
    notes.push(
      `Referencias que resuelve otra skill elegida: ${resources.siblings
        .map((item) => item.skill)
        .join(", ")}. Ambas quedan como hermanas de la raíz administrada.`,
    );
  }
  notes.push("Se leyeron enlaces Markdown y archivos; no se ejecutó ni analizó código adquirido.");
  return notes;
}

/**
 * Stages the payload of each selected path.
 *
 * The order is the contract: materialize the folder, copy only its own files,
 * chase its resources, collect provenance, and only then inventory and seal.
 * An expansion or a rejection stops before anything is sealed, so a partial
 * selection never comes back looking complete.
 */
export async function preparePayloads(
  acquired: AcquiredSource,
  selection: readonly SkillCandidate[],
  stagingRoot: string,
): Promise<PayloadOutcome> {
  const skillDirs = skillDirsOf(acquired.inventory.candidates);
  const chosen = new Map(selection.map((candidate) => [candidate.path, candidate]));
  const skills: PreparedSkill[] = [];
  const expansions: RequiredExpansion[] = [];

  for (const candidate of selection) {
    const payloadDir = await acquired.materialize(candidate.path);
    const walked = await walkPayload(payloadDir, candidate.path);
    // A truncated walk is a payload nobody can materialize WHOLE, and the
    // contract for that is refusal — a note saying "this list is a floor"
    // would still let an incomplete skill be installed as if it were complete.
    if (walked.truncated) {
      return {
        status: "rejected",
        rejection: {
          code: "PAYLOAD_TRUNCATED",
          message: `'${candidate.path || "."}' no se pudo recorrer completo (límite de ${MAX_PAYLOAD_FILES} archivos o un directorio ilegible): no se puede preservar íntegro`,
        },
      };
    }
    if (walked.files.length === 0) {
      return {
        status: "rejected",
        rejection: {
          code: "PAYLOAD_EMPTY",
          message: `'${candidate.path || "."}' no aporta ningún archivo propio`,
        },
      };
    }
    const stagedDir = join(stagingRoot, candidate.name);
    await mkdir(stagedDir, { recursive: true });
    await copyPayloadFiles(payloadDir, stagedDir, walked.files);

    const resources = await resolveResources(
      { acquired, skillDirs, own: candidate, chosen, payloadDir, stagedDir },
      walked.files,
    );
    if (resources.rejection !== null) {
      return { status: "rejected", rejection: resources.rejection };
    }
    if (resources.expansions.length > 0) {
      expansions.push(...resources.expansions);
      continue;
    }

    const licences = await collectLicences(acquired, candidate.path, stagedDir);
    const notes = payloadNotes(walked, licences, resources);
    const provenance: SkillProvenance = {
      source: acquired.inventory.source,
      requestedRef: acquired.inventory.requestedRef,
      resolvedRef: acquired.inventory.resolvedRef,
      path: candidate.path,
      directory: candidate.directory,
      licences,
      imported: resources.imported,
      rewrites: resources.rewrites,
      siblings: resources.siblings,
      notes,
    };
    await mkdir(join(stagedDir, PROVENANCE_DIR), { recursive: true });
    await writeFile(
      join(stagedDir, PROVENANCE_DIR, PROVENANCE_FILE),
      provenanceDocument(provenance, candidate.name),
      "utf8",
    );

    const files = await inventoryOf(stagedDir);
    const manifests = await manifestsOf(stagedDir, files);
    skills.push({
      name: candidate.name,
      path: candidate.path,
      stagedAt: stagedDir,
      files,
      manifests,
      provenance,
      digest: semanticDigest({
        name: candidate.name,
        path: candidate.path,
        source: provenance.source,
        resolved_ref: provenance.resolvedRef,
        files: files.map((f) => ({ path: f.path, bytes: f.bytes, digest: f.digest })),
        manifests,
      }),
    });
  }

  // An expansion is a REQUIRED choice: nothing partial is returned as prepared.
  if (expansions.length > 0) return { status: "needs-expansion", expansions };
  return { status: "prepared", skills };
}
