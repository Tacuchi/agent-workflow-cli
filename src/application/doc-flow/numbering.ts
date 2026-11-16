import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";

const MAX_ATTEMPTS = 50;

/** Stamp only the first H1; references and lineage retain their own numbers. */
export function stampDocumentTitle(
  content: string,
  number: string,
  prefixUnnumbered = false,
): string {
  return content.replace(/^#[ \t]+[^\r\n]*/m, (title) => {
    const numbered = /^(#[ \t]+[\p{L}\p{M}]+[ \t]+)(?:NNN|PPP|\d+)(?=[ \t]*(?:[—–-][ \t]+.*)?$)/u;
    if (numbered.test(title)) return title.replace(numbered, `$1${number}`);
    return prefixUnnumbered
      ? title.replace(/^#[ \t]+(?:\d{3,}[ \t]+[—–-][ \t]*)?/, `# ${number} — `)
      : title;
  });
}

/** The highest correlative of `NNN-<kind>-*.md` in a folder, `0` when there is none. */
export async function highestCorrelative(
  fs: FileSystemPort,
  dir: string,
  kind: "spec" | "plan",
): Promise<number> {
  if (!(await fs.exists(dir))) return 0;
  const pattern = new RegExp(`^(\\d{3,})-${kind}-.+\\.md$`);
  let highest = 0;
  for (const entry of await fs.list(dir)) {
    const match = entry.type === "file" ? pattern.exec(entry.name) : null;
    if (match?.[1]) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Publishes a new numbered document by exclusive creation (spec 066, T3.2).
 *
 * The number is the next one `docs/` shows; if another instance published it
 * first, the exclusive create fails and the next number is tried. No ledger, no
 * claim and no HISTORY row: the folder is the only record of what is taken.
 */
export async function publishNumbered(
  fs: FileSystemPort,
  dir: string,
  kind: "spec" | "plan",
  slug: string,
  content: (number: string) => string,
): Promise<{ number: string; path: string }> {
  await fs.mkdirp(dir);
  let next = (await highestCorrelative(fs, dir, kind)) + 1;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1, next += 1) {
    const number = String(next).padStart(3, "0");
    const path = join(dir, `${number}-${kind}-${slug}.md`);
    if ((await fs.publishTextExclusive(path, content(number))).created) return { number, path };
  }
  throw new Error(`no se pudo publicar un ${kind} nuevo en ${dir}: correlativos ocupados`);
}

/** Every `NNN-*` entry of a folder and the highest correlative among them. */
export async function correlativesOf(
  fs: FileSystemPort,
  dir: string,
): Promise<{ exists: boolean; files: string[]; highest: number }> {
  if (!(await fs.exists(dir))) return { exists: false, files: [], highest: 0 };
  const files: string[] = [];
  let highest = 0;
  for (const entry of await fs.list(dir)) {
    const match = /^(\d{3,})-/.exec(entry.name);
    if (!match?.[1]) continue;
    files.push(entry.name);
    highest = Math.max(highest, Number(match[1]));
  }
  return { exists: true, files: files.sort(), highest };
}
