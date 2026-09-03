/**
 * `aw amend`: the direct correction of a closed document's wording.
 *
 * A CROSS-CUTTING command, like `reseal` and the retirement pair: it opens no
 * WorklineFlow and creates no session. There is nothing for a run to direct —
 * one act reads, checks, writes and records — and giving it a journey would cost
 * the bundle a document per invocation for a change nobody disagrees about.
 *
 * What it does NOT do is decide that a correction is editorial. The declaration
 * is recorded, and the structural guards refuse what moves the contract: a spec's
 * functional digest, or a plan's header, graph, closing clauses and batches. The
 * refinement stays the human's act, and this command never starts one — it only
 * names it when it refuses.
 */

import {
  type Amendment,
  type AmendmentEvent,
  amendDocument,
  amendmentsOf,
  revertAmendment,
} from "../../application/amend-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type Action = "apply" | "revert" | "list";

const ACTIONS = new Set<Action>(["apply", "revert", "list"]);

const USAGE =
  "uso: amend apply <spec|plan> --de <texto> --a <texto> --declaracion <motivo> | amend revert <id> | amend list [documento]";

export interface AmendApplyOutput {
  action: "apply";
  status: "applied";
  amendment: Amendment;
  written: string[];
}

export interface AmendRevertOutput {
  action: "revert";
  status: "reverted";
  amendment: Amendment;
  written: string[];
}

export interface AmendListOutput {
  action: "list";
  document: string | null;
  events: AmendmentEvent[];
}

export type AmendOutput = AmendApplyOutput | AmendRevertOutput | AmendListOutput;

function refuse(code: string, message: string, action: string): CommandResult<AmendOutput> {
  return failSemantic<AmendOutput>({ code, message, action });
}

export const amendCommand: CliCommand<AmendOutput> = {
  name: "amend",
  describe:
    "Correct the WORDING of an already closed spec or plan, in one act, without opening a refinement. " +
    "Cross-cutting: it opens no flow and creates no session. It demands an explicit declaration that the correction changes no scope, criteria or rules, " +
    "writes under the workspace lock with the document's own digest as the compare-and-swap base, and records the exact pre-image in an append-only ledger. " +
    "It refuses structurally what does touch the contract — a spec's functional content, or a plan's header, phase/task graph, closing clauses or batches — and names the refinement instead. " +
    "`revert` undoes one recorded correction. Usage: aw amend apply <documento> --de <texto> --a <texto> --declaracion <motivo> | aw amend revert <id> | aw amend list [documento].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<AmendOutput>> {
    const action = args.rest[0] as Action | undefined;
    if (action === undefined || !ACTIONS.has(action)) return refuse("INVALID_INPUT", USAGE, USAGE);

    if (action === "list") {
      const document = args.rest[1];
      const events = await amendmentsOf(ctx.fs, ctx.paths, document);
      return {
        ok: true,
        data: { action: "list", document: document ?? null, events },
        exitCode: 0,
      };
    }

    if (action === "revert") {
      const id = args.rest[1];
      if (id === undefined) return refuse("INVALID_INPUT", USAGE, USAGE);
      const reverted = await revertAmendment(ctx.fs, ctx.env, ctx.paths, id);
      if (reverted.status === "failed") {
        return refuse(reverted.failure.code, reverted.failure.message, reverted.failure.action);
      }
      return {
        ok: true,
        data: {
          action: "revert",
          status: "reverted",
          amendment: reverted.amendment,
          written: reverted.written,
        },
        exitCode: 0,
      };
    }

    const target = args.rest[1];
    const from = args.values.get("de");
    const to = args.values.get("a");
    const declaration = args.values.get("declaracion") ?? args.values.get("declaration");
    if (target === undefined || from === undefined || to === undefined) {
      return refuse("INVALID_INPUT", USAGE, USAGE);
    }
    const applied = await amendDocument(ctx.fs, ctx.env, ctx.paths, {
      target,
      from,
      to,
      declaration: declaration ?? "",
    });
    if (applied.status === "failed") {
      return refuse(applied.failure.code, applied.failure.message, applied.failure.action);
    }
    return {
      ok: true,
      data: {
        action: "apply",
        status: "applied",
        amendment: applied.amendment,
        written: applied.written,
      },
      exitCode: 0,
    };
  },

  renderHuman(result): string {
    if (!result.ok || result.data === undefined) return "";
    const data = result.data;
    if (data.action === "list") return renderList(data);
    const verb = data.action === "apply" ? "Corregido" : "Revertido";
    return [
      `${verb} ${data.amendment.document} · corrección ${data.amendment.id}`,
      `  de: ${preview(data.amendment.from)}`,
      `   a: ${preview(data.amendment.to)}`,
      `Declaración: ${data.amendment.declaration}`,
      `Escrito: ${data.written.join(", ")}`,
      data.action === "apply"
        ? `Para deshacerlo:\n  aw amend revert ${data.amendment.id}`
        : "La reversión quedó registrada como su propio evento.",
    ].join("\n");
  },
};

function renderList(data: AmendListOutput): string {
  const scope = data.document === null ? "el workspace" : data.document;
  if (data.events.length === 0) return `Sin correcciones directas registradas en ${scope}.`;
  const rows = data.events.map((event) => {
    const mark = event.event === "reverted" ? "revertida" : "vigente";
    return `  ${event.amendment.id}  ${event.at}  ${mark}  ${event.amendment.document}\n    de: ${preview(event.amendment.from)}\n     a: ${preview(event.amendment.to)}\n    declaración: ${event.amendment.declaration}`;
  });
  return [`Correcciones directas de ${scope} (origen: directo, no refinamiento):`, ...rows].join(
    "\n",
  );
}

/** One line of a fragment, so a long correction stays readable in a terminal. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 96 ? flat : `${flat.slice(0, 93)}…`;
}
