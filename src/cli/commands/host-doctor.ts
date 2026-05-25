import { runHostDoctor } from "../../application/host-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const hostDoctorCommand: QtcCommand = {
  name: "host-doctor",
  describe:
    "Host-level health check: detecta dependencias externas faltantes (jq, etc.) requeridas por plugins instalados.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runHostDoctor(ctx.fs, ctx.env, ctx.process);
    return { ok: true, data, exitCode: 0 };
  },
};
