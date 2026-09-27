import { findOwningSource, resolveSourceBranches } from "../../application/branch-resolver.js";
import {
  type FixGitApplied,
  type FixGitBuild,
  type FixGitCommitPreview,
  type FixGitContext,
  type FixGitRoles,
  applyFixGit,
  commitFixGit,
  prepareFixGit,
  previewFixGitCommit,
  rolesBasisText,
  validateFixGit,
} from "../../application/fix-git-service.js";
import { runMergeState } from "../../application/merge-state-service.js";
import { readWorkspaceBlock, requireSourcePath } from "../../application/parsers/project-block.js";
import {
  type SemanticFailure,
  type SemanticRequest,
  readEnvelopeScope,
} from "../../application/semantic-operation/protocol.js";
import { type PipelineValue, readSourcePipelines } from "../../application/source-pipeline.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail, failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type FixGitData =
  | { stage: "prepare"; context: FixGitContext; request: SemanticRequest }
  | ({ stage: "apply" } & FixGitApplied)
  | {
      stage: "commit";
      committed: true;
      message: string;
      build: FixGitBuild;
      left_out: string[];
      tree_differs: boolean;
    }
  | { stage: "commit"; committed: false; preview: FixGitCommitPreview };

export const fixGitCommand: CliCommand<FixGitData> = {
  name: "fix-git",
  flags: { known: ["path", "source", "message", "confirm", "show", "adapt", "skip-build"] },
  describe:
    "Resume conflictos de merge, muestra versiones con --show y aplica resoluciones parciales sin git add. " +
    "El commit compila, avisa left_out y exige confirmación; nunca --no-verify, --amend ni push. " +
    "Usage: aw fix-git prepare [--show <ruta> ...] [--adapt <ruta> ...] | apply | commit --message <msg> [--confirm] [--skip-build <motivo>] [--source <alias> | --path <ruta>].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<FixGitData>> {
    const stage = args.rest[0];
    if (stage !== "prepare" && stage !== "apply" && stage !== "commit") {
      return fail(
        "ARGS_INVALID",
        "uso: aw fix-git prepare | apply | commit --message <msg> --confirm",
      );
    }

    const target = await resolveRepo(args, ctx);
    if (target !== null && "failure" in target) return target.failure;
    if (target === null) {
      return fail(
        "REPO_NOT_FOUND",
        "no se pudo resolver el repositorio: pasá --source <alias> o --path <ruta>",
      );
    }
    const roles = await rolesOf(ctx, target);
    if ("failure" in roles) return failSemantic(roles.failure);
    if (stage === "commit") return await runCommit(args, ctx, target.path, roles);

    const raw = stage === "apply" ? await readRequiredStdin() : null;
    const scope = raw === null ? null : readEnvelopeScope(raw);
    const echoedAdapt =
      scope !== null && typeof scope === "object" && "adapt" in scope && Array.isArray(scope.adapt)
        ? scope.adapt.filter((item): item is string => typeof item === "string")
        : undefined;
    const adapt = stage === "prepare" ? args.valuesMulti.get("adapt") : echoedAdapt;
    const show = stage === "prepare" ? args.valuesMulti.get("show") : undefined;
    const prepared = await prepareFixGit(ctx.git, target.path, target.alias, roles, {
      ...(show ? { show } : {}),
      ...(adapt ? { adapt } : {}),
    });
    if (!prepared.ok) return failSemantic(prepared.failure);

    if (stage === "prepare") {
      return {
        ok: true,
        data: {
          stage: "prepare",
          context: prepared.value.context,
          request: prepared.value.request,
        },
        exitCode: 0,
      };
    }

    const validated = validateFixGit(raw ?? "", prepared.value);
    if (!validated.ok) return failSemantic(validated.failure);

    // No approval digest here, unlike `persist`: for an unambiguous, still-current
    // conflict set the invocation IS the authorization (spec 012 — confirmations
    // are proportional to risk). Ambiguity never reaches this line.
    const applied = await applyFixGit(ctx.fs, ctx.git, prepared.value, validated.value);
    if (!applied.ok) return failSemantic(applied.failure);
    return { ok: true, data: { stage: "apply", ...applied.value }, exitCode: 0 };
  },

  renderHuman(result: CommandResult<FixGitData>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    if (data.stage === "prepare") return renderPrepare(data.context, data.request, context.detail);
    if (data.stage === "apply") {
      const lines = [
        `fix-git · resueltos ${data.resolved.length}, stageados ${data.staged.length}`,
        data.remaining.length === 0
          ? "  Sin conflictos restantes: podés cerrar el merge."
          : `  Quedan sin resolver: ${data.remaining.join(", ")}`,
        "",
        "  El commit es una acción aparte:",
        '  aw fix-git commit --message "<mensaje>" --confirm',
      ];
      return `${lines.join("\n")}\n`;
    }
    if (!data.committed) return `fix-git · vista previa ${data.preview.message}\n`;
    return `fix-git · merge cerrado con: ${data.message}\n  Build: ${data.build.status}${data.build.status === "skipped" ? ` (${data.build.reason}; ${data.build.origin})` : ` (${data.build.origin})`}\n  Queda afuera: ${data.left_out.join(", ") || "nada"}${data.tree_differs ? "\n  Build corrió sobre un árbol distinto del commit" : ""}\n`;
  },
};

function renderPrepare(context: FixGitContext, request: SemanticRequest, detail: boolean): string {
  const lines = [
    `fix-git · ${context.conflicts.length} conflicto(s) en ${context.alias ?? context.repo}`,
    `  Merge      ${context.merge_origin ?? "?"} → ${context.current_branch ?? "?"}`,
  ];
  if (context.roles !== undefined && context.roles.owner === null) {
    lines.push(`  Roles      ${rolesBasisText(context.roles)}`);
  }
  if (context.virtual_base)
    lines.push(
      `  Base virtual (${context.virtual_base.bases.length} bases): ${context.virtual_base.bases.join(", ")}`,
    );
  lines.push("");
  for (const conflict of context.conflicts) {
    lines.push(
      `  ${conflict.path} (${conflict.kind}; ${conflict.bytes} B; ${conflict.eol}; ${conflict.resolutions_allowed.join("|")})`,
    );
  }
  const shown =
    (
      request.inventory as {
        stages?: Array<{
          path: string;
          base: string | null;
          ours: string | null;
          theirs: string | null;
        }>;
      }
    ).stages ?? [];
  for (const stage of shown) {
    lines.push("", `  Versiones ${stage.path}:`);
    for (const side of ["base", "ours", "theirs"] as const) {
      lines.push(`  ${side}: ${stage[side] ?? "(ausente o binario)"}`);
    }
  }
  if (detail) lines.push("", `  Request ${request.metrics.request_bytes} B`, "", request.contract);
  return `${lines.join("\n")}\n`;
}

async function runCommit(
  args: ParsedArgs,
  ctx: CliContext,
  repo: string,
  roles: FixGitRoles,
): Promise<CommandResult<FixGitData>> {
  const message = args.values.get("message");
  if (message === undefined || message.trim().length === 0) {
    return fail("ARGS_INVALID", "commit exige --message <mensaje>");
  }
  const skipBuildReason = args.values.get("skip-build");
  if (
    args.flags.has("--skip-build") ||
    (skipBuildReason !== undefined && !skipBuildReason.trim())
  ) {
    return fail("ARGS_INVALID", "--skip-build exige un motivo no vacío entre comillas");
  }
  const owner = roles.owner;
  const pipeline =
    owner === null
      ? null
      : (await readSourcePipelines(ctx.fs, ctx.paths)).find((s) => s.alias === owner);
  const build: PipelineValue = pipeline?.build ?? {
    kind: "undeclared",
    action: `aw set-pipeline ${owner ?? "<alias>"} build <comando|ninguno>`,
  };
  const origin = pipeline?.origin ?? "fuente sin pipeline declarado";
  const options = {
    process: ctx.process,
    pipeline: build,
    origin,
    ...(skipBuildReason ? { skipBuildReason: skipBuildReason.trim() } : {}),
  };
  const preview = await previewFixGitCommit(ctx.git, repo, message, roles, options);
  if (!preview.ok) return failSemantic(preview.failure);
  // Closing a merge is an external effect, so it never rides on the same
  // invocation that resolved the files.
  if (!args.flags.has("--confirm")) {
    return fail(
      "CONFIRMATION_REQUIRED",
      `Vista previa: ${message}; build ${preview.value.build.status}${preview.value.build.status === "run" ? ` ${preview.value.build.command}` : ""}; entran ${preview.value.included.join(", ") || "ninguno"}; left_out ${preview.value.left_out.join(", ") || "nada"}. Repetí con --confirm si corresponde`,
      { stage: "commit", committed: false, preview: preview.value } as const,
    );
  }
  const result = await commitFixGit(ctx.git, repo, message, roles, options);
  if (!result.ok) return failSemantic(result.failure);
  return { ok: true, data: { stage: "commit", ...result.value }, exitCode: 0 };
}

/**
 * The branch roles of the source that owns the repo — by alias, by its
 * declared path, or by the `aw/*` unit it sits in — so `--source`, `--path`,
 * the cwd and a worktree all get the same PR-04 guard. With no owner, the
 * workspace defaults: the same chain `resolveSourceBranches` applies elsewhere.
 */
async function rolesOf(
  ctx: CliContext,
  target: { path: string; alias: string | null },
): Promise<FixGitRoles | { failure: SemanticFailure }> {
  const block = await readWorkspaceBlock(
    ctx.fs,
    ctx.paths.workspaceDir(),
    ctx.paths.blockMarkers(),
  );
  const sources = block?.fuentes ?? [];
  const unitsRoot = await ctx.fs.realPath(ctx.paths.userUnitsDir()).catch(() => undefined);
  const repo = await ctx.fs.realPath(target.path).catch(() => target.path);
  const owner =
    sources.find((s) => s.alias === target.alias) ??
    findOwningSource(sources, repo, unitsRoot) ??
    findOwningSource(sources, target.path, unitsRoot);
  // An `aw/*` unit is a checkout of some source, but from inside it — no flags,
  // its own root — no WORKSPACE block says which one, nor its branch roles: the
  // unit's key is a one-way hash of the workspace path. Guessing the CLI floor
  // there would let development through under a name it does not have.
  if (owner === null && unitsRoot !== undefined && repo.startsWith(`${unitsRoot}/`)) {
    return {
      failure: {
        code: "FIX_GIT_ROLES_UNKNOWN",
        message: `no se pudieron leer los roles de rama de '${target.path}': es una unidad aw/* y no hay bloque WORKSPACE que la declare`,
        action: "invocá fix-git desde el workspace con --source <alias> o --path <unidad>",
      },
    };
  }
  const roles = resolveSourceBranches(
    owner ?? { alias: "", path: target.path, main_branch: "" },
    block,
  );
  const basis = owner !== null ? "source" : block !== null ? "workspace-defaults" : "cli-floor";
  return { ...roles, owner: owner?.alias ?? null, basis };
}

async function resolveRepo(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<{ path: string; alias: string | null } | { failure: CommandResult<FixGitData> } | null> {
  // `source` and `path` are MULTI_VALUE_FLAGS: they route to `valuesMulti`,
  // so `values.get()` silently returns undefined. `flagValue` reads both.
  const source = flagValue(args, "source");
  const path = flagValue(args, "path");
  if (path !== undefined) {
    const block = await readWorkspaceBlock(
      ctx.fs,
      ctx.paths.workspaceDir(),
      ctx.paths.blockMarkers(),
    );
    const declared = block?.fuentes.find(
      (item) => item.path === path || item.declared_path === path,
    );
    if (declared !== undefined) {
      try {
        await requireSourcePath(ctx.fs, declared);
      } catch (err) {
        return { failure: fail("SOURCE_PATH_MISSING", (err as Error).message) };
      }
    }
  }
  const state = await runMergeState(ctx.fs, ctx.git, ctx.env, ctx.paths, {
    ...(source !== undefined ? { source } : {}),
    ...(path !== undefined ? { path } : {}),
  });
  if (state.unreadable.length) {
    const missing = state.unreadable.find(
      (entry) => entry.code === "SOURCE_PATH_MISSING" && entry.alias !== null,
    );
    if (missing !== undefined) {
      return { failure: fail("SOURCE_PATH_MISSING", missing.action) };
    }
    return {
      failure: fail(
        "MERGE_STATE_UNREADABLE",
        `no se pudo consultar todo el estado de merge: ${state.unreadable.map((r) => `${r.code} ${r.alias ?? r.path}: ${r.action}`).join("; ")}`,
      ),
    };
  }
  const merging = state.repos.filter((r) => r.is_merging);
  if (merging.length > 1) {
    return {
      failure: fail(
        "MULTIPLE_MERGES",
        `hay más de un repositorio en merge: ${merging.map((r) => `${r.alias ?? r.path}${r.unit ? ` (${r.unit})` : ""}`).join(", ")}; elegí uno con --path`,
      ),
    };
  }
  const repo = merging[0] ?? state.repos[0];
  return repo === undefined ? null : { path: repo.path, alias: repo.alias };
}
