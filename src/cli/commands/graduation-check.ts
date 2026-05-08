import { runGraduationCheck } from "../../application/graduation-check-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const graduationCheckCommand: QtcCommand = {
  name: "graduation-check",
  describe:
    "Hub mode: detecta artefactos graduados a fuentes (docs/manuales|rfcs|post-mortems|analisis|refactors) sin breadcrumb en <hub>/docs/<categoria>/000-INDEX.md. Skip silencioso en project mode.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runGraduationCheck(ctx.fs, ctx.env);
    const hasWarn = data.findings.some((f) => f.level === "warn");
    return { ok: true, data, exitCode: hasWarn ? 1 : 0 };
  },
};
