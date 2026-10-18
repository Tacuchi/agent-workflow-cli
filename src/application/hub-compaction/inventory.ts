import { basename, join } from "node:path";
import type { ArchivePort } from "../../ports/archive.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { ARTIFACT_FILENAMES } from "../session-artifacts.js";
import { type BuiltWorklineGraph, buildWorklineGraph } from "../workline-graph.js";
import { catalogRelative, inside } from "./paths.js";

export interface CompactionDeps {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  archive: ArchivePort;
  git?: GitPort;
}

export interface InventoryEntry {
  path: string;
  kind: "documentation" | "session" | "runtime" | "other";
  disposition: "protected" | "eligible" | "excluded";
  reason: string;
  bytes: number | null;
  sha256: string | null;
}

export interface HubInventory {
  version: 1;
  root: string;
  fingerprint: string;
  entries: InventoryEntry[];
  relationships: unknown[];
  coverage: { partial: boolean; limitations: string[]; exclusions: string[] };
  bytes: number;
  context: { bytes: number; tokens: null; reason: string };
}

const SKIP = new Set([".git", "node_modules", ".ssh", ".aws", ".codex", ".agents", ".claude"]);
const SENSITIVE = /(?:^\.env(?:\.|$)|^\.npmrc$|credential|secret|\.pem$|\.key$)/iu;
const CONTROL = new Set(
  Object.values(ARTIFACT_FILENAMES)
    .flat()
    .map((name) => name.toLowerCase()),
);
const TEXT_LIMIT = 1024 * 1024;

function entryKind(path: string, paths: PathsService): InventoryEntry["kind"] {
  if (path.startsWith("docs/")) return "documentation";
  if (path.startsWith(`.${paths.namespace}/sessions/`)) return "session";
  if (path.startsWith(`.${paths.namespace}/`)) return "runtime";
  return "other";
}

async function walk(deps: CompactionDeps, path: string, entries: InventoryEntry[]): Promise<void> {
  const absolute = path ? join(deps.paths.hubDir(), path) : deps.paths.hubDir();
  for (const item of (await deps.fs.list(absolute)).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path ? `${path}/${item.name}` : item.name;
    if (rel === `${catalogRelative(deps.paths)}` || rel === `.${deps.paths.namespace}/.lock`)
      continue;
    const stat = await deps.fs.lstat(item.path);
    const excluded =
      stat?.isSymlink ||
      SKIP.has(item.name) ||
      SENSITIVE.test(item.name) ||
      (item.type === "dir" && (await deps.fs.lstat(join(item.path, ".git"))) !== null);
    if (excluded || item.type === "other") {
      entries.push({
        path: rel,
        kind: entryKind(rel, deps.paths),
        disposition: "excluded",
        reason: "Enlace, configuración sensible, repositorio externo o catálogo; no recorrido",
        bytes: null,
        sha256: null,
      });
      continue;
    }
    if (item.type === "dir") {
      await walk(deps, rel, entries);
      continue;
    }
    const identity = await deps.archive.identify(await inside(deps.fs, deps.paths.hubDir(), rel));
    entries.push({
      path: rel,
      kind: entryKind(rel, deps.paths),
      disposition: "protected",
      reason: "Sin elegibilidad demostrada; se conserva en sitio",
      ...identity,
    });
  }
}

function sessionEligible(built: BuiltWorklineGraph, path: string): string | null {
  const node = built.graph.all().find((n) => n.session && path.startsWith(`${n.path}/`));
  const facts = node?.session;
  if (
    !node ||
    !facts ||
    facts.state !== "closed" ||
    facts.completion !== "converged" ||
    facts.custody_gap !== null ||
    facts.units.length > 0
  )
    return null;
  const parents = built.graph.parentsOf(node.id);
  if (parents.some((p) => p.evidence !== "custody")) return null;
  const live = built.graph
    .all()
    .filter(
      (n) => n.session && (n.session.state !== "closed" || n.session.completion !== "converged"),
    );
  const links = new Set(parents.map((p) => `${p.to.kind}:${p.to.key}`));
  if (
    live.some((n) => built.graph.parentsOf(n.id).some((p) => links.has(`${p.to.kind}:${p.to.key}`)))
  ) {
    return null;
  }
  if (
    built.index.plans.some(
      (p) =>
        p.plan_state !== "done" &&
        (links.has(`plan:${p.number}`) ||
          (p.spec.status === "resolved" && links.has(`spec:${p.spec.number}`))),
    )
  ) {
    return null;
  }
  if (
    live.some((n) =>
      n.session?.custody?.artifacts.some(
        (a) => a.path === path || a.path === node.path || a.path.startsWith(`${node.path}/`),
      ),
    )
  )
    return null;
  return node.path;
}

function controlFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return CONTROL.has(name) || name.startsWith(".") || /\.(?:sql|json|toml)$/iu.test(name);
}

async function classify(deps: CompactionDeps, entries: InventoryEntry[], limits: string[]) {
  const hazardous = entries.some(
    (e) =>
      (e.disposition === "excluded" && (e.path.startsWith("docs/") || e.kind === "session")) ||
      (controlFile(e.path) && (e.bytes ?? 0) > TEXT_LIMIT),
  );
  if (hazardous) {
    limits.push("Procedencia no evaluada: enlaces o controles fuera del límite de lectura");
    return [];
  }
  const built = await buildWorklineGraph(deps);
  const candidates = entries.filter(
    (e) =>
      e.kind === "session" &&
      e.disposition !== "excluded" &&
      !controlFile(e.path) &&
      sessionEligible(built, e.path),
  );
  const referenced = await manualReferences(deps, entries, candidates, limits);
  if (referenced === null) return built.graph.edges;
  for (const e of candidates) {
    if (referenced.has(e.path)) {
      e.reason = "Referencia manual existente; se conserva para mantener su resolución";
      continue;
    }
    e.disposition = "eligible";
    e.reason =
      "Sesión cerrada y convergente con custodia completa, sin dependencias vivas ni referencias manuales detectadas";
  }
  return [
    ...built.graph.edges,
    ...built.graph
      .all()
      .filter((n) => n.session)
      .map((n) => ({
        path: n.path,
        state: n.session?.state,
        completion: n.session?.completion,
        custody: n.session?.custody?.digest,
        units: n.session?.units,
      })),
  ];
}

async function manualReferences(
  deps: CompactionDeps,
  entries: InventoryEntry[],
  candidates: InventoryEntry[],
  limits: string[],
) {
  const referenced = new Set<string>();
  for (const e of entries) {
    if (e.path === "docs/context/hub.md") continue;
    if (e.disposition === "excluded" || !/\.(?:md|txt|json|toml)$/iu.test(e.path)) continue;
    if ((e.bytes ?? 0) > TEXT_LIMIT) {
      limits.push(`Referencias manuales sin interpretar: ${e.path} excede ${TEXT_LIMIT} bytes`);
      return null;
    }
    const text = await deps.fs.readText(join(deps.paths.hubDir(), e.path));
    for (const candidate of candidates) {
      if (mentionsOriginal(text, e.path, candidate.path)) {
        referenced.add(candidate.path);
      }
    }
  }
  return referenced;
}

function mentionsOriginal(text: string, source: string, target: string): boolean {
  return source !== target && (text.includes(target) || text.includes(basename(target)));
}

export async function inventoryHub(deps: CompactionDeps): Promise<HubInventory> {
  const entries: InventoryEntry[] = [];
  await walk(deps, "", entries);
  const limitations = [
    "No se interpreta configuración sensible ni contenido binario; elegibilidad conservadora de archivos de sesiones",
    "Documentos normativos y artefactos canónicos de control y exports permanecen en sitio",
  ];
  const relationships = await classify(deps, entries, limitations);
  const bytes = entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  return {
    version: 1,
    root: deps.paths.hubDir(),
    entries,
    relationships,
    fingerprint: semanticDigest({ entries, relationships }),
    bytes,
    coverage: {
      partial: true,
      limitations,
      exclusions: [
        catalogRelative(deps.paths),
        `.${deps.paths.namespace}/.lock`,
        ...entries.filter((e) => e.disposition === "excluded").map((e) => e.path),
      ],
    },
    context: { bytes, tokens: null, reason: "Bytes inventariados; tokens no medidos" },
  };
}
