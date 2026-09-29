import { runHostDoctor } from "../../application/host-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const hostDoctorCommand: CliCommand = {
  name: "host-doctor",
  flags: { known: [] },
  help: {
    purpose:
      "Check only the external dependencies (such as jq) that installed plugins require on this machine; for the whole installation use aw doctor.",
    output:
      "{status (ok|warn), findings[] {severity, dependency, message, install_hint {darwin, linux, win32}, required_by[], plugin_paths[]}}.",
    notes: ["Read-only."],
  },
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runHostDoctor(ctx.fs, ctx.env, ctx.process);
    return { ok: true, data, exitCode: 0 };
  },
};
