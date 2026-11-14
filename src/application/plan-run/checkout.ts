import { resolve } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";

export interface CheckoutFailure {
  code: "CHECKOUT_MISSING" | "CHECKOUT_NOT_OF_SOURCE";
  message: string;
  action: string;
}

export type CheckoutResult = { ok: true; value: string } | { ok: false; failure: CheckoutFailure };

/**
 * The checkout a commit verb works in (spec 067, ID01): the source's declared
 * path, or a worktree of that same source chosen for this one invocation. The
 * choice is compared by real path, so another spelling of the same tree (a
 * symlinked `/tmp` on macOS) still matches; an invalid choice is refused, never
 * replaced by the declared path.
 */
export async function resolveCheckout(
  fs: FileSystemPort,
  git: GitPort,
  input: { alias: string; declared: string; chosen: string | undefined },
): Promise<CheckoutResult> {
  if (input.chosen === undefined) return { ok: true, value: input.declared };
  const chosen = resolve(input.chosen);
  if (!(await fs.exists(chosen))) {
    return refuse(
      "CHECKOUT_MISSING",
      `el checkout '${input.chosen}' no existe`,
      "nombrá un worktree vigente de la fuente ('git worktree list' los muestra)",
    );
  }
  const real = await fs.realPath(chosen);
  for (const tree of await git.worktreeList(input.declared)) {
    if (tree.prunable) continue;
    const treeReal = await fs.realPath(tree.path).catch(() => null);
    if (treeReal === real) return { ok: true, value: real };
  }
  return refuse(
    "CHECKOUT_NOT_OF_SOURCE",
    `'${input.chosen}' no es un worktree de la fuente '${input.alias}' (${input.declared})`,
    "nombrá un worktree de esa fuente; un clon aparte no lo es",
  );
}

function refuse(code: CheckoutFailure["code"], message: string, action: string): CheckoutResult {
  return { ok: false, failure: { code, message, action } };
}
