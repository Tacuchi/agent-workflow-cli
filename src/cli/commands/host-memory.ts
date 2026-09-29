import { isHarnessId } from "../../application/dev-only-services.js";
import { runHostMemory } from "../../application/host-memory/report.js";
import { HARNESSES } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const FLAGS: CommandFlags = { known: ["host"] };
const HOST_IDS = HARNESSES.map((spec) => spec.id).join(" | ");

export const hostMemoryCommand: CliCommand = {
  name: "host-memory",
  flags: FLAGS,
  help: {
    purpose:
      "Report what the other hosts on this machine learned about Workline in their curated memory.",
    flags: {
      host: {
        value: `<${HOST_IDS.replaceAll(" ", "")}>`,
        effect: "Report as this host instead of the detected one.",
      },
    },
    output:
      "{current_host {id, detected_via, destination, destination_reason}, hosts[] (state, reason), entries[] (id, host, date, source, provenance, origin mark, stale-command signals, already at destination)}.",
    notes: [
      "Read-only: writes nothing and logs nothing. Memory unrelated to Workline is only counted.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const host = args.values.get("host");
    if (host !== undefined && !isHarnessId(host)) {
      return fail("INVALID_INPUT", `--host inválido: '${host}'. Valores válidos: ${HOST_IDS}`);
    }
    // The table imports this module, so a static import would be a cycle that
    // builds it with this very command still undefined.
    const { ALL_COMMANDS } = await import("./index.js");
    const report = await runHostMemory(ctx, {
      ...(host !== undefined ? { host } : {}),
      commands: ALL_COMMANDS.map((command) => command.name),
    });
    return { ok: true, data: report, exitCode: 0 };
  },
};
