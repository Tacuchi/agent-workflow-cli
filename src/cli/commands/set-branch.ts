import { resolveSourceBranches } from "../../application/branch-resolver.js";
import { readWorkspaceBlock } from "../../application/parsers/project-block.js";
import { runProjectMdUpsertWrite } from "../../application/project-md-upsert-service.js";
import {
  type WorkingBranchResolution,
  ensureWorkingBranch,
} from "../../application/working-branch-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

/**
 * What happened to the branch before it was registered. An alias that is not
 * a declared source has no repo to check or create the branch in: it is still
 * registered, as before, and the output says so instead of staying silent.
 */
type BranchCheck =
  | { resolution: Extract<WorkingBranchResolution, { ok: true }> }
  | { notice: string }
  | { refusal: CommandResult };

type PrepareBranch = (alias: string, rama: string, ctx: CliContext) => Promise<BranchCheck>;

// set-working-branch and set-qa-branch are the same command modulo the label,
// the WORKSPACE-block key they write and — for the working branch only — the
// branch it makes sure exists first; the factory keeps them in lockstep.
function makeSetBranchCommand(
  name: string,
  label: string,
  key: "workingBranches" | "qaBranches",
  prepare?: PrepareBranch,
): CliCommand {
  return {
    name,
    describe:
      `Set the ${label} branch for a source in the WORKSPACE block. ` +
      `Usage: aw ${name} <alias> <rama>.`,
    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
      const alias = args.rest[0];
      const rama = args.rest[1];
      if (!alias || !rama) {
        return fail("INVALID_INPUT", `Usage: aw ${name} <alias> <rama>`);
      }

      const check = prepare ? await prepare(alias, rama, ctx) : null;
      if (check !== null && "refusal" in check) return check.refusal;

      const branches = { [alias]: rama };
      const data = await runProjectMdUpsertWrite(ctx.fs, ctx.env, ctx.paths, {
        op: "init",
        ...(key === "workingBranches" ? { workingBranches: branches } : { qaBranches: branches }),
        verbose: args.flags.has("--verbose"),
      });
      if ("error" in data) {
        // The branch may already exist by now: say so, so a retry is not a guess.
        return fail("INVALID_INPUT", data.error, withBranchCheck(data, check));
      }
      const payload = withBranchCheck(data, check);
      return { ok: data.ok, data: payload, exitCode: data.ok ? 0 : 1 };
    },
  };
}

/** The upsert's own payload, plus what happened to the branch when it was checked. */
function withBranchCheck(
  data: object,
  check: Exclude<BranchCheck, { refusal: CommandResult }> | null,
): object {
  if (check === null) return data;
  const branch = "notice" in check ? { notice: check.notice } : check.resolution;
  return { ...data, working_branch: branch };
}

/** The branch exists, is brought from its homonym, or is created from PROD — or nothing is registered. */
const ensureDeclaredWorkingBranch: PrepareBranch = async (alias, rama, ctx) => {
  const block = await readWorkspaceBlock(
    ctx.fs,
    ctx.paths.workspaceDir(),
    ctx.paths.blockMarkers(),
  );
  const source = block?.fuentes.find((s) => s.alias === alias);
  if (source === undefined) {
    return {
      notice: `${alias} no es una fuente declarada: la rama ${rama} se registró sin comprobarla ni crearla`,
    };
  }
  const prod = resolveSourceBranches(source, block).prod;
  const resolution = await ensureWorkingBranch(ctx.git, source, rama, prod);
  if (!resolution.ok) {
    return {
      refusal: fail(
        "WORKING_BRANCH_UNRESOLVED",
        `no se registró ${rama} para ${alias}: ${resolution.reason}`,
        resolution,
      ),
    };
  }
  return { resolution };
};

export const setWorkingBranchCommand = makeSetBranchCommand(
  "set-working-branch",
  "WORKING",
  "workingBranches",
  ensureDeclaredWorkingBranch,
);

export const setQaBranchCommand = makeSetBranchCommand("set-qa-branch", "QA", "qaBranches");
