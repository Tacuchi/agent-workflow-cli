import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ConflictStages, GitPort } from "../ports/git.js";
import { type SourceBranchRoles, isWorkingBranch } from "./branch-resolver.js";
import {
  type SemanticFailure,
  type SemanticParse,
  type SemanticRequest,
  buildSemanticRequest,
  parseSemanticResponse,
} from "./semantic-operation/protocol.js";

/**
 * `fix-git` — resolve merge conflicts whose resolution is unambiguous.
 *
 * The AI contributes intent and content for one conflict at a time; the CLI
 * decides which paths are still authorized, revalidates that the conflict is
 * the same one it prepared, and owns edit / stage / commit.
 *
 * Two authorization rules, deliberately different:
 *
 * - **`apply` is authorized by the invocation itself** — but only for a set
 *   that is entirely unambiguous and still current. Anything else stops.
 * - **`commit` is a separate action** and always needs its own confirmation.
 *   Never `--no-verify`, never `--amend`, never a push.
 */

const OPERATION = "fix-git";
const LIMITS = { max_artifacts: 64, max_artifact_bytes: 512 * 1024 };
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

const CONTRACT = [
  "Respondé UN objeto JSON con version, operation e input_digest copiados del request,",
  "state='proposed' y artifacts: un { path, content } por CADA archivo en conflicto,",
  "donde content es el archivo resuelto COMPLETO, sin marcadores de conflicto.",
  "Si alguno no tiene resolución inequívoca, respondé state='ambiguous' (o 'unsupported'",
  "para binarios) con reason — el CLI lo devuelve como elección y no escribe nada.",
  "No incluyas ningún path fuera del set de conflictos.",
].join(" ");

export interface ConflictSummary {
  path: string;
  base_hash: string | null;
  ours_hash: string | null;
  theirs_hash: string | null;
  binary: boolean;
  bytes: number;
}

/**
 * The branch roles the PR-04 guard judged the merge against, and whose they are:
 * the owning source's, or — when no source owns the repo — the workspace
 * defaults, which the output then says.
 */
export interface FixGitRoles extends SourceBranchRoles {
  owner: string | null;
  /** Where the roles came from when no source owns the repo. */
  basis: "source" | "workspace-defaults" | "cli-floor";
}

export interface FixGitContext {
  repo: string;
  alias: string | null;
  roles?: FixGitRoles;
  merge_origin: string | null;
  current_branch: string | null;
  conflicts: ConflictSummary[];
}

export interface FixGitPrepared {
  context: FixGitContext;
  request: SemanticRequest;
  stages: ConflictStages[];
}

export interface FixGitApplied {
  resolved: string[];
  staged: string[];
  /** Still unmerged after applying — always empty on success. */
  remaining: string[];
}

// ── prepare ──────────────────────────────────────────────────────────────────

export async function prepareFixGit(
  git: GitPort,
  repo: string,
  alias: string | null,
  roles?: FixGitRoles,
): Promise<SemanticParse<FixGitPrepared>> {
  if (!(await git.isGitRepo(repo))) {
    return { ok: false, failure: notRepo(repo) };
  }
  if (!(await git.isMerging(repo))) return { ok: false, failure: notMerging(repo) };

  const forbidden = roles ? await devIntoWorkingBranch(git, repo, roles) : null;
  if (forbidden !== null) return { ok: false, failure: forbidden };

  const paths = await git.conflictedFiles(repo);
  if (paths.length === 0) {
    return {
      ok: false,
      failure: {
        code: "NO_CONFLICTS",
        message: "el merge está en curso pero no quedan archivos en conflicto",
        action: "revisá `git status`: puede faltar solo el commit del merge",
      },
    };
  }

  const stages: ConflictStages[] = [];
  for (const path of paths) stages.push(await git.conflictStages(repo, path));

  const context: FixGitContext = {
    repo,
    alias,
    ...(roles ? { roles } : {}),
    merge_origin: (await git.mergeOrigin(repo)) ?? null,
    current_branch: (await git.currentBranch(repo)) ?? null,
    conflicts: stages.map(summarize),
  };

  const request = buildSemanticRequest({
    operation: OPERATION,
    // Sealed over the hashes, not the content: the seal must change exactly
    // when the conflict changes, and only then.
    inputs: context.conflicts,
    contract: CONTRACT,
    inventory: { context, stages: stages.map(stageView) },
    allowedDestinations: paths,
    limits: LIMITS,
    readSet: paths,
    readSetBytes: stages.reduce((sum, s) => sum + totalBytes(s), 0),
  });

  return { ok: true, value: { context, request, stages } };
}

function summarize(stages: ConflictStages): ConflictSummary {
  return {
    path: stages.path,
    base_hash: stages.base.hash,
    ours_hash: stages.ours.hash,
    theirs_hash: stages.theirs.hash,
    binary: stages.binary,
    bytes: totalBytes(stages),
  };
}

function stageView(stages: ConflictStages): Record<string, unknown> {
  return {
    path: stages.path,
    binary: stages.binary,
    base: stages.base.content,
    ours: stages.ours.content,
    theirs: stages.theirs.content,
  };
}

function totalBytes(stages: ConflictStages): number {
  return stages.base.bytes + stages.ours.bytes + stages.theirs.bytes;
}

// ── validate ─────────────────────────────────────────────────────────────────

export interface FixGitResolution {
  path: string;
  content: string;
  bytes: number;
}

export function validateFixGit(
  raw: string,
  prepared: FixGitPrepared,
): SemanticParse<FixGitResolution[]> {
  const parsed = parseSemanticResponse(raw, prepared.request);
  if (!parsed.ok) return parsed;

  const proposed = new Map((parsed.value.artifacts ?? []).map((a) => [a.path, a.content]));
  const resolutions: FixGitResolution[] = [];

  for (const conflict of prepared.context.conflicts) {
    // Binary stays a human job: turning it into text would silently corrupt it.
    if (conflict.binary) {
      return { ok: false, failure: unsupportedBinary(conflict.path) };
    }
    const content = proposed.get(conflict.path);
    if (content === undefined) {
      return {
        ok: false,
        failure: {
          code: "FIX_GIT_INCOMPLETE",
          message: `falta la resolución de '${conflict.path}'`,
          action: "resolvé TODOS los conflictos vigentes, o declará state='ambiguous'",
        },
      };
    }
    if (CONFLICT_MARKER.test(content)) {
      return {
        ok: false,
        failure: {
          code: "FIX_GIT_MARKERS_LEFT",
          message: `'${conflict.path}' conserva marcadores de conflicto`,
          action: "entregá el archivo resuelto completo, sin <<<<<<< ======= >>>>>>>",
        },
      };
    }
    resolutions.push({ path: conflict.path, content, bytes: Buffer.byteLength(content, "utf8") });
  }
  // No leftover check here on purpose: `allowed_destinations` IS the conflict
  // set, so the protocol already rejects any path the answer invented. Checking
  // it twice was dead code — mutation testing proved the second copy unreachable.
  return { ok: true, value: resolutions };
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * Writes and stages, and only for a set that is still exactly the one prepared.
 * The invocation is the authorization — which is why the currency check is not
 * optional: a conflict another process already resolved is not ours to touch.
 */
export async function applyFixGit(
  fs: FileSystemPort,
  git: GitPort,
  prepared: FixGitPrepared,
  resolutions: FixGitResolution[],
): Promise<SemanticParse<FixGitApplied>> {
  const fresh = await prepareFixGit(
    git,
    prepared.context.repo,
    prepared.context.alias,
    prepared.context.roles,
  );
  if (!fresh.ok) return fresh;
  if (fresh.value.request.input_digest !== prepared.request.input_digest) {
    return {
      ok: false,
      failure: {
        code: "SEMANTIC_STALE",
        message: "el set de conflictos cambió desde el prepare",
        action: "volvé a correr prepare: otro proceso tocó el merge",
      },
    };
  }

  const resolved: string[] = [];
  const staged: string[] = [];
  for (const resolution of resolutions) {
    const absolute = join(prepared.context.repo, resolution.path);
    try {
      await fs.writeText(absolute, resolution.content);
      resolved.push(resolution.path);
    } catch (err) {
      return { ok: false, failure: writeFailed(resolution.path, err, resolved, staged) };
    }
    try {
      await git.stagePath(prepared.context.repo, resolution.path);
      staged.push(resolution.path);
    } catch (err) {
      return { ok: false, failure: stageFailed(resolution.path, err, resolved, staged) };
    }
  }

  const remaining = await git.conflictedFiles(prepared.context.repo);
  return { ok: true, value: { resolved, staged, remaining } };
}

// ── commit (a separate, always-confirmed action) ─────────────────────────────

export async function commitFixGit(
  git: GitPort,
  repo: string,
  message: string,
  roles?: FixGitRoles,
): Promise<SemanticParse<{ committed: true; message: string }>> {
  // fix-git closes a merge; with no MERGE_HEAD there is none to close — and a
  // `merge --squash` staged the other branch with no MERGE_HEAD for any guard.
  if (!(await git.isMerging(repo))) return { ok: false, failure: notMerging(repo) };
  const forbidden = roles ? await devIntoWorkingBranch(git, repo, roles) : null;
  if (forbidden !== null) return { ok: false, failure: forbidden };
  const remaining = await git.conflictedFiles(repo);
  if (remaining.length > 0) {
    return {
      ok: false,
      failure: {
        code: "FIX_GIT_UNMERGED",
        message: `quedan ${remaining.length} archivo(s) sin resolver: ${remaining.join(", ")}`,
        action: "resolvé el resto antes de cerrar el merge",
      },
    };
  }
  try {
    await git.commit(repo, message);
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "COMMIT_FAILED",
        message: `git commit falló: ${errorText(err)}`,
        action: "revisá la salida de git (hooks incluidos) y reintentá",
      },
    };
  }
  return { ok: true, value: { committed: true, message } };
}

// ── PR-04: development never flows into a working branch ─────────────────────

/**
 * Whether the merge in progress brings the development branch into a working
 * branch, and why — or null.
 *
 * "Brings development" is read off development's first-parent history: the
 * integration merges `to-dev` makes stay on it, the feature commits that came
 * in through them do not. So a merge of development's own commits (those PROD
 * does not have) into a feature is refused, while a merge between two features
 * that both went through development is not. A feature that entered development
 * by fast-forward leaves its commits on that chain: the bias is to refuse, and
 * the person resolves that merge by hand.
 */
async function devIntoWorkingBranch(
  git: GitPort,
  repo: string,
  roles: FixGitRoles,
): Promise<SemanticFailure | null> {
  if (!(await git.isMerging(repo))) return null;
  const current = await git.currentBranch(repo);
  if (current === undefined || current === "HEAD" || !isWorkingBranch(current, roles)) return null;

  const prodRefs = await existingRefs(git, repo, roles.prod);
  // Every head: an octopus merge brings development just as well in its second.
  const incoming = new Set<string>();
  for (const head of await git.mergeHeads(repo)) {
    for (const sha of await git.revList(repo, head, ["HEAD"])) incoming.add(sha);
  }
  for (const dev of await existingRefs(git, repo, roles.dev)) {
    const own = await git.revList(repo, dev, prodRefs, { firstParent: true });
    const brought = own.find((sha) => incoming.has(sha));
    if (brought === undefined) continue;
    const whose = rolesBasisText(roles);
    return {
      code: "FIX_GIT_DEV_INTO_WORK",
      message: `PR-04: el merge en curso trae la rama de desarrollo ${shortRef(dev)} (commit ${brought.slice(0, 7)}) a la rama de trabajo ${current}; fix-git no lo prepara ni lo cierra (roles de la ${whose})`,
      action:
        "abortá el merge con `git merge --abort` y traé sólo la rama de PROD o la homónima de origin",
    };
  }
  return null;
}

export function rolesBasisText(roles: FixGitRoles): string {
  if (roles.owner !== null) return `fuente ${roles.owner}`;
  return roles.basis === "workspace-defaults"
    ? "valores por defecto del workspace: ninguna fuente es dueña del repo"
    : "mínimos del CLI: no hay bloque WORKSPACE que leer";
}

/** `refs/heads/<b>` and `refs/remotes/origin/<b>`, the ones that exist. */
async function existingRefs(git: GitPort, repo: string, branch: string): Promise<string[]> {
  const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
  const present: string[] = [];
  for (const ref of refs) if ((await git.refValue(repo, ref)) !== null) present.push(ref);
  return present;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, "");
}

// ── failures ─────────────────────────────────────────────────────────────────

function notMerging(repo: string): SemanticFailure {
  return {
    code: "NOT_MERGING",
    message: `'${repo}' no está en medio de un merge`,
    action: "no hay conflictos que resolver: revisá el repo o el alias",
  };
}

function notRepo(repo: string): SemanticFailure {
  return {
    code: "NOT_A_REPO",
    message: `'${repo}' no es un repositorio git`,
    action: "pasá --source <alias> o --path <ruta> de un repo válido",
  };
}

function unsupportedBinary(path: string): SemanticFailure {
  return {
    code: "FIX_GIT_BINARY",
    message: `'${path}' es binario: no se resuelve automáticamente`,
    action: "elegí una versión a mano (`git checkout --ours|--theirs`) y volvé a intentar el resto",
  };
}

function writeFailed(
  path: string,
  err: unknown,
  resolved: string[],
  staged: string[],
): SemanticFailure {
  return {
    code: "FIX_GIT_WRITE_FAILED",
    message: `no se pudo escribir '${path}': ${errorText(err)}`,
    action: `${describeProgress(resolved, staged)}; el resto sigue en conflicto y es identificable con \`git status\``,
  };
}

function stageFailed(
  path: string,
  err: unknown,
  resolved: string[],
  staged: string[],
): SemanticFailure {
  return {
    code: "FIX_GIT_STAGE_FAILED",
    message: `git add falló en '${path}': ${errorText(err)}`,
    action: `${describeProgress(resolved, staged)}; mirá \`git status\` para ver qué quedó sin stagear y reintentá`,
  };
}

function describeProgress(resolved: string[], staged: string[]): string {
  return `se escribieron ${resolved.length} archivo(s) y se stagearon ${staged.length}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
