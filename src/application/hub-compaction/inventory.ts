import { basename, join } from "node:path";
import type { ArchivePort } from "../../ports/archive.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import {
  type AgentWorkflowIndex,
  type IndexedPlan,
  buildAgentWorkflowIndex,
  planIsPending,
} from "../agent-workflow-index-service.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
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
  kind: "documentation" | "other";
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
const TEXT_LIMIT = 1024 * 1024;

function entryKind(path: string): InventoryEntry["kind"] {
  return path.startsWith("docs/") ? "documentation" : "other";
}

/** Only `docs/` is walked: the documents are the hub's whole record (spec 066, AC-14). */
async function walk(deps: CompactionDeps, path: string, entries: InventoryEntry[]): Promise<void> {
  const absolute = join(deps.paths.hubDir(), path);
  if (!(await deps.fs.exists(absolute))) return;
  for (const item of (await deps.fs.list(absolute)).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${path}/${item.name}`;
    if (rel === catalogRelative(deps.paths)) continue;
    const stat = await deps.fs.lstat(item.path);
    const excluded =
      stat?.isSymlink ||
      SKIP.has(item.name) ||
      SENSITIVE.test(item.name) ||
      (item.type === "dir" && (await deps.fs.lstat(join(item.path, ".git"))) !== null);
    if (excluded || item.type === "other") {
      entries.push({
        path: rel,
        kind: entryKind(rel),
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
      kind: entryKind(rel),
      disposition: "protected",
      reason: "Sin elegibilidad demostrada; se conserva en sitio",
      ...identity,
    });
  }
}

/**
 * The specs and plans of `docs/` that are history: a plan `done` that owes
 * nothing (no live handoff, no pending pass) or `abandoned`; a spec abandoned or
 * superseded, or one whose every plan is history. Derived from the documents
 * model of the board, which never opens a session.
 */
function historicalDocuments(index: AgentWorkflowIndex): Map<string, string> {
  const out = new Map<string, string>();
  const historical = (plan: IndexedPlan) =>
    plan.plan_state === "abandoned" || (plan.plan_state === "done" && !planIsPending(plan));
  for (const plan of index.plans) {
    if (historical(plan)) out.set(plan.file, `Plan ${plan.plan_state} sin deuda viva`);
  }
  for (const spec of index.specs) {
    const plans = index.plans.filter(
      (plan) => plan.spec.status === "resolved" && plan.spec.number === spec.number,
    );
    if (spec.status === "abandoned" || spec.status === "superseded") {
      out.set(spec.file, `Spec ${spec.status}`);
    } else if (plans.length > 0 && plans.every(historical)) {
      out.set(spec.file, "Spec con todos sus planes históricos");
    }
  }
  return out;
}

async function classify(deps: CompactionDeps, entries: InventoryEntry[], limits: string[]) {
  const hazardous = entries.some(
    (e) => e.disposition === "excluded" || (controlFile(e.path) && (e.bytes ?? 0) > TEXT_LIMIT),
  );
  if (hazardous) {
    limits.push("Procedencia no evaluada: enlaces o controles fuera del límite de lectura");
    return [];
  }
  const index = await buildAgentWorkflowIndex(deps.fs, deps.env, deps.paths);
  const historical = historicalDocuments(index);
  const candidates = entries.filter((e) => historical.has(e.path));
  const referenced = await manualReferences(deps, entries, candidates, limits);
  if (referenced === null) return [];
  for (const e of candidates) {
    if (referenced.has(e.path)) {
      e.reason =
        "Referencia manual desde un documento vivo; se conserva para mantener su resolución";
      continue;
    }
    e.disposition = "eligible";
    e.reason = `${historical.get(e.path)}; sin referencias desde documentos vivos`;
  }
  // The dispositions already carry the provenance; a separate list would change
  // the moment an archived original leaves docs/ and stall its own recovery.
  return [];
}

function controlFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.startsWith(".") || /\.(?:sql|json|toml)$/iu.test(name);
}

/** Live documents that name a candidate keep it in place; history may name history. */
async function manualReferences(
  deps: CompactionDeps,
  entries: InventoryEntry[],
  candidates: InventoryEntry[],
  limits: string[],
) {
  const referenced = new Set<string>();
  const archived = new Set(candidates.map((candidate) => candidate.path));
  for (const e of entries) {
    if (archived.has(e.path) || e.path === "docs/context/hub.md") continue;
    if (e.disposition === "excluded" || !/\.(?:md|txt|json|toml)$/iu.test(e.path)) continue;
    if ((e.bytes ?? 0) > TEXT_LIMIT) {
      limits.push(`Referencias manuales sin interpretar: ${e.path} excede ${TEXT_LIMIT} bytes`);
      return null;
    }
    const text = await deps.fs.readText(join(deps.paths.hubDir(), e.path));
    for (const candidate of candidates) {
      if (mentionsOriginal(text, e.path, candidate.path)) referenced.add(candidate.path);
    }
  }
  return referenced;
}

function mentionsOriginal(text: string, source: string, target: string): boolean {
  return source !== target && (text.includes(target) || text.includes(basename(target)));
}

export async function inventoryHub(deps: CompactionDeps): Promise<HubInventory> {
  const entries: InventoryEntry[] = [];
  await walk(deps, "docs", entries);
  const limitations = [
    "Sólo se recorre docs/; no se interpreta configuración sensible ni contenido binario",
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
        ...entries.filter((e) => e.disposition === "excluded").map((e) => e.path),
      ],
    },
    context: { bytes, tokens: null, reason: "Bytes inventariados; tokens no medidos" },
  };
}
