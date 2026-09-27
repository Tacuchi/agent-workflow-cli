import { findOwningSource, resolveSourceBranches } from "../../application/branch-resolver.js";
import {
  type FixGitApplied,
  type FixGitContext,
  type FixGitRoles,
  applyFixGit,
  commitFixGit,
  prepareFixGit,
  rolesBasisText,
  validateFixGit,
} from "../../application/fix-git-service.js";
import { runMergeState } from "../../application/merge-state-service.js";
import { readWorkspaceBlock, requireSourcePath } from "../../application/parsers/project-block.js";
import type {
  SemanticFailure,
  SemanticRequest,
} from "../../application/semantic-operation/protocol.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail, failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type FixGitData =
  | { stage: "prepare"; context: FixGitContext; request: SemanticRequest }
  | ({ stage: "apply" } & FixGitApplied)
  | { stage: "commit"; committed: true; message: string };

export const fixGitCommand: CliCommand<FixGitData> = {
  name: "fix-git",
  flags: { known: ["path", "source", "message", "confirm"] },
  describe:
    "Resuelve conflictos de merge inequívocos: prepara las tres versiones, valida la resolución semántica y stagea solo archivos aún en conflicto. " +
    "El commit es una acción aparte y confirmada; nunca --no-verify, --amend ni push. " +
    "Usage: aw fix-git prepare | apply | commit --message <msg> --confirm  [--source <alias> | --path <ruta>].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<FixGitData>> {
    const stage = args.rest[0];
    if (stage !== "prepare" && stage !== "apply" && stage !== "commit") {
      return fail(
        "ARGS_INVALID",
        "uso: aw fix-git prepare | apply | commit --message <msg> --confirm",
      );
    }

    const target = await resolveRepo(args, ctx);
    if (target === null) {
      return fail(
        "REPO_NOT_FOUND",
        "no se pudo resolver el repositorio: pasá --source <alias> o --path <ruta>",
      );
    }
    if ("error" in target) {
      return fail(target.alias === null ? "REPO_NOT_FOUND" : "SOURCE_PATH_MISSING", target.error);
    }

    const roles = await rolesOf(ctx, target);
    if ("failure" in roles) return failSemantic(roles.failure);
    if (stage === "commit") return await runCommit(args, ctx, target.path, roles);

    const prepared = await prepareFixGit(ctx.git, target.path, target.alias, roles);
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

    const validated = validateFixGit(await readRequiredStdin(), prepared.value);
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
    return `fix-git · merge cerrado con: ${data.message}\n`;
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
  lines.push("");
  for (const conflict of context.conflicts) {
    const kind = conflict.binary ? " · BINARIO (resolución manual)" : "";
    lines.push(`  ${conflict.path} (${conflict.bytes} B)${kind}`);
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
  // Closing a merge is an external effect, so it never rides on the same
  // invocation that resolved the files.
  if (!args.flags.has("--confirm")) {
    return fail(
      "CONFIRMATION_REQUIRED",
      "cerrar el merge es una acción separada: repetí con --confirm si el mensaje es el correcto",
    );
  }
  const result = await commitFixGit(ctx.git, repo, message, roles);
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
): Promise<
  { path: string; alias: string | null } | { alias: string | null; error: string } | null
> {
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
        return { alias: declared.alias, error: (err as Error).message };
      }
    }
  }
  const state = await runMergeState(ctx.fs, ctx.git, ctx.env, ctx.paths, {
    ...(source !== undefined ? { source } : {}),
    ...(path !== undefined ? { path } : {}),
  });
  const repo = state.repos[0];
  if (repo === undefined) return null;
  if (repo.error !== undefined) return { alias: repo.alias, error: repo.error };
  if (!(await ctx.fs.exists(repo.path))) {
    return { alias: repo.alias, error: `no existe el repositorio en este host: ${repo.path}` };
  }
  return { path: repo.path, alias: repo.alias };
}
