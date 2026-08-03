import { dirname, join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { SemanticArtifact, SemanticFailure, SemanticParse } from "./protocol.js";

/**
 * All-or-nothing publication of a validated proposal.
 *
 * A dossier is several files that only mean something together, so a failure
 * halfway through must not leave half of one on disk. There is no rename
 * primitive in `FileSystemPort`, so the guarantee is built from what there is:
 * every previous state is captured before the first write, and any failure
 * restores it — a file that did not exist is removed, one that did gets its
 * bytes back.
 *
 * Overwriting is never implicit. Without `overwrite`, an existing target is
 * itself the failure, detected by `writeTextExclusive` rather than by a
 * check-then-write race.
 */

export interface PublishOptions {
  /** Replace existing targets. Only ever set from an explicit authorization. */
  overwrite?: boolean;
}

/**
 * One publication may legitimately mix both: an index that is meant to be
 * rewritten and a new immutable revision that must never land on top of an
 * existing file. A single flag for the whole batch would force choosing which
 * of the two guarantees to give up.
 */
export interface PublishableArtifact extends SemanticArtifact {
  overwrite?: boolean;
}

export interface PublishResult {
  written: string[];
}

interface Restore {
  absolute: string;
  /** `null` = the file did not exist and must be removed to roll back. */
  previous: string | null;
}

/**
 * Directories this publication created. Restoring only file CONTENT leaves an
 * empty tree behind — and an empty folder is visible state: under
 * `docs/designs/` a stray one reads as a package with no manifest, so a failed
 * publication would invent a broken package that nobody wrote.
 */
type CreatedDirs = string[];

export async function publishArtifacts(
  fs: FileSystemPort,
  root: string,
  artifacts: PublishableArtifact[],
  options: PublishOptions = {},
): Promise<SemanticParse<PublishResult>> {
  const done: Restore[] = [];
  const created: CreatedDirs = [];
  for (const artifact of artifacts) {
    const absolute = join(root, artifact.path);
    const failure = await writeOne(fs, absolute, artifact, options, done, created);
    if (failure !== null) {
      await rollback(fs, done, created);
      return { ok: false, failure };
    }
  }
  return { ok: true, value: { written: artifacts.map((a) => a.path) } };
}

/** The chain of ancestors that do not exist yet, outermost first. */
async function missingAncestors(fs: FileSystemPort, dir: string): Promise<string[]> {
  const missing: string[] = [];
  let current = dir;
  while (!(await fs.exists(current))) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

async function writeOne(
  fs: FileSystemPort,
  absolute: string,
  artifact: PublishableArtifact,
  options: PublishOptions,
  done: Restore[],
  created: CreatedDirs,
): Promise<SemanticFailure | null> {
  const overwrite = artifact.overwrite ?? options.overwrite === true;
  try {
    created.push(...(await missingAncestors(fs, dirname(absolute))));
    await fs.mkdirp(dirname(absolute));
    const previous = await readPrevious(fs, absolute);

    if (previous === UNREADABLE) {
      // Fail-closed: sin poder leerlo no hay cómo devolverlo a como estaba.
      return {
        code: "PUBLISH_FAILED",
        message: `'${artifact.path}' existe y no se pudo leer`,
        action: "no se sobrescribe lo que no se puede restaurar: revisá permisos",
      };
    }

    if (previous !== null && !overwrite) {
      return {
        code: "PUBLISH_TARGET_EXISTS",
        message: `'${artifact.path}' ya existe y no se autorizó sobrescribir`,
        action: "confirmá la sobrescritura explícitamente, o publicá en otro destino",
      };
    }

    // Registered BEFORE the write, not after. A write can fail HALFWAY — the
    // exclusive path opens the file and then writes it — and a destination that
    // only enters `done` on success is a destination the rollback cannot undo:
    // the half-written file stays, and every retry loses to it forever.
    done.push({ absolute, previous });

    if (previous === null) {
      // Exclusive create closes the check-then-write window: a concurrent run
      // that got there first loses here, not silently.
      const { created } = await fs.writeTextExclusive(absolute, artifact.content);
      if (!created) {
        // Someone else's file: it is not ours to roll back.
        done.pop();
        return {
          code: "PUBLISH_TARGET_EXISTS",
          message: `'${artifact.path}' fue creado por otro proceso durante la publicación`,
          action: "volvé a correr prepare: el inventario y la numeración cambiaron",
        };
      }
    } else {
      await fs.writeText(absolute, artifact.content);
    }

    return null;
  } catch (err) {
    return {
      code: "PUBLISH_FAILED",
      message: `no se pudo escribir '${artifact.path}': ${errorText(err)}`,
      action: "revisá permisos y espacio en disco, y volvé a intentar",
    };
  }
}

/**
 * What is there now, or UNREADABLE.
 *
 * The distinction matters: returning `""` for a file we could not read made the
 * rollback TRUNCATE it — a publication that reported failure destroyed content
 * it never managed to read. Unreadable means untouchable.
 */
const UNREADABLE = Symbol("unreadable");

async function readPrevious(
  fs: FileSystemPort,
  absolute: string,
): Promise<string | null | typeof UNREADABLE> {
  if (!(await fs.exists(absolute))) return null;
  try {
    return await fs.readText(absolute);
  } catch {
    return UNREADABLE;
  }
}

/** Undo in reverse order, best effort — a failed undo must not mask the cause. */
async function rollback(fs: FileSystemPort, done: Restore[], created: CreatedDirs): Promise<void> {
  for (const entry of [...done].reverse()) {
    try {
      if (entry.previous === null) await fs.remove(entry.absolute);
      else await fs.writeText(entry.absolute, entry.previous);
    } catch {
      // ignore; the original failure is what the caller reports
    }
  }
  // Deepest first, and only while still empty: a directory that gained content
  // from somewhere else is not ours to remove.
  for (const dir of [...created].sort((a, b) => b.length - a.length)) {
    try {
      if ((await fs.list(dir)).length === 0) await fs.remove(dir);
    } catch {
      // ignore; same reason
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
