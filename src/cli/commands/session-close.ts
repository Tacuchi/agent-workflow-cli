import {
  type SessionCloseInput,
  runSessionClose,
} from "../../application/session-close-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStdout } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionCloseCommand: QtcCommand = {
  name: "session-close",
  describe: "Close a session: mark HISTORY as closed and remove from QTC-PROJECT.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCloseInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    const dec = args.values.get("graduated-decisions");
    if (dec !== undefined) input.graduatedDecisions = dec;
    const plan = args.values.get("graduated-plan");
    if (plan !== undefined) input.graduatedPlan = plan;
    const scripts = args.values.get("graduated-scripts");
    if (scripts !== undefined) input.graduatedScripts = scripts;
    const design = args.values.get("graduated-design");
    if (design !== undefined) input.graduatedDesign = design;
    const rfc = args.values.get("graduated-rfc");
    if (rfc !== undefined) input.graduatedRfc = rfc;
    const refs = args.values.get("refs");
    if (refs !== undefined) input.refs = refs;

    const data = await runSessionClose(ctx.fs, ctx.env, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    // Mirror Python: cmd_project_md_upsert prints first, then cmd_session_close prints.
    writeStdout(`${JSON.stringify(data.projectMd, null, 2)}\n`);
    return { ok: true, data: data.sessionClose, exitCode: 0 };
  },
};
