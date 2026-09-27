import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ConflictStages, GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import { type SourceBranchRoles, isWorkingBranch } from "./branch-resolver.js";
import {
  type SemanticFailure,
  type SemanticParse,
  type SemanticRequest,
  buildSemanticRequest,
  parseSemanticResponse,
  readEnvelopeScope,
  semanticDigest,
} from "./semantic-operation/protocol.js";
import type { PipelineValue } from "./source-pipeline.js";

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
  "Respondé un JSON con version, operation, input_digest y scope copiados del request,",
  "state='proposed' y un subconjunto de artifacts [{path,content}] y/o resolutions",
  "[{path,choice:'ours'|'theirs'|'delete'}]; sin duplicados ni marcadores. Para binarios",
  "usá ours|theirs; cuando falta una etapa, usá delete. Aplicá un subconjunto y repetí",
  "prepare para el resto. Con duda respondé state='ambiguous' con reason.",
].join(" ");

export interface ConflictSummary {
  path: string;
  base_hash: string | null;
  ours_hash: string | null;
  theirs_hash: string | null;
  binary: boolean;
  bytes: number;
  kind: "UU" | "AA" | "DU" | "UD" | "AU" | "UA" | "DD" | "AD";
  eol: "lf" | "crlf" | "none" | "mixed" | "binary";
  resolutions_allowed: Array<"ours" | "theirs" | "delete" | "content">;
  max_bytes: number;
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
  virtual_base?: { bases: string[] };
  conflicts: ConflictSummary[];
  adapted?: string[];
}

export interface FixGitPrepared {
  context: FixGitContext;
  request: SemanticRequest;
  stages: ConflictStages[];
  adapted: Array<{
    path: string;
    mode: string;
    hash: string;
    content: string | null;
    bytes: number;
  }>;
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
  options: { show?: string[]; adapt?: string[]; workspace?: string } = {},
): Promise<SemanticParse<FixGitPrepared>> {
  if (!(await git.isGitRepo(repo))) {
    return { ok: false, failure: notRepo(repo) };
  }
  if (!(await git.isMerging(repo))) return { ok: false, failure: notMerging(repo) };

  const forbidden = roles ? await devIntoWorkingBranch(git, repo, roles) : null;
  if (forbidden !== null) return { ok: false, failure: forbidden };

  const paths = await git.conflictedFiles(repo);
  const adapt = [...new Set(options.adapt ?? [])];
  if (paths.length === 0 && adapt.length === 0) {
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
  const adapted: FixGitPrepared["adapted"] = [];
  for (const path of adapt) {
    const entry = paths.includes(path) ? null : await git.indexEntry(repo, path);
    if (entry === null || !(await git.isWorktreeCleanPath(repo, path)))
      return {
        ok: false,
        failure: {
          code: "FIX_GIT_ADAPT_INVALID",
          message: `${path} no es un archivo trackeado y limpio fuera de los conflictos`,
          action: "usá --adapt sólo para una ruta trackeada y limpia; revisá git status",
        },
      };
    const blob = await git.readBlob(repo, entry.hash);
    adapted.push({ path, ...entry, ...blob });
  }
  const unknown = (options.show ?? []).filter(
    (path) => !paths.includes(path) && !adapt.includes(path),
  );
  if (unknown.length)
    return {
      ok: false,
      failure: {
        code: "FIX_GIT_SHOW_UNKNOWN",
        message: `--show no coincide con el set: ${unknown.join(", ")}`,
        action: "usá la ruta que figura en el inventario de conflictos",
      },
    };
  const bases = await git.mergeBases(repo);

  const context: FixGitContext = {
    repo,
    alias,
    ...(roles ? { roles } : {}),
    merge_origin: (await git.mergeOrigin(repo)) ?? null,
    current_branch: (await git.currentBranch(repo)) ?? null,
    ...(bases.length > 1 ? { virtual_base: { bases } } : {}),
    conflicts: [
      ...stages.map(summarize),
      ...adapted.map(
        (item): ConflictSummary => ({
          path: item.path,
          kind: "AD",
          base_hash: null,
          ours_hash: item.hash,
          theirs_hash: null,
          binary: item.content === null,
          bytes: item.bytes,
          eol: eolOf(item.content),
          resolutions_allowed:
            item.content === null ? ["ours", "delete"] : ["ours", "delete", "content"],
          max_bytes: Math.max(512 * 1024, 2 * item.bytes),
        }),
      ),
    ],
    ...(adapt.length ? { adapted: adapt } : {}),
  };

  const { conflicts: _conflicts, ...contextView } = context;

  const request = buildSemanticRequest({
    operation: OPERATION,
    // Sealed over the hashes, not the content: the seal must change exactly
    // when the conflict changes, and only then.
    inputs:
      options.workspace === undefined
        ? context.conflicts
        : { conflicts: context.conflicts, workspace: options.workspace },
    contract: CONTRACT,
    inventory: {
      context: contextView,
      conflicts: context.conflicts,
      ...(options.show?.length
        ? { stages: stages.filter((s) => options.show?.includes(s.path)).map(stageView) }
        : {}),
    },
    allowedDestinations: [...paths, ...adapt],
    limits: {
      ...LIMITS,
      max_artifact_bytes: Math.max(512 * 1024, ...context.conflicts.map((item) => item.max_bytes)),
    },
    resolutions: context.conflicts.map((item) => ({
      path: item.path,
      allowed: item.resolutions_allowed.filter(
        (choice): choice is "ours" | "theirs" | "delete" => choice !== "content",
      ),
      max_bytes: item.max_bytes,
    })),
    ...(options.workspace || adapt.length
      ? {
          scope: {
            ...(options.workspace ? { workspace: options.workspace } : {}),
            ...(adapt.length ? { adapt } : {}),
          },
        }
      : {}),
    readSet: [...paths, ...adapt],
    readSetBytes:
      stages.reduce((sum, s) => sum + totalBytes(s), 0) +
      adapted.reduce((sum, s) => sum + s.bytes, 0),
  });

  return { ok: true, value: { context, request, stages, adapted } };
}

function eolOf(content: string | null): ConflictSummary["eol"] {
  if (content === null) return "binary";
  if (!content.includes("\n")) return "none";
  if (content.includes("\r\n") && content.replace(/\r\n/g, "").includes("\n")) return "mixed";
  return content.includes("\r\n") ? "crlf" : "lf";
}

function summarize(stages: ConflictStages): ConflictSummary {
  const present = (key: keyof Pick<ConflictStages, "base" | "ours" | "theirs">) =>
    stages[key].hash !== null;
  const kind = !present("base")
    ? !present("ours")
      ? "UA"
      : !present("theirs")
        ? "AU"
        : "AA"
    : !present("ours") && !present("theirs")
      ? "DD"
      : !present("ours")
        ? "DU"
        : !present("theirs")
          ? "UD"
          : "UU";
  const content = stages.ours.content ?? stages.theirs.content ?? stages.base.content;
  const eol = stages.binary ? "binary" : eolOf(content);
  return {
    path: stages.path,
    base_hash: stages.base.hash,
    ours_hash: stages.ours.hash,
    theirs_hash: stages.theirs.hash,
    binary: stages.binary,
    bytes: totalBytes(stages),
    kind,
    eol,
    resolutions_allowed: [
      ...(present("ours") ? ["ours" as const] : []),
      ...(present("theirs") ? ["theirs" as const] : []),
      "delete",
      ...(stages.binary ? [] : ["content" as const]),
    ],
    max_bytes: Math.max(
      512 * 1024,
      2 * Math.max(stages.base.bytes, stages.ours.bytes, stages.theirs.bytes),
    ),
  };
}

function stageView(stages: ConflictStages): Record<string, unknown> {
  return {
    path: stages.path,
    binary: stages.binary,
    base: stages.base.content,
    ours: stages.ours.content,
    theirs: stages.theirs.content,
    modes: {
      base: stages.base.mode ?? null,
      ours: stages.ours.mode ?? null,
      theirs: stages.theirs.mode ?? null,
    },
  };
}

function totalBytes(stages: ConflictStages): number {
  return stages.base.bytes + stages.ours.bytes + stages.theirs.bytes;
}

// ── validate ─────────────────────────────────────────────────────────────────

export type FixGitResolution =
  | { path: string; content: string; bytes: number }
  | { path: string; choice: "ours" | "theirs" | "delete" };

export function validateFixGit(
  raw: string,
  prepared: FixGitPrepared,
): SemanticParse<FixGitResolution[]> {
  const parsed = parseSemanticResponse(raw, prepared.request);
  if (!parsed.ok) return parsed;
  if (
    semanticDigest(readEnvelopeScope(raw) ?? null) !==
    semanticDigest(prepared.request.scope ?? null)
  ) {
    return {
      ok: false,
      failure: {
        code: "FIX_GIT_SCOPE_CHANGED",
        message: "el alcance adaptado no coincide con el prepare",
        action: "copiá scope del request y reintentá",
      },
    };
  }

  const resolutions: FixGitResolution[] = [];
  for (const { path, content } of parsed.value.artifacts ?? []) {
    const conflict = prepared.context.conflicts.find((candidate) => candidate.path === path);
    if (conflict?.binary) return { ok: false, failure: unsupportedBinary(path) };
    if (CONFLICT_MARKER.test(content)) {
      return {
        ok: false,
        failure: {
          code: "FIX_GIT_MARKERS_LEFT",
          message: `'${path}' conserva marcadores de conflicto`,
          action: "entregá el archivo resuelto completo, sin <<<<<<< ======= >>>>>>>",
        },
      };
    }
    resolutions.push({ path, content, bytes: Buffer.byteLength(content, "utf8") });
  }
  resolutions.push(...(parsed.value.resolutions ?? []));
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
    prepared.adapted.length ? { adapt: prepared.adapted.map((item) => item.path) } : {},
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
    const stage = prepared.stages.find((candidate) => candidate.path === resolution.path);
    const adapted = prepared.adapted.find((candidate) => candidate.path === resolution.path);
    const reference =
      adapted?.content ?? stage?.ours.content ?? stage?.theirs.content ?? stage?.base.content ?? "";
    const mode =
      adapted?.mode ?? stage?.ours.mode ?? stage?.theirs.mode ?? stage?.base.mode ?? "100644";
    const absolute = join(prepared.context.repo, resolution.path);
    try {
      if ("choice" in resolution && resolution.choice === "delete") {
        if ((await fs.lstat(absolute))?.type === "dir") {
          return {
            ok: false,
            failure: {
              code: "FIX_GIT_PATH_CHANGED",
              message: `${resolution.path} es ahora un directorio`,
              action: "quitá la colisión y repetí prepare sin borrar contenido ajeno",
            },
          };
        }
        await fs.remove(absolute);
        await git.removeIndexEntry(prepared.context.repo, resolution.path);
      } else if ("choice" in resolution) {
        const chosen = resolution.choice === "ours" ? stage?.ours : stage?.theirs;
        const hash = adapted?.hash ?? chosen?.hash;
        const chosenMode = adapted?.mode ?? chosen?.mode ?? mode;
        if (!hash)
          return {
            ok: false,
            failure: {
              code: "FIX_GIT_STAGE_MISSING",
              message: `${resolution.path}: no existe la etapa ${resolution.choice}`,
              action: "usá delete si la etapa no existe",
            },
          };
        await git.setIndexEntry(prepared.context.repo, resolution.path, chosenMode, hash);
      } else {
        const normalized = resolution.content.replace(/\r+\n/g, "\n");
        const content =
          eolOf(reference) === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
        const hash = await git.hashBlob(prepared.context.repo, content);
        await git.setIndexEntry(prepared.context.repo, resolution.path, mode, hash);
      }
      resolved.push(resolution.path);
      staged.push(resolution.path);
    } catch (err) {
      return { ok: false, failure: writeFailed(resolution.path, err, resolved, staged) };
    }
  }

  const remaining = await git.conflictedFiles(prepared.context.repo);
  return { ok: true, value: { resolved, staged, remaining } };
}

// ── commit (a separate, always-confirmed action) ─────────────────────────────

export type FixGitBuild =
  | { status: "run"; command: string; origin: string }
  | { status: "skipped"; reason: string; origin: string }
  | { status: "undeclared"; action: string; origin: string };

export interface FixGitCommitPreview {
  message: string;
  build: FixGitBuild;
  included: string[];
  left_out: string[];
  tree_differs: boolean;
}

export interface FixGitCommitOptions {
  process: ProcessPort;
  pipeline: PipelineValue;
  origin: string;
  skipBuildReason?: string;
}

export async function previewFixGitCommit(
  git: GitPort,
  repo: string,
  message: string,
  roles: FixGitRoles | undefined,
  options: Pick<FixGitCommitOptions, "pipeline" | "origin" | "skipBuildReason">,
): Promise<SemanticParse<FixGitCommitPreview>> {
  if (!(await git.isMerging(repo))) return { ok: false, failure: notMerging(repo) };
  const forbidden = roles ? await devIntoWorkingBranch(git, repo, roles) : null;
  if (forbidden !== null) return { ok: false, failure: forbidden };
  const remaining = await git.conflictedFiles(repo);
  if (remaining.length > 0)
    return {
      ok: false,
      failure: {
        code: "FIX_GIT_UNMERGED",
        message: `quedan ${remaining.length} archivo(s) sin resolver: ${remaining.join(", ")}`,
        action: "resolvé el resto antes de cerrar el merge",
      },
    };
  const changes = await git.localChanges(repo);
  const included = changes.filter((item) => item.staged).map((item) => item.path);
  const left_out = changes
    .filter((item) => item.unstaged || item.untracked)
    .map((item) => item.path);
  const build: FixGitBuild =
    options.skipBuildReason !== undefined
      ? { status: "skipped", reason: options.skipBuildReason, origin: "--skip-build" }
      : options.pipeline.kind === "command"
        ? { status: "run", command: options.pipeline.command, origin: options.origin }
        : options.pipeline.kind === "none"
          ? { status: "skipped", reason: "ninguno declarado", origin: options.origin }
          : { status: "undeclared", action: options.pipeline.action, origin: options.origin };
  return {
    ok: true,
    value: { message, build, included, left_out, tree_differs: left_out.length > 0 },
  };
}

export async function commitFixGit(
  git: GitPort,
  repo: string,
  message: string,
  roles?: FixGitRoles,
  options?: FixGitCommitOptions,
): Promise<
  SemanticParse<{
    committed: true;
    message: string;
    build: FixGitBuild;
    left_out: string[];
    tree_differs: boolean;
  }>
> {
  const resolved = options ?? {
    pipeline: {
      kind: "undeclared" as const,
      action: "aw set-pipeline <alias> build <comando|ninguno>",
    },
    origin: "sin fuente",
    process: null,
  };
  const preview = await previewFixGitCommit(git, repo, message, roles, resolved);
  if (!preview.ok) return preview;
  if (preview.value.build.status === "undeclared")
    return {
      ok: false,
      failure: {
        code: "FIX_GIT_BUILD_UNDECLARED",
        message: "esta fuente no declara build; no se confirmó el merge",
        action: preview.value.build.action,
      },
    };
  const stagedBefore = await Promise.all(
    preview.value.included.map((path) => git.indexEntry(repo, path)),
  );
  if (preview.value.build.status === "run") {
    if (resolved.process === null)
      return {
        ok: false,
        failure: {
          code: "FIX_GIT_BUILD_UNDECLARED",
          message: "falta ejecutor de build",
          action: "configurá la fuente y repetí commit",
        },
      };
    const build = preview.value.build;
    try {
      const platform = process.platform === "win32";
      const result = await resolved.process.run(
        platform ? "cmd" : "sh",
        platform ? ["/d", "/s", "/c", build.command] : ["-c", build.command],
        { cwd: repo, timeoutMs: 600_000 },
      );
      if (result.code !== 0)
        return {
          ok: false,
          failure: {
            code: "FIX_GIT_BUILD_FAILED",
            message: `build falló con código ${result.code}: ${`${result.stdout}\n${result.stderr}`.slice(-2048)}`,
            action:
              "corregí el build o declará una omisión explícita con --skip-build <motivo>; el merge sigue abierto",
          },
        };
    } catch (err) {
      return {
        ok: false,
        failure: {
          code: "FIX_GIT_BUILD_FAILED",
          message: `build falló: ${errorText(err)}`,
          action: "revisá el comando o el tiempo máximo de 600000 ms; el merge sigue abierto",
        },
      };
    }
  }
  const after = await git.localChanges(repo);
  const nowIncluded = after.filter((item) => item.staged).map((item) => item.path);
  const stagedAfter = await Promise.all(nowIncluded.map((path) => git.indexEntry(repo, path)));
  if (
    nowIncluded.join("\0") !== preview.value.included.join("\0") ||
    stagedAfter.some(
      (entry, index) =>
        entry?.hash !== stagedBefore[index]?.hash || entry?.mode !== stagedBefore[index]?.mode,
    )
  )
    return {
      ok: false,
      failure: {
        code: "FIX_GIT_STAGED_CHANGED",
        message: "el build cambió qué entra al commit; el merge sigue abierto",
        action: "revisá git status y repetí la vista previa",
      },
    };
  const left_out = after.filter((item) => item.unstaged || item.untracked).map((item) => item.path);
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
  return {
    ok: true,
    value: {
      committed: true,
      message,
      build: preview.value.build,
      left_out,
      tree_differs: left_out.length > 0,
    },
  };
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
    message: `'${path}' es binario: no acepta content de texto`,
    action: "elegí la versión entera con resolution ours|theirs en fix-git",
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
    message: `no se pudo aplicar al índice '${path}': ${errorText(err)}`,
    action: `${describeProgress(resolved, staged)}; el resto sigue en conflicto y es identificable con \`git status\``,
  };
}

function describeProgress(resolved: string[], staged: string[]): string {
  return `se escribieron ${resolved.length} archivo(s) y se stagearon ${staged.length}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
