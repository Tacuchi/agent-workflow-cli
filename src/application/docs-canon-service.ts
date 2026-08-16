import { parse as parseToml } from "smol-toml";
import { type CoreDocsCanon, DEFAULT_CORE_DOCS_CANON } from "../domain/docs-canon.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

/**
 * The workspace's DOCUMENTARY CANON: where each export category publishes.
 *
 * The categories are the tool's (an export owns exactly one folder and that
 * invariant does not move); the FOLDER is the workspace's. A workspace whose
 * canon says `documentacion/manuales` used to get a second, parallel tree next
 * to its own the first time it exported, because the destinations were literals
 * in the policy table.
 *
 * It lives in the `[docs]` table of `skills.toml` — the workspace's only
 * declarative config, already read through the same global → workspace cascade.
 * The alternative was the WORKSPACE block, which is a CLI-RENDERED block: a
 * value there needs a renderer, a parser slot and an upsert path before anyone
 * can write it, and it would still be a second place to look for config.
 *
 * Fail-closed, unlike the skills cascade above it: a role that cannot be
 * resolved falls back to a built-in skill and the workspace still runs, whereas
 * a destination that cannot be resolved would publish a dossier somewhere the
 * author did not mean. A workspace that declares nothing keeps the tool's
 * default and never reads a file that is not there.
 */

/** Every document category the CLI may publish or index. */
export const DOCS_CATEGORIES = [
  "research",
  "spec",
  "plan",
  "decision",
  "diagrams",
  "manuals",
  "reports",
  "scripts",
] as const;

export type DocsCategory = (typeof DOCS_CATEGORIES)[number];

/** The three categories that form Workline's document graph. */
export const CORE_DOC_CATEGORIES = ["research", "spec", "plan"] as const;

/**
 * Categories a workspace may NOT relocate.
 *
 * The three core ones, plus `decision`: a decision note amends the effective
 * contract of a spec its plan was derived from, so flow, status and resume all
 * have to find the same chain. A note tree the workspace could move is a chain
 * one reader finds and another does not — and a contract that half the surfaces
 * can see is worse than no contract at all.
 */
const FIXED_CATEGORIES: ReadonlySet<string> = new Set([...CORE_DOC_CATEGORIES, "decision"]);

export type CoreDocsCategory = (typeof CORE_DOC_CATEGORIES)[number];

export { DEFAULT_CORE_DOCS_CANON } from "../domain/docs-canon.js";
export type { CoreDocsCanon } from "../domain/docs-canon.js";

/** Current layout when the workspace has no `[docs]` table. */
export const DEFAULT_DOCS_CANON: Readonly<Record<DocsCategory, string>> = {
  ...DEFAULT_CORE_DOCS_CANON,
  decision: "docs/decisions",
  diagrams: "docs/diagrams",
  manuals: "docs/manuals",
  reports: "docs/reports",
  scripts: "docs/scripts",
};

/** Category → workspace-relative folder, for the requested categories. */
export type DocsCanon = Readonly<Partial<Record<DocsCategory, string>>>;

export type DocsCanonResult = { ok: true; canon: DocsCanon } | { ok: false; error: string };

const TABLE = "docs";

export async function resolveDocsCanon(
  fs: FileSystemPort,
  paths: PathsService,
  categories: readonly DocsCategory[],
): Promise<DocsCanonResult> {
  const canon: Record<string, string> = {};
  for (const category of categories) canon[category] = DEFAULT_DOCS_CANON[category];
  // Workspace last: it overrides the user-global default, same order as skills.
  for (const path of [paths.userSkillsToml(), paths.cwdSkillsToml()]) {
    if (!(await fs.exists(path))) continue;
    const level = await readDocsTable(fs, path);
    if (!level.ok) return level;
    for (const [category, dir] of Object.entries(level.table)) {
      const checked = checkDestination(path, category, dir);
      if (!checked.ok) return checked;
      if (categories.includes(category as DocsCategory)) canon[category] = checked.dir;
    }
  }
  return { ok: true, canon };
}

/** Resolve research/spec/plan together so their writers and readers agree. */
export async function resolveCoreDocsCanon(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<{ ok: true; canon: CoreDocsCanon } | { ok: false; error: string }> {
  const resolved = await resolveDocsCanon(fs, paths, CORE_DOC_CATEGORIES);
  if (!resolved.ok) return resolved;
  const research = resolved.canon.research;
  const spec = resolved.canon.spec;
  const plan = resolved.canon.plan;
  // Defaults are installed above; keep this guard because config is an external
  // boundary and a missing path must never fall through to a second literal.
  if (research === undefined || spec === undefined || plan === undefined) {
    return { ok: false, error: "el canon documental no resolvió research, spec y plan" };
  }
  return { ok: true, canon: { research, spec, plan } };
}

async function readDocsTable(
  fs: FileSystemPort,
  path: string,
): Promise<{ ok: true; table: Record<string, unknown> } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = parseToml(await fs.readText(path));
  } catch (error) {
    return { ok: false, error: `${path} no se puede leer como TOML: ${String(error)}` };
  }
  const table = (parsed as Record<string, unknown>)[TABLE];
  if (table === undefined || table === null) return { ok: true, table: {} };
  if (typeof table !== "object" || Array.isArray(table)) {
    return { ok: false, error: `${path}: [${TABLE}] no es una tabla` };
  }
  return { ok: true, table: table as Record<string, unknown> };
}

function checkDestination(
  path: string,
  category: string,
  dir: unknown,
): { ok: true; dir: string } | { ok: false; error: string } {
  if (!(DOCS_CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      error: `${path}: [${TABLE}] no reconoce '${category}'; las categorías son: ${DOCS_CATEGORIES.join(", ")}`,
    };
  }
  if (typeof dir !== "string") {
    return { ok: false, error: `${path}: [${TABLE}].${category} tiene que ser una ruta de texto` };
  }
  // Same guard every write boundary uses, so a canon can move a category inside
  // the workspace and never outside it.
  const safe = checkSafeRelativePath(dir.replace(/\/+$/, ""));
  if (!safe.ok) {
    return { ok: false, error: `${path}: [${TABLE}].${category} = '${dir}' ${safe.why}` };
  }
  // Inside the workspace is not enough: it has to be DOCUMENTAL. A canon
  // pointing at a dot-directory would publish dossiers into the CLI's own
  // runtime — `.workflow/sessions` is the sharp case, because a published unit
  // named `NNN-export-…` is then enumerated as a session and the workspace grows
  // a phantom open line that shows up in `status` and in the next export's
  // corpus. The tool's own state is not a place a document may be published to.
  if (safe.path.split("/")[0]?.startsWith(".") === true) {
    return {
      ok: false,
      error: `${path}: [${TABLE}].${category} = '${dir}' apunta a un directorio oculto; el canon documental publica documentos, no estado interno de la herramienta`,
    };
  }
  // Core document routes are read by flow, retirement, custody and design
  // boundaries that have not all adopted DocsCanon yet. Accepting a custom
  // route here would let persist/index see one tree while a later lifecycle
  // write still targets another. Keep the shared defaults centralised now and
  // refuse a relocation until that migration is complete.
  if (
    FIXED_CATEGORIES.has(category) &&
    safe.path !== DEFAULT_DOCS_CANON[category as DocsCategory]
  ) {
    return {
      ok: false,
      error: `${path}: [${TABLE}].${category} todavía no admite un destino personalizado; flow, retiro, custodia y diseño siguen cerrados sobre el layout canónico`,
    };
  }
  return { ok: true, dir: safe.path };
}
