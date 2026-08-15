import { parse as parseToml } from "smol-toml";
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

/** Category → workspace-relative folder, for the categories that declare one. */
export type DocsCanon = Readonly<Record<string, string>>;

export type DocsCanonResult = { ok: true; canon: DocsCanon } | { ok: false; error: string };

const TABLE = "docs";

export async function resolveDocsCanon(
  fs: FileSystemPort,
  paths: PathsService,
  categories: readonly string[],
): Promise<DocsCanonResult> {
  const canon: Record<string, string> = {};
  // Workspace last: it overrides the user-global default, same order as skills.
  for (const path of [paths.userSkillsToml(), paths.cwdSkillsToml()]) {
    if (!(await fs.exists(path))) continue;
    const level = await readDocsTable(fs, path);
    if (!level.ok) return level;
    for (const [category, dir] of Object.entries(level.table)) {
      const checked = checkDestination(path, category, dir, categories);
      if (!checked.ok) return checked;
      canon[category] = checked.dir;
    }
  }
  return { ok: true, canon };
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
  categories: readonly string[],
): { ok: true; dir: string } | { ok: false; error: string } {
  if (!categories.includes(category)) {
    return {
      ok: false,
      error: `${path}: [${TABLE}] no reconoce '${category}'; las categorías son: ${categories.join(", ")}`,
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
  return { ok: true, dir: safe.path };
}
