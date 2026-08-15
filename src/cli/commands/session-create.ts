import {
  type SessionCreateInput,
  runSessionCreate,
} from "../../application/session-create-service.js";
import { DEFAULT_CORE_DOCS_CANON } from "../../domain/docs-canon.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionCreateCommand: CliCommand = {
  name: "session-create",
  describe: `Create an internal session folder + SESSION.md and seal its custody (typed parents + byte-exact baseline of every declared input). Without --input the run's own document is DERIVED from the descriptor (\`<slug>-spec-refine\`/\`-plan-new\` seal ${DEFAULT_CORE_DOCS_CANON.spec}/NNN-spec-<slug>.md; \`-plan-refine\`/\`-plan-exec\` seal ${DEFAULT_CORE_DOCS_CANON.plan}/NNN-plan-<slug>.md); \`inputs_from\` reports which road was taken and \`inputs_note\` why none was. Flags: --type {research|refine|exec|quick} --name <folder> --objetivo <text> [--from <origin>] [--input <ruta-relativa> (repeatable)].`,
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCreateInput = {};
    const inputs = args.valuesMulti.get("input");
    if (inputs !== undefined) input.inputs = inputs;
    const type = args.values.get("type");
    if (type !== undefined) input.type = type;
    const name = args.values.get("name");
    if (name !== undefined) input.name = name;
    const objetivo = args.values.get("objetivo");
    if (objetivo !== undefined) input.objetivo = objetivo;
    const from = args.values.get("from");
    if (from !== undefined) input.originRaw = from;
    const contextId = readContextId(ctx.env);
    if (contextId !== undefined) input.contextId = contextId;

    const data = await runSessionCreate(ctx.fs, ctx.paths, input);
    if ("error" in data) {
      return fail(data.code ?? "INVALID_INPUT", data.error, data);
    }
    return { ok: true, data: data.sessionCreate, exitCode: 0 };
  },
};
