import { join } from "node:path";
import { CORRELATIVE_SOURCE, compareCorrelatives } from "../domain/correlative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { runNextNumber } from "./dev-only-services.js";
import { type CoreDocsCanon, resolveCoreDocsCanon } from "./docs-canon-service.js";
import { withCwdLock } from "./lock-service.js";
import { firstNonEmptyLine, parseMdSectionBilingual } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import {
  type SemanticFailure,
  type SemanticParse,
  type SemanticRequest,
  type SemanticResponse,
  approvalDigest,
  buildSemanticRequest,
  parseSemanticResponse,
  semanticDigest,
} from "./semantic-operation/protocol.js";
import { publishArtifacts } from "./semantic-operation/publish.js";

/**
 * `persist` — adopt finished conversation work into `docs/` in one pass.
 *
 * The AI owns exactly one step: deciding the shape (analysis / requirement /
 * plan) and writing the document. Everything that can silently do damage —
 * the inventory, the duplicate check, the number, the destination, whether an
 * existing file may be replaced, and the write itself — stays here.
 *
 * It never creates a session: sessions belong to loops.
 */

const CATEGORIES = {
  research: { infix: "research" },
  spec: { infix: "spec" },
  plan: { infix: "plan" },
} as const;

export type PersistCategory = keyof typeof CATEGORIES;

type PersistCategoryLayout = Record<PersistCategory, { dir: string; infix: string }>;

const OPERATION = "persist";
const LIMITS = { max_artifacts: 1, max_artifact_bytes: 256 * 1024 };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CONTRACT = [
  "Respondé UN objeto JSON con: version, operation, input_digest (los tres copiados del request),",
  "state ('proposed' | 'ambiguous' | 'unsupported'),",
  "decisions { category: 'research'|'spec'|'plan', slug: kebab-case, mode: 'new'|'update',",
  "target?: ruta existente cuando mode='update', target_digest?: su digest del inventario },",
  "y artifacts: exactamente UN { path, content }. El path va dentro del destino de la categoría",
  "y su NNN es consultivo: el CLI reasigna el número dentro del lock.",
  "Si el contenido ya existe como documento, respondé state='ambiguous' con reason.",
].join(" ");

export interface PersistDoc {
  file: string;
  number: string;
  slug: string;
  /** First line of `## Objective`/`## Origin`, or the title — for duplicate awareness. */
  summary: string;
  digest: string;
}

export interface PersistInventory {
  categories: Record<PersistCategory, { destination: string; next: string; docs: PersistDoc[] }>;
}

export interface PersistDecisions {
  category: PersistCategory;
  slug: string;
  mode: "new" | "update";
  target?: string;
  target_digest?: string;
}

export interface PersistPreview {
  category: PersistCategory;
  mode: "new" | "update";
  destination: string;
  bytes: number;
  /** `null` on `new`: the real number is minted inside the lock at apply. */
  target: string | null;
}

export interface PersistValidation {
  preview: PersistPreview;
  approval_digest: string;
}

export interface PersistApplied {
  written: string[];
  category: PersistCategory;
  mode: "new" | "update";
}

// ── prepare ──────────────────────────────────────────────────────────────────

export async function preparePersist(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
): Promise<SemanticParse<SemanticRequest>> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) return { ok: false, failure: canonFailure(canon.error) };
  const categories = persistLayout(canon.canon);
  const cwd = paths.workspaceDir();
  const inventory: PersistInventory = { categories: emptyCategories(categories) };
  const readSet: string[] = [];
  let readSetBytes = 0;

  for (const [name, category] of Object.entries(categories) as Array<
    [PersistCategory, PersistCategoryLayout[PersistCategory]]
  >) {
    const next = await runNextNumber(fs, env, paths, { directory: category.dir, dryRun: true });
    const docs = await readCategory(fs, join(cwd, category.dir), category.dir, category.infix);
    for (const doc of docs) {
      readSet.push(doc.file);
      readSetBytes += doc.summary.length;
    }
    inventory.categories[name] = { destination: category.dir, next: next.next, docs };
  }

  return {
    ok: true,
    value: buildSemanticRequest({
      operation: OPERATION,
      // The seal covers the whole inventory: a document appearing anywhere in
      // docs/ between prepare and apply invalidates the duplicate check AND the
      // consultative numbering the answer reasoned over.
      inputs: inventory,
      contract: CONTRACT,
      inventory,
      allowedDestinations: Object.values(categories).map((c) => c.dir),
      limits: LIMITS,
      readSet,
      readSetBytes,
    }),
  };
}

async function readCategory(
  fs: FileSystemPort,
  dir: string,
  relative: string,
  infix: string,
): Promise<PersistDoc[]> {
  if (!(await safeExists(fs, dir))) return [];
  const pattern = new RegExp(`^(${CORRELATIVE_SOURCE})-${infix}(?:-(.+))?\\.md$`, "i");
  const out: PersistDoc[] = [];
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const match = pattern.exec(entry.name);
    if (entry.type !== "file" || !match?.[1]) continue;
    try {
      const text = await fs.readText(entry.path);
      out.push({
        file: `${relative}/${entry.name}`,
        number: match[1],
        slug: match[2] ?? "",
        summary: summarize(text),
        digest: semanticDigest(text),
      });
    } catch {
      // skip unreadable doc
    }
  }
  return out.sort((a, b) => compareCorrelatives(a.number, b.number));
}

function summarize(text: string): string {
  for (const heading of ["Objective", "Origin", "Requirement"]) {
    const section = parseMdSectionBilingual(text, heading);
    const line = section === undefined ? undefined : firstNonEmptyLine(section);
    if (line !== undefined) return line.slice(0, 200);
  }
  return (firstNonEmptyLine(text) ?? "").slice(0, 200);
}

// ── validate ─────────────────────────────────────────────────────────────────

export function validatePersist(
  raw: string,
  request: SemanticRequest,
): SemanticParse<PersistValidation> {
  const parsed = parseSemanticResponse(raw, request);
  if (!parsed.ok) return parsed;

  const decisions = readDecisions(parsed.value, request);
  if (!decisions.ok) return decisions;

  const artifact = parsed.value.artifacts?.[0];
  if (artifact === undefined) {
    return { ok: false, failure: reject("la respuesta no trae ningún artefacto") };
  }

  const category = categoryFromRequest(request, decisions.value.category);
  if (category === null) {
    return { ok: false, failure: canonFailure("el request no declara el destino de la categoría") };
  }
  const shape = checkFilename(artifact.path, category.dir, category.infix, decisions.value.slug);
  if (shape !== null) return { ok: false, failure: shape };

  return {
    ok: true,
    value: {
      preview: {
        category: decisions.value.category,
        mode: decisions.value.mode,
        destination: category.dir,
        bytes: Buffer.byteLength(artifact.content, "utf8"),
        target: decisions.value.mode === "update" ? (decisions.value.target ?? null) : null,
      },
      approval_digest: approvalDigest(parsed.value),
    },
  };
}

function readDecisions(
  response: SemanticResponse,
  request: SemanticRequest,
): SemanticParse<PersistDecisions> {
  const raw = response.decisions;
  if (raw === undefined) return { ok: false, failure: reject("faltan las decisions") };

  const category = raw.category;
  if (typeof category !== "string" || !(category in CATEGORIES)) {
    return { ok: false, failure: reject(`categoría desconocida: ${String(category)}`) };
  }
  const slug = raw.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return { ok: false, failure: reject(`slug inválido: ${String(slug)} (kebab-case, a-z0-9)`) };
  }
  const mode = raw.mode;
  if (mode !== "new" && mode !== "update") {
    return { ok: false, failure: reject(`modo desconocido: ${String(mode)}`) };
  }
  if (mode === "new") {
    return { ok: true, value: { category: category as PersistCategory, slug, mode } };
  }

  // Replacing an existing document needs more than intent: it must name the
  // target AND prove it is the same bytes prepare inventoried.
  const target = raw.target;
  const targetDigest = raw.target_digest;
  if (typeof target !== "string" || typeof targetDigest !== "string") {
    return { ok: false, failure: reject("mode 'update' exige 'target' y 'target_digest'") };
  }
  const inventory = request.inventory as PersistInventory;
  const known = inventory.categories[category as PersistCategory].docs.find(
    (d) => d.file === target,
  );
  if (known === undefined) {
    return { ok: false, failure: reject(`'${target}' no está en el inventario de la categoría`) };
  }
  if (known.digest !== targetDigest) {
    return {
      ok: false,
      failure: {
        code: "SEMANTIC_STALE",
        message: `'${target}' cambió desde el prepare`,
        action: "volvé a correr prepare y revisá el documento antes de reemplazarlo",
      },
    };
  }
  return {
    ok: true,
    value: {
      category: category as PersistCategory,
      slug,
      mode,
      target,
      target_digest: targetDigest,
    },
  };
}

function checkFilename(
  path: string,
  dir: string,
  infix: string,
  slug: string,
): SemanticFailure | null {
  const expected = new RegExp(`^${dir}/${CORRELATIVE_SOURCE}-${infix}-${slug}\\.md$`);
  if (expected.test(path)) return null;
  return reject(`'${path}' no respeta ${dir}/NNN-${infix}-${slug}.md`);
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface PersistApplyInput {
  raw: string;
  request: SemanticRequest;
  approval: string;
}

/**
 * Publishes, and only publishes, what was validated and approved.
 *
 * Everything that can change between validate and here is rechecked INSIDE the
 * lock: the inventory seal, the approval digest, and the number — which is
 * minted here and overwrites the consultative one the answer carried, so two
 * concurrent runs cannot both claim `007`.
 */
export async function applyPersist(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: PersistApplyInput,
): Promise<SemanticParse<PersistApplied>> {
  const validated = validatePersist(input.raw, input.request);
  if (!validated.ok) return validated;
  if (validated.value.approval_digest !== input.approval) {
    return {
      ok: false,
      failure: {
        code: "APPROVAL_MISMATCH",
        message: "el approval digest no corresponde a esta propuesta",
        action: "volvé a correr validate y aprobá el digest que devuelve",
      },
    };
  }

  const parsed = parseSemanticResponse(input.raw, input.request);
  if (!parsed.ok) return parsed;
  const artifact = parsed.value.artifacts?.[0];
  if (artifact === undefined) {
    return { ok: false, failure: reject("la respuesta no trae ningún artefacto") };
  }

  const preview = validated.value.preview;
  const category = categoryFromRequest(input.request, preview.category);
  if (category === null) {
    return { ok: false, failure: canonFailure("el request no declara el destino de la categoría") };
  }
  const result = await withCwdLock(fs, paths, async () => {
    const fresh = await preparePersist(fs, env, paths);
    if (!fresh.ok) return { ok: false as const, failure: fresh.failure };
    if (fresh.value.input_digest !== input.request.input_digest) {
      return {
        ok: false as const,
        failure: {
          code: "SEMANTIC_STALE",
          message: "docs/ cambió entre la aprobación y la escritura",
          action: "volvé a correr prepare: el inventario y la numeración ya no son los aprobados",
        },
      };
    }

    const path =
      preview.mode === "update" && preview.target !== null
        ? preview.target
        : `${category.dir}/${(await runNextNumber(fs, env, paths, { directory: category.dir })).next}-${category.infix}-${slugOf(artifact.path, category.infix)}.md`;

    return await publishArtifacts(fs, paths.workspaceDir(), [{ path, content: artifact.content }], {
      overwrite: preview.mode === "update",
    });
  });

  if ("error" in result) {
    return {
      ok: false,
      failure: {
        code: "LOCK_BUSY",
        message: result.error,
        action: "esperá a que termine la otra operación y volvé a aplicar",
      },
    };
  }
  if (!result.ok) return result;
  return {
    ok: true,
    value: { written: result.value.written, category: preview.category, mode: preview.mode },
  };
}

function slugOf(path: string, infix: string): string {
  return new RegExp(`${CORRELATIVE_SOURCE}-${infix}-(.+)\\.md$`).exec(path)?.[1] ?? "sin-slug";
}

// ── helpers ──────────────────────────────────────────────────────────────────

function emptyCategories(categories: PersistCategoryLayout): PersistInventory["categories"] {
  return {
    research: { destination: categories.research.dir, next: "001", docs: [] },
    spec: { destination: categories.spec.dir, next: "001", docs: [] },
    plan: { destination: categories.plan.dir, next: "001", docs: [] },
  };
}

function persistLayout(canon: CoreDocsCanon): PersistCategoryLayout {
  return {
    research: { dir: canon.research, infix: CATEGORIES.research.infix },
    spec: { dir: canon.spec, infix: CATEGORIES.spec.infix },
    plan: { dir: canon.plan, infix: CATEGORIES.plan.infix },
  };
}

function categoryFromRequest(
  request: SemanticRequest,
  category: PersistCategory,
): { dir: string; infix: string } | null {
  const inventory = request.inventory as PersistInventory;
  const destination = inventory.categories?.[category]?.destination;
  if (typeof destination !== "string") return null;
  return { dir: destination, infix: CATEGORIES[category].infix };
}

function canonFailure(message: string): SemanticFailure {
  return {
    code: "DOCS_CANON_INVALID",
    message,
    action:
      "corregí la tabla [docs] de skills.toml o quitá la entrada para usar el destino por defecto",
  };
}

function reject(message: string): SemanticFailure {
  return {
    code: "SEMANTIC_RESPONSE_INVALID",
    message,
    action: "corregí la respuesta según el 'contract' del request y reenviala",
  };
}

async function safeExists(fs: FileSystemPort, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}
