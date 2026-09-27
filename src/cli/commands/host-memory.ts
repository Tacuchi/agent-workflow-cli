import { isHarnessId } from "../../application/dev-only-services.js";
import { runHostMemory } from "../../application/host-memory/report.js";
import { HARNESSES } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const FLAGS: CommandFlags = { known: ["host"], usage: "aw host-memory [--host <id>] --json" };
const HOST_IDS = HARNESSES.map((spec) => spec.id).join(" | ");

export const hostMemoryCommand: CliCommand = {
  name: "host-memory",
  flags: FLAGS,
  describe: `Read-only report of what the other hosts of this machine learned about Workline in their curated memory: one row per host with its state and reason, and each Workline learning with its id, host, date, source, provenance (native or a marked copy), origin mark, stale-command signals and whether the current host's destination already holds it. Also names where the current host would save, or why it has nowhere. Anything else is only counted. Writes nothing and logs nothing. Usage: aw host-memory [--host <${HOST_IDS}>] --json.`,
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
