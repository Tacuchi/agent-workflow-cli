import { runVisibilityDoctor } from "../../application/visibility-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const visibilityCommand: QtcCommand = {
  name: "visibility",
  describe:
    "Inspector de visibilidad multi-root del hub. Subcomandos: doctor [--workspace dir] [--global] [--json].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (subcommand === "doctor") return runDoctorSub(args, ctx);
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "visibility requiere subcomando: doctor",
      },
      exitCode: 1,
    };
  },
};

async function runDoctorSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const workspace = args.values.get("workspace");
  const data = await runVisibilityDoctor(ctx.fs, ctx.env, ctx.paths, {
    ...(workspace !== undefined ? { workspace } : {}),
    global: args.flags.has("--global"),
  });

  const totalReports = data.reports.length + data.global_reports.length;
  const okCount = data.summary.ok;
  const allOk = okCount === totalReports;
  return {
    ok: allOk,
    data,
    ...(allOk
      ? {}
      : {
          error: {
            code: "VISIBILITY_DRIFT",
            message: `${totalReports - okCount}/${totalReports} reports con drift (ver data.reports/global_reports)`,
          },
        }),
    exitCode: allOk ? 0 : 1,
  };
}
