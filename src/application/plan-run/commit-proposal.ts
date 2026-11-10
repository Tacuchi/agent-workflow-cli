import type { GitPort } from "../../ports/git.js";
import { approvalDigest } from "../doc-flow/doc-digest.js";

export interface CommitProposal {
  repo: string;
  head: string | null;
  message: string;
  paths: { path: string; digest: string }[];
  /** What the person approves in the conversation; the commit quotes it back. */
  approval: string;
}

export interface CommitFailure {
  code:
    | "COMMIT_MESSAGE_INVALID"
    | "COMMIT_PATHS_EMPTY"
    | "COMMIT_PATH_UNCHANGED"
    | "COMMIT_PROPOSAL_STALE";
  message: string;
  action: string;
}

export type CommitResult<T> = { ok: true; value: T } | { ok: false; failure: CommitFailure };

/**
 * A commit proposal sealed by a digest of HEAD, the message and the exact bytes
 * of every proposed path (spec 066, ID05). Nothing is stored: the digest is
 * shown in the conversation and quoted back by {@link commitApproved}.
 */
export async function proposeCommit(
  git: GitPort,
  input: { repo: string; message: string; paths: readonly string[] },
): Promise<CommitResult<CommitProposal>> {
  const message = input.message.trim();
  if (message === "" || message.includes("\n")) {
    return refuse(
      "COMMIT_MESSAGE_INVALID",
      "el mensaje de commit es una sola línea no vacía",
      "proponé un mensaje de una línea",
    );
  }
  if (input.paths.length === 0) {
    return refuse(
      "COMMIT_PATHS_EMPTY",
      "no hay rutas que commitear",
      "nombrá las rutas exactas del cambio",
    );
  }
  const dirty = new Map(
    (await git.dirtyPaths(input.repo)).map((entry) => [entry.path, entry.digest]),
  );
  const paths: { path: string; digest: string }[] = [];
  for (const path of [...new Set(input.paths)].sort()) {
    const digest = dirty.get(path);
    if (digest === undefined) {
      return refuse(
        "COMMIT_PATH_UNCHANGED",
        `'${path}' no tiene cambios sin commit en ${input.repo}`,
        "proponé sólo rutas que el cambio modificó",
      );
    }
    paths.push({ path, digest });
  }
  const head = await git.head(input.repo);
  const approval = approvalDigest({
    repo: input.repo,
    head: head ?? "",
    message,
    paths: paths.map((entry) => `${entry.path}=${entry.digest}`).join("\n"),
  });
  return { ok: true, value: { repo: input.repo, head, message, paths, approval } };
}

/**
 * Commits exactly the proposed paths, only while the approval still describes
 * the tree (AC-06, AC-07): a path whose bytes changed after the proposal, a moved
 * HEAD or another message makes the approval stale and nothing is committed.
 */
export async function commitApproved(
  git: GitPort,
  input: { repo: string; message: string; paths: readonly string[]; approval: string },
): Promise<CommitResult<{ hash: string; paths: string[] }>> {
  const current = await proposeCommit(git, input);
  if (!current.ok || current.value.approval !== input.approval) {
    return refuse(
      "COMMIT_PROPOSAL_STALE",
      "los archivos, el HEAD o el mensaje cambiaron desde la propuesta: la aprobación ya no vale",
      "volvé a proponer el commit y pedí una aprobación nueva",
    );
  }
  const paths = current.value.paths.map((entry) => entry.path);
  const receipt = await git.commitPaths(input.repo, current.value.message, paths);
  return { ok: true, value: { hash: receipt.after, paths } };
}

function refuse<T>(code: CommitFailure["code"], message: string, action: string): CommitResult<T> {
  return { ok: false, failure: { code, message, action } };
}
