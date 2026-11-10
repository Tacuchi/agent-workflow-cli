import {
  type DiscardApplied,
  type DiscardPreview,
  applyDiscard,
  prepareDiscard,
} from "../../application/discard-abandoned.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type DiscardOutput = DiscardPreview | DiscardApplied;

const USAGE =
  "uso: aw discard prepare <spec:NNN|plan:PPP|ruta> | aw discard apply <objetivo> --approval <digest>";

/** `aw discard`: the spec or plan becomes `abandoned`; nothing is deleted (spec 066, D09). */
export const discardCommand: CliCommand<DiscardOutput> = {
  name: "discard",
  flags: { known: ["approval"], actions: { prepare: { known: [] }, apply: { known: [] } } },
  help: {
    purpose:
      "Mark a spec or plan abandoned without deleting it, keeping its number and every reference; no other document is touched.",
    flags: {
      approval: { value: "<digest>", effect: "apply only: the digest prepare returned." },
    },
    actions: {
      prepare: {
        purpose: "Preview the state change and its approval digest without writing.",
        args: "<spec:NNN|plan:PPP|path>",
        output:
          "{action: prepare, kind, target, from, to, untouched[], read_digest, digest, next}.",
        notes: ["Read-only. untouched lists the live plans of a spec: they keep their state."],
      },
      apply: {
        purpose: "Write abandoned into the document while it is still the one previewed.",
        args: "<spec:NNN|plan:PPP|path>",
        output: "{action: apply, kind, target, state, digest}.",
        notes: ["A document changed since the preview is refused with DOC_CHANGED_SINCE_READ."],
      },
    },
    notes: ["Opens no flow and creates no session. Recovering the document is a git operation."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<DiscardOutput>> {
    const [action, target] = args.rest;
    if ((action !== "prepare" && action !== "apply") || target === undefined) {
      return failSemantic({ code: "INVALID_INPUT", message: USAGE, action: USAGE });
    }
    if (action === "prepare") {
      const preview = await prepareDiscard(ctx.fs, ctx.env, ctx.paths, target);
      return preview.ok
        ? { ok: true, data: preview.value, exitCode: 0 }
        : failSemantic(preview.failure);
    }
    const approval = args.values.get("approval");
    if (approval === undefined || approval.trim() === "") {
      return failSemantic({
        code: "APPROVAL_REQUIRED",
        message: "discard apply exige --approval <digest>",
        action: `corré 'aw discard prepare ${target}' y aprobá el digest que muestra`,
      });
    }
    const applied = await applyDiscard(ctx.fs, ctx.env, ctx.paths, {
      target,
      approval: approval.trim(),
    });
    return applied.ok
      ? { ok: true, data: applied.value, exitCode: 0 }
      : failSemantic(applied.failure);
  },
  renderHuman(result): string {
    const data = result.data;
    if (!result.ok || data === undefined) return "";
    if (data.action === "prepare") {
      const kept = data.untouched.length > 0 ? `\nSin tocar: ${data.untouched.join(", ")}` : "";
      return `${data.target}: ${data.from} → abandoned (no se borra)${kept}\nPara aplicar: ${data.next}\n`;
    }
    return `${data.target}: abandoned\n`;
  },
};
