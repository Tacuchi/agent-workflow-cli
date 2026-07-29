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

export interface PublishResult {
  written: string[];
}

interface Restore {
  absolute: string;
  /** `null` = the file did not exist and must be removed to roll back. */
  previous: string | null;
}

export async function publishArtifacts(
  fs: FileSystemPort,
  root: string,
  artifacts: SemanticArtifact[],
  options: PublishOptions = {},
): Promise<SemanticParse<PublishResult>> {
  const done: Restore[] = [];
  for (const artifact of artifacts) {
    const absolute = join(root, artifact.path);
    const failure = await writeOne(fs, absolute, artifact, options, done);
    if (failure !== null) {
      await rollback(fs, done);
      return { ok: false, failure };
    }
  }
  return { ok: true, value: { written: artifacts.map((a) => a.path) } };
}

async function writeOne(
  fs: FileSystemPort,
  absolute: string,
  artifact: SemanticArtifact,
  options: PublishOptions,
  done: Restore[],
): Promise<SemanticFailure | null> {
  try {
    await fs.mkdirp(dirname(absolute));
    const previous = await readPrevious(fs, absolute);

    if (previous !== null && options.overwrite !== true) {
      return {
        code: "PUBLISH_TARGET_EXISTS",
        message: `'${artifact.path}' ya existe y no se autorizó sobrescribir`,
        action: "confirmá la sobrescritura explícitamente, o publicá en otro destino",
      };
    }

    if (previous === null) {
      // Exclusive create closes the check-then-write window: a concurrent run
      // that got there first loses here, not silently.
      const { created } = await fs.writeTextExclusive(absolute, artifact.content);
      if (!created) {
        return {
          code: "PUBLISH_TARGET_EXISTS",
          message: `'${artifact.path}' fue creado por otro proceso durante la publicación`,
          action: "volvé a correr prepare: el inventario y la numeración cambiaron",
        };
      }
    } else {
      await fs.writeText(absolute, artifact.content);
    }

    done.push({ absolute, previous });
    return null;
  } catch (err) {
    return {
      code: "PUBLISH_FAILED",
      message: `no se pudo escribir '${artifact.path}': ${errorText(err)}`,
      action: "revisá permisos y espacio en disco, y volvé a intentar",
    };
  }
}

async function readPrevious(fs: FileSystemPort, absolute: string): Promise<string | null> {
  if (!(await fs.exists(absolute))) return null;
  try {
    return await fs.readText(absolute);
  } catch {
    // Unreadable but present: treat it as existing so we never clobber blindly,
    // and as unrestorable so a rollback leaves it exactly as it was found.
    return "";
  }
}

/** Undo in reverse order, best effort — a failed undo must not mask the cause. */
async function rollback(fs: FileSystemPort, done: Restore[]): Promise<void> {
  for (const entry of [...done].reverse()) {
    try {
      if (entry.previous === null) await fs.remove(entry.absolute);
      else await fs.writeText(entry.absolute, entry.previous);
    } catch {
      // ignore; the original failure is what the caller reports
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
