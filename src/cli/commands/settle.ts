/**
 * `aw settle`: saldar las obligaciones de un plan sin recorrido abierto.
 *
 * The closure of a `plan-exec` run settles its own obligations. This is the
 * other half — a plan blocked today, whose run closed long ago — and it exists
 * because the only alternative was surgery on `docs/decisions/`.
 *
 * CROSS-CUTTING: it opens no flow and creates no session. And it has `reseal`'s
 * two steps for `reseal`'s reason, which is the rule written on both: two steps
 * only when a person ASSERTS something in between. Here they assert that the
 * compensatory work was done, or that it was somebody else's all along.
 */

import {
  type SettleApplication,
  type SettleListing,
  type SettlePlanned,
  applySettle,
  listSettle,
  prepareSettle,
} from "../../application/settle-service.js";
import { readingMark } from "../../domain/reconciliation.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type Action = "list" | "prepare" | "apply";

const ACTIONS = new Set<Action>(["list", "prepare", "apply"]);

const USAGE =
  "uso: settle list <plan> | settle prepare <plan> [--settle 'DEC-001[0]=<evidencia>'] [--handoff 'DEC-001[1]'] [--pending 'DEC-002[0]'] | settle apply <plan> <mismos flags> --approval <digest>";

export interface SettleListOutput {
  action: "list";
  listing: SettleListing;
}

export interface SettlePrepareOutput {
  action: "prepare";
  /** `listed` when nothing was declared: a reading, with nothing to approve. */
  status: "prepared" | "listed";
  listing: SettleListing;
  planned: SettlePlanned[];
  /** The seal to approve; `null` when nothing was declared. */
  digest: string | null;
  /** The exact command that applies exactly this; `null` when nothing is owed. */
  next: string | null;
}

export interface SettleApplyOutput {
  action: "apply";
  status: "applied";
  listing: SettleListing;
  published: string[];
  settled: string[];
  closable: boolean;
}

export type SettleOutput = SettleListOutput | SettlePrepareOutput | SettleApplyOutput;

function refuse(code: string, message: string, action: string): CommandResult<SettleOutput> {
  return failSemantic<SettleOutput>({ code, message, action });
}

/** The three flags, each repeatable: a plan owes as many obligations as it owes. */
function declarationsOf(args: ParsedArgs) {
  return {
    settle: args.valuesMulti.get("settle") ?? [],
    handoff: args.valuesMulti.get("handoff") ?? [],
    pending: args.valuesMulti.get("pending") ?? [],
  };
}

export const settleCommand: CliCommand<SettleOutput> = {
  name: "settle",
  describe:
    "Settle or acknowledge the live obligations of a plan whose decision notes still block its closure, when no execution run is open on it. " +
    "Cross-cutting: it opens no flow and creates no session. `list` shows each obligation with its note, position, class, whether the class was declared and the plan's CURRENT resume point; " +
    "`prepare` derives the same settlement note the closure derives, writes nothing, and returns the preview plus the digest that authorizes it; " +
    "`apply` re-derives everything from the live workspace, demands that digest and publishes under the lock. " +
    "With an execution run open on the plan it refuses and names that run. " +
    "Usage: aw settle list|prepare|apply <ruta del plan|correlativo> [--settle 'DEC-001[0]=<evidencia>'] [--handoff 'DEC-001[1]'] [--pending 'DEC-002[0]'] [--approval <digest>].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<SettleOutput>> {
    const action = args.rest[0] as Action | undefined;
    const target = args.rest[1];
    if (action === undefined || !ACTIONS.has(action) || target === undefined) {
      return refuse("INVALID_INPUT", USAGE, USAGE);
    }

    if (action === "list") {
      const listed = await listSettle(ctx.fs, ctx.env, ctx.paths, target);
      if (listed.status === "failed") {
        return refuse(listed.failure.code, listed.failure.message, listed.failure.action);
      }
      return { ok: true, data: { action: "list", listing: listed.listing }, exitCode: 0 };
    }

    if (action === "prepare") {
      const prepared = await prepareSettle(
        ctx.fs,
        ctx.env,
        ctx.paths,
        target,
        declarationsOf(args),
      );
      if (prepared.status === "failed") {
        return refuse(prepared.failure.code, prepared.failure.message, prepared.failure.action);
      }
      if (prepared.status === "listed") {
        return {
          ok: true,
          data: {
            action: "prepare",
            status: "listed",
            listing: prepared.listing,
            planned: [],
            digest: null,
            next: null,
          },
          exitCode: 0,
        };
      }
      return {
        ok: true,
        data: {
          action: "prepare",
          status: "prepared",
          listing: prepared.listing,
          planned: prepared.planned,
          digest: prepared.digest,
          next: prepared.next,
        },
        exitCode: 0,
      };
    }

    const approval = args.values.get("approval");
    if (approval === undefined || approval.trim().length === 0) {
      const missing = `settle apply exige --approval <digest>: corré 'aw settle prepare ${target}' con las mismas declaraciones y aprobá el digest que muestra`;
      return refuse("APPROVAL_REQUIRED", missing, missing);
    }
    const applied: SettleApplication = await applySettle(ctx.fs, ctx.env, ctx.paths, {
      target,
      approval: approval.trim(),
      declarations: declarationsOf(args),
    });
    if (applied.status === "failed") {
      return refuse(applied.failure.code, applied.failure.message, applied.failure.action);
    }
    return {
      ok: true,
      data: {
        action: "apply",
        status: "applied",
        listing: applied.listing,
        published: applied.published,
        settled: applied.settled,
        closable: applied.reconciliation.closable,
      },
      exitCode: 0,
    };
  },

  renderHuman(result, context): string {
    if (!result.ok || result.data === undefined) return "";
    const data = result.data;
    if (data.action === "list") return renderListing(data.listing);
    if (data.action === "prepare") return renderPrepare(data, context);
    return renderApply(data);
  },
};

/** Each obligation with the one thing that decides about it: its class. */
function renderListing(listing: SettleListing): string {
  const lines = [
    `Obligaciones vigentes de ${listing.plan}`,
    `Spec: ${listing.spec}`,
    `Punto vigente: ${listing.current_point}`,
    "",
  ];
  if (listing.compensations.length === 0) {
    lines.push("Compensación: ninguna — nada bloquea el cierre por reconciliación.");
  } else {
    lines.push("Compensación (bloquea el cierre):");
    for (const obligation of listing.compensations) lines.push(...obligationLines(obligation));
  }
  if (listing.handoffs.length > 0) {
    lines.push("", "Traspaso (no bloquea):");
    for (const obligation of listing.handoffs) lines.push(...obligationLines(obligation));
  }
  lines.push("", listing.closable ? "El plan es cerrable." : "El plan NO es cerrable todavía.");
  return lines.join("\n");
}

/**
 * One obligation, with everything that decides about it.
 *
 * The legacy mark goes on BOTH classes and not only on compensations: a legacy
 * handoff is the non-blocking reading, so it is the one most worth flagging as
 * a reading somebody supplied rather than a class the note stated. And the point
 * the note declared is printed even when it is stale — that is the audit trail,
 * and the current point sits right above it for the contrast.
 */
function obligationLines(obligation: SettleListing["compensations"][number]): string[] {
  const marks = [
    obligation.legacy ? readingMark(obligation.kind) : null,
    obligation.corresponds_to === null
      ? null
      : `el plan lo enumera: «${obligation.corresponds_to}»`,
    `la nota dijo: ${obligation.declared_point}`,
  ].filter((mark): mark is string => mark !== null);
  return [
    `  ${obligation.note}[${obligation.index}] ${obligation.text}`,
    `    ${marks.join(" · ")}`,
  ];
}

function renderPrepare(data: SettlePrepareOutput, context: HumanRenderContext): string {
  const lines = [renderListing(data.listing)];
  if (data.status === "listed") {
    lines.push(
      "",
      "No declaraste ningún saldo. Para saldar una obligación:",
      `  aw settle prepare ${data.listing.plan} --settle 'DEC-001[0]=<la salida real de lo que lo prueba>'`,
    );
    return lines.join("\n");
  }
  lines.push("", "Lo que se publicaría:");
  for (const planned of data.planned) {
    lines.push(
      `  sucesor de ${planned.note} · sesión ${planned.execution.session}, fase ${planned.execution.phase}`,
    );
    for (const settled of planned.settled) {
      // La evidencia se imprime porque es lo ÚNICO que la persona aportó: todo
      // lo demás lo derivó el CLI, y aprobar sin verla sería aprobar de memoria.
      lines.push(`    suelta: ${settled.text}`, `      evidencia: ${settled.evidence}`);
    }
    for (const keep of planned.keeps) {
      lines.push(
        `    conserva: ${keep.text} [${keep.kind === "handoff" ? "traspaso" : "compensación"}${keep.declared ? "" : ", clase sin declarar"}]`,
      );
    }
  }
  lines.push(
    "",
    "Aprobar esto AFIRMA que el trabajo se hizo, o que era de otra gente. La nota de saldo queda en la cadena y es sustituible a su vez.",
    "",
    `Para aplicar exactamente esto:\n  ${data.next ?? ""}`,
  );
  if (context.detail) lines.push("", `Digest: ${data.digest ?? "—"}`);
  return lines.join("\n");
}

function renderApply(data: SettleApplyOutput): string {
  const lines = [`Saldo publicado en ${data.listing.plan}: ${data.published.join(", ")}`];
  if (data.settled.length > 0) lines.push(`Saldado: ${data.settled.join("; ")}`);
  lines.push(
    data.closable
      ? "El plan queda cerrable."
      : "El plan sigue con compensación vigente: 'aw settle list' dice cuál.",
  );
  return lines.join("\n");
}
