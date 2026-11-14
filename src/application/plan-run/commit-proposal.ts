import { resolve } from "node:path";
import type { GitPort } from "../../ports/git.js";
import { approvalDigest } from "../doc-flow/doc-digest.js";

export interface CommitProposal {
  /** Alias of the source, or `hub`. */
  source: string;
  /** The source's declared path (the hub root for `hub`). */
  repo: string;
  /** Where the paths are read and committed: `repo`, or the worktree chosen with --checkout. */
  checkout: string;
  branch: string | null;
  head: string | null;
  message: string;
  /** `path` as asked (hub-relative in the hub); `git_path` as git spells it from its root. */
  paths: { path: string; git_path: string; digest: string }[];
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

export interface CommitTarget {
  source: string;
  repo: string;
  checkout: string;
  /** Git prefix of `checkout` inside its repository (`projects/x/` for a nested hub; `""` at the root). */
  prefix: string;
  message: string;
  paths: readonly string[];
}

/**
 * A commit proposal sealed by a digest of the source, the checkout, its branch
 * and HEAD, the message and the exact bytes of every proposed path (spec 066,
 * ID05; spec 067, ID02). Nothing is stored: the digest is shown in the
 * conversation and quoted back by {@link commitApproved}.
 */
export async function proposeCommit(
  git: GitPort,
  input: CommitTarget,
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
  // git spells changed paths from its root and reads their bytes there, so a
  // nested hub is looked up from that root with its prefix in front.
  const gitRoot = resolve(
    input.checkout,
    input.prefix
      .split("/")
      .filter(Boolean)
      .map(() => "..")
      .join("/") || ".",
  );
  const dirty = new Map((await git.dirtyPaths(gitRoot)).map((entry) => [entry.path, entry.digest]));
  const paths: CommitProposal["paths"] = [];
  for (const path of [...new Set(input.paths)].sort()) {
    const git_path = `${input.prefix}${path}`;
    const digest = dirty.get(git_path);
    if (digest === undefined) {
      return refuse(
        "COMMIT_PATH_UNCHANGED",
        `'${path}' no tiene cambios sin commit en ${input.checkout}`,
        "proponé sólo rutas que el cambio modificó",
      );
    }
    paths.push({ path, git_path, digest });
  }
  const head = await git.head(input.checkout);
  const branch = (await git.currentBranch(input.checkout)) ?? null;
  const approval = approvalDigest({
    source: input.source,
    repo: input.repo,
    checkout: input.checkout,
    branch: branch ?? "",
    head: head ?? "",
    message,
    paths: paths.map((entry) => `${entry.path}=${entry.digest}`).join("\n"),
  });
  return {
    ok: true,
    value: {
      source: input.source,
      repo: input.repo,
      checkout: input.checkout,
      branch,
      head,
      message,
      paths,
      approval,
    },
  };
}

/**
 * Commits exactly the proposed paths, only while the approval still describes
 * the tree (AC-06, AC-07): a path whose bytes changed after the proposal, a moved
 * HEAD, another checkout or branch, or another message makes the approval stale
 * and nothing is committed.
 */
export async function commitApproved(
  git: GitPort,
  input: CommitTarget & { approval: string },
): Promise<CommitResult<{ hash: string; paths: string[] }>> {
  const current = await proposeCommit(git, input);
  if (!current.ok || current.value.approval !== input.approval) {
    return refuse(
      "COMMIT_PROPOSAL_STALE",
      "los archivos, el checkout, la rama, el HEAD o el mensaje cambiaron desde la propuesta: la aprobación ya no vale",
      "volvé a proponer el commit y pedí una aprobación nueva",
    );
  }
  const paths = current.value.paths.map((entry) => entry.path);
  const receipt = await git.commitPaths(input.checkout, current.value.message, paths);
  return { ok: true, value: { hash: receipt.after, paths } };
}

function refuse<T>(code: CommitFailure["code"], message: string, action: string): CommitResult<T> {
  return { ok: false, failure: { code, message, action } };
}
