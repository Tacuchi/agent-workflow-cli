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
  flags: {
    known: ["type", "name", "objetivo", "from", "input", "allow-repeat"],
    required: ["type", "name", "objetivo"],
    repeatable: ["input"],
  },
  help: {
    purpose:
      "Create a session folder with its SESSION.md and seal the custody of the inputs it may modify.",
    flags: {
      type: { value: "<research|refine|exec|quick>", effect: "Kind of session." },
      name: {
        value: "<folder>",
        effect: "Session descriptor; it must end in a recognized flow, e.g. <slug>-plan-exec.",
      },
      objetivo: { value: "<text>", effect: "Objective recorded in SESSION.md." },
      from: {
        value: "<origin>",
        effect: "Plain origin of the session (who or where it came from).",
      },
      input: {
        value: "<relative-path>",
        effect: "Hub-relative artifact the run receives and may modify; its bytes are sealed.",
      },
      "allow-repeat": {
        effect: "Open a quick again although a closed quick with the same name exists.",
      },
    },
    output:
      "{type, name, number, folder, path, session_path, custody_path, inputs[], inputs_from (declared|derived|none), flow?, inputs_note?, origin?, registry_warning?, materialization}.",
    notes: [
      `Without --input the run's own document is derived from the descriptor: <slug>-spec-refine and <slug>-plan-new seal ${DEFAULT_CORE_DOCS_CANON.spec}/NNN-spec-<slug>.md; <slug>-plan-refine and <slug>-plan-exec seal ${DEFAULT_CORE_DOCS_CANON.plan}/NNN-plan-<slug>.md. inputs_from reports which road was taken and inputs_note why nothing was sealed.`,
      "spec-refine, plan-new and plan-refine sessions are born with their Success criteria seeded: the flow's fixed checklist plus the acceptance criteria of the spec they rest on. `aw flow start` creates the session and opens its run in one call.",
    ],
  },
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
    if (args.flags.has("--allow-repeat")) input.allowRepeat = true;

    const data = await runSessionCreate(ctx.rawFs ?? ctx.fs, ctx.paths, input, ctx.git);
    if ("error" in data) {
      return fail(data.code ?? "INVALID_INPUT", data.error, data);
    }
    return { ok: true, data: data.sessionCreate, exitCode: 0 };
  },
};
