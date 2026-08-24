/**
 * Where this run's source-bounded evidence gets measured, resolved once.
 *
 * Split out of `submit`'s observation for one reason: the directive is built before
 * any proof exists and needs the same answer the validator will use. Resolving it
 * from two places is exactly the divergence that made a rejection claim the tree had
 * moved when all that differed was the directory each side measured.
 *
 * The path half resolves with no git and no digest, which is what lets a directive
 * publish the root where no git port is available; the expensive half lives in
 * {@link observeCheckout}.
 */

import type { FlowDirective } from "../../domain/flow/directive.js";
import { unitPath, workspaceKey } from "../../domain/isolation-unit.js";
import { type CheckoutIdentity, SOURCE_BOUNDED_EVIDENCE } from "../../domain/source-boundary.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { readWorkspaceBlock } from "../parsers/project-block.js";
import { type PathsService, resolveWorkspaceRootFrom } from "../paths-service.js";
import { type CheckoutState, checkoutDigest } from "../source-boundary-policy.js";

/**
 * The alias→root map a run's source-bounded evidence is measured against.
 *
 * `workspace` is the documentary checkout: the nearest ancestor of the workspace
 * directory carrying the Workline marker, which in a nested hub is NOT the git root.
 * Every other alias resolves to the isolation unit of THIS session, so a proof
 * cannot borrow another run's worktree by spelling its alias.
 *
 * An unreadable boundary yields an empty list rather than a guess: a caller that
 * cannot say which root it would use must not publish one.
 */
export async function resolveCheckoutCandidates(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
): Promise<CheckoutIdentity[]> {
  let root: string;
  let block: Awaited<ReturnType<typeof readWorkspaceBlock>>;
  try {
    root = await resolveWorkspaceRootFrom(fs, paths);
    block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
  } catch {
    return [];
  }
  const candidates: CheckoutIdentity[] = [{ source: "workspace", root }];
  if (block !== null) {
    try {
      const units = await fs.realPath(paths.userUnitsDir());
      const key = workspaceKey(paths.workspaceDir());
      for (const source of block.fuentes) {
        const unit = unitPath(units, { workspaceKey: key, alias: source.alias, session });
        // Only a unit this session actually TOOK is published. Listing every alias
        // the workspace block declares would advertise roots the validator then
        // refuses as ineligible — the same divergence between what a run shows and
        // what it measures that this whole change exists to close.
        if (await fs.exists(unit)) candidates.push({ source: source.alias, root: unit });
      }
    } catch {
      // A run without isolated units can still prove its documentary checkout.
      // Any proof naming another source stays invalid because it is absent below.
    }
  }
  return candidates;
}

/**
 * Observe one checkout: its digest, and whether that digest survives recomputation.
 *
 * `null` means the root is not an observable git checkout — absent, unreadable, or
 * not a repo. That is deliberately NOT reported as a clean tree: a proof against it
 * fails closed instead.
 *
 * One function for both callers, because there were briefly two copies of this same
 * five-command protocol and two copies is how they drift. `submit` keeps an unstable
 * observation (its rejection needs to SAY the fingerprint moved); `prove` refuses it
 * outright. Same observation, different policy on it.
 */
export async function observeCheckout(
  fs: FileSystemPort,
  git: GitPort,
  identity: CheckoutIdentity,
): Promise<CheckoutState | null> {
  try {
    if (!(await fs.exists(identity.root)) || !(await git.isGitRepo(identity.root))) return null;
    // The fingerprint is taken twice, concurrently: a digest that does not survive
    // its own recomputation must not be reported as a tree that moved.
    const [head, dirty, changed, fingerprint, recomputed] = await Promise.all([
      git.head(identity.root),
      git.isDirty(identity.root),
      git.changedFiles(identity.root),
      git.checkoutFingerprint(identity.root),
      git.checkoutFingerprint(identity.root),
    ]);
    return {
      source: identity.source,
      digest: checkoutDigest({
        source: identity.source,
        head,
        dirty,
        changed_files: changed,
        worktree_fingerprint: fingerprint,
      }),
      reproducible: fingerprint === recomputed,
      // Carried so the rejection can name the directory it measured. Without it the
      // reader is sent to look for a change in a tree that may be intact.
      root: identity.root,
    };
  } catch {
    return null;
  }
}

/**
 * Publish the observed roots on a directive whose evidence demands a proof.
 *
 * Applied where a directive LEAVES the application layer, and for one reason: a
 * boundary is reached as often by the `submit` that answered the previous one as by
 * an `advance`. Decorating inside the walk covered only some of those exits, and an
 * optional field made the omission invisible — the prover just saw no root and was
 * back to guessing, which is the cost this whole contract exists to remove.
 *
 * It never touches the seal: the digest is computed over the registry row's action
 * long before this runs, so the same answer stays valid on any machine.
 */
export function withObservedCheckouts(
  directive: FlowDirective,
  checkouts: readonly CheckoutIdentity[],
): FlowDirective {
  const action = directive.action;
  if (action === null || checkouts.length === 0) return directive;
  if (!action.evidence.includes(SOURCE_BOUNDED_EVIDENCE)) return directive;
  return { ...directive, action: { ...action, checkouts } };
}

/**
 * Publish the roots for a caller that has NOT observed them yet.
 *
 * `advance` and `recover` hold no observation, and publishing their candidate list
 * instead would advertise roots the validator refuses as ineligible — a path can
 * exist, be a repo, and still fail to yield a fingerprint (an unborn HEAD, a moved
 * gitdir, a locked index). That is the same divergence between shown and measured
 * that this contract closes, so what gets published is what got OBSERVED, here too.
 *
 * The observation is paid only at a boundary that actually demands the proof, which
 * is rare: every other boundary returns before a single git command runs. Without a
 * git reader nothing is published at all — a caller that cannot verify a root must
 * not advertise one.
 */
export async function publishObservedCheckouts(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
  git: GitPort | undefined,
  directive: FlowDirective,
): Promise<FlowDirective> {
  const action = directive.action;
  if (action === null || !action.evidence.includes(SOURCE_BOUNDED_EVIDENCE)) return directive;
  if (git === undefined) return directive;
  const observed: CheckoutIdentity[] = [];
  for (const candidate of await resolveCheckoutCandidates(fs, paths, session)) {
    if ((await observeCheckout(fs, git, candidate)) !== null) observed.push(candidate);
  }
  return withObservedCheckouts(directive, observed);
}
