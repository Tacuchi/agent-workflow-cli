import { runSqlMutationGuard } from "../../application/hook-sql-mutation-guard.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, writeStderr } from "../render.js";
import type { CliContext } from "../types.js";
import { preCompactHook, sessionEndHook } from "./checkpoint-write.js";
import { postCompactHook } from "./hook-post-compact.js";

/** The lifecycle targets the host runs, by subcommand. */
const LIFECYCLE_HOOKS: Readonly<Record<string, CliCommand>> = {
  "pre-compact": preCompactHook,
  "post-compact": postCompactHook,
  "session-end": sessionEndHook,
};

const SUBCOMMANDS = [...Object.keys(LIFECYCLE_HOOKS), "sql-mutation-guard"];

export const hookCommand: CliCommand = {
  name: "hook",
  flags: {
    known: [],
    mode: "warn",
    actions: Object.fromEntries(
      Object.entries(LIFECYCLE_HOOKS).map(([name, hook]) => [name, hook.flags]),
    ),
  },
  hook: true,
  help: {
    purpose:
      "Hook targets the host runs: pre-compact, post-compact and session-end around compaction and the end of a session, and sql-mutation-guard before a tool call.",
    args: SUBCOMMANDS.join(" | "),
    output:
      "pre-compact, post-compact and session-end: the JSON of the write or the resume payload, always exit 0. sql-mutation-guard: no data; the verdict is the exit code, and a block explains itself on stderr.",
    exit_codes: {
      "2": "sql-mutation-guard blocked the tool call: its SQL is not a plain read on a server outside AW_SQL_GUARD_ALLOW.",
    },
    notes: [
      "pre-compact, post-compact and session-end read the host payload on stdin, exit 0 whatever happens and report a degradation on stderr; outside a hub they exit 0 in silence.",
      "sql-mutation-guard reads the host hook payload on stdin (tool_name, tool_input). It passes (exit 0) when the runtime configures no SQL guard, AW_SQL_GUARD=off, the tool does not match the guarded pattern, the server is listed in AW_SQL_GUARD_ALLOW (comma separated) or the input carries no SQL. Anything but a closed list of reads (SELECT, VALUES, TABLE, SHOW) is blocked, including SQL that cannot be delimited or classified.",
    ],
    actions: Object.fromEntries(
      Object.entries(LIFECYCLE_HOOKS).map(([name, hook]) => [name, hook.help]),
    ),
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return fail("INVALID_INPUT", `hook requires a subcommand: ${SUBCOMMANDS.join(", ")}`);
    }
    // Each lifecycle target reads its own payload from stdin.
    const lifecycle = LIFECYCLE_HOOKS[subcommand];
    if (lifecycle !== undefined) return lifecycle.execute(args, ctx);
    // Bounded like the lifecycle hooks: run by hand from an agent's shell, fd 0
    // is an idle socket and an unbounded read would hang until the tool timeout.
    const stdin = (await readHookStdin()) ?? "";
    if (subcommand === "sql-mutation-guard") {
      const result = runSqlMutationGuard({
        stdin,
        env: ctx.env,
        runtime: ctx.runtime,
        paths: ctx.paths,
      });
      if (result.stderr) writeStderr(result.stderr);
      return { ok: true, data: undefined, exitCode: result.exitCode };
    }
    return fail("INVALID_INPUT", `hook: unknown subcommand '${subcommand}'`);
  },
};
