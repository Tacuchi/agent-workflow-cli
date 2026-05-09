import {
  type SessionCreateInput,
  runSessionCreate,
} from "../../application/session-create-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStdout } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionCreateCommand: QtcCommand = {
  name: "session-create",
  describe: "Create a new session: folder + OBJETIVO + HISTORY row + <NS>-PROJECT entry.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCreateInput = {};
    const flow = args.values.get("flow") ?? args.plugin.flow;
    if (flow !== undefined) input.flow = flow;
    const name = args.values.get("name");
    if (name !== undefined) input.name = name;
    const objetivo = args.values.get("objetivo");
    if (objetivo !== undefined) input.objetivo = objetivo;
    const branches = args.values.get("branches");
    if (branches !== undefined) input.branchesRaw = branches;
    const from = args.values.get("from");
    if (from !== undefined) input.origenRaw = from;
    const tipo = args.values.get("tipo") ?? args.values.get("type");
    if (tipo !== undefined) input.tipo = tipo;
    const modalidad = args.values.get("modalidad") ?? args.values.get("modality");
    if (modalidad !== undefined) input.modalidad = modalidad;

    const data = await runSessionCreate(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    writeStdout(`${JSON.stringify(data.projectMd, null, 2)}\n`);
    return { ok: true, data: data.sessionCreate, exitCode: 0 };
  },
};
