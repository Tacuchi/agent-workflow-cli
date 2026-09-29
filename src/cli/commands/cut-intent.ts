import {
  appendCutIntent,
  currentIntentOf,
  cutIntentLedgerPath,
  readCutIntents,
  readingForPlan,
} from "../../application/cut-intent-ledger.js";
import { CutIntentError } from "../../domain/cut-intent.js";
import type { CommandResult } from "../../domain/types.js";
import { type WorklineNodeId, formatNodeId } from "../../domain/workline-node.js";
import { nodeFromDocPath } from "../../domain/workline-node.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const USAGE =
  "uso: cut-intent [show] [--plan <NNN|ruta>] [--spec <NNN|ruta>] | cut-intent declare --spec <NNN|ruta> --order <NNN,NNN> [--deferred <NNN,…>] [--cause <texto>]";

/**
 * The order and grouping a person meant for a cut — declared, read back and
 * corrected.
 *
 * Its own surface rather than a flag on `status`, for the reason the record
 * exists: this is the ONE place a human intention enters the workspace, and
 * everything else derives from it. Folding the declaration into a board that
 * otherwise only reports would blur which of the two a given number came from.
 *
 * Correcting is declaring again. There is no edit verb and no delete verb,
 * because the ledger underneath has neither: the new record supersedes the old
 * one for reading and the old one stays readable above it, which is what makes a
 * reorder something a person can review instead of merely inherit.
 */
export const cutIntentCommand: CliCommand = {
  name: "cut-intent",
  flags: {
    known: ["spec", "order", "plan", "deferred", "cause"],
    actions: { show: { known: [] }, declare: { known: [] } },
  },
  help: {
    purpose: "Declare or read the intended order and grouping of the plans cut from one spec.",
    flags: {
      spec: {
        value: "<NNN|path>",
        effect: "Spec of the cut; required by declare, a filter for show.",
      },
      order: {
        value: "<NNN,NNN>",
        effect: "declare only, required: plans that go together, in execution order.",
      },
      plan: { value: "<NNN|path>", effect: "show only: answer for this one plan." },
      deferred: { value: "<NNN,...>", effect: "declare only: plans held back for a later pass." },
      cause: { value: "<text>", effect: "declare only: why this intent is declared." },
    },
    actions: {
      show: {
        purpose: "Read the intents in force; the default when no action is given.",
        output:
          "Whole book: {path, cuts[] ({spec, at, intent}), records, superseded, unreadable}. --spec: {spec, declared, at?, intent?, reason?}. --plan: {plan, declared, intent?, at?, position?, reason?}.",
        notes: [
          "A plan nobody declared gets an explicit declared: false with its reason, never an empty list.",
        ],
      },
      declare: {
        purpose: "Record the intent for one spec; declaring again is how it is corrected.",
        output: "{declared: true, at, intent {spec, order[], deferred[]}, path, supersedes}.",
        notes: [
          "The book is append-only under the workspace namespace: the superseded record is kept, never rewritten. It constrains nothing; executing out of the declared order is only warned about.",
        ],
      },
    },
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verb = args.rest[0] ?? "show";
    if (verb !== "show" && verb !== "declare")
      return fail("INVALID_INPUT", USAGE, { error: USAGE });

    if (verb === "show") return await show(args, ctx);
    return await declare(args, ctx);
  },
};

async function show(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const read = await readCutIntents(ctx.fs, ctx.paths);
  const planRef = flagValue(args, "plan");
  const specRef = flagValue(args, "spec");

  if (planRef !== undefined) {
    const plan = nodeOf(planRef, "plan");
    if (plan === null) return fail("INVALID_INPUT", refusal(planRef, "plan"), { error: USAGE });
    return {
      ok: true,
      data: { plan: formatNodeId(plan), ...readingForPlan(read, plan) },
      exitCode: 0,
    };
  }

  if (specRef !== undefined) {
    const spec = nodeOf(specRef, "spec");
    if (spec === null) return fail("INVALID_INPUT", refusal(specRef, "spec"), { error: USAGE });
    const current = currentIntentOf(read.events, spec);
    if (current === null) {
      return {
        ok: true,
        data: {
          spec: formatNodeId(spec),
          declared: false,
          reason: `nadie declaró una intención de corte para '${formatNodeId(spec)}'`,
          unreadable: read.unreadable,
        },
        exitCode: 0,
      };
    }
    return {
      ok: true,
      data: { spec: formatNodeId(spec), declared: true, at: current.at, intent: current.intent },
      exitCode: 0,
    };
  }

  // The whole book, current-first: one row per spec that has an intent in force,
  // and the superseded records counted rather than listed — they are history, and
  // a listing that mixed them with the current one would read as a contradiction.
  const specs = new Map<string, WorklineNodeId>();
  for (const event of read.events) specs.set(formatNodeId(event.intent.spec), event.intent.spec);
  const cuts = [...specs.values()]
    .map((spec) => currentIntentOf(read.events, spec))
    .filter((event): event is NonNullable<typeof event> => event !== null)
    .map((event) => ({
      spec: formatNodeId(event.intent.spec),
      at: event.at,
      intent: event.intent,
    }));
  return {
    ok: true,
    data: {
      path: cutIntentLedgerPath(ctx.paths),
      cuts,
      records: read.events.length,
      superseded: read.events.length - cuts.length,
      unreadable: read.unreadable,
    },
    exitCode: 0,
  };
}

async function declare(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const specRef = flagValue(args, "spec");
  const orderRef = flagValue(args, "order");
  if (specRef === undefined || orderRef === undefined) {
    return fail("INVALID_INPUT", USAGE, { error: USAGE });
  }
  const spec = nodeOf(specRef, "spec");
  if (spec === null) return fail("INVALID_INPUT", refusal(specRef, "spec"), { error: USAGE });

  const order = nodeList(orderRef);
  const deferred = nodeList(flagValue(args, "deferred") ?? "");
  if (order === null || deferred === null) {
    return fail("INVALID_INPUT", refusal(orderRef, "plan"), { error: USAGE });
  }

  const intent = { spec, order, deferred };
  const at = new Date().toISOString();
  const cause = flagValue(args, "cause");
  try {
    await appendCutIntent(ctx.fs, ctx.paths, {
      at,
      intent,
      ...(cause !== undefined ? { cause } : {}),
    });
  } catch (error) {
    if (error instanceof CutIntentError)
      return fail(error.code, error.message, { error: error.message });
    throw error;
  }

  const read = await readCutIntents(ctx.fs, ctx.paths);
  const previous = read.events.filter((e) => formatNodeId(e.intent.spec) === formatNodeId(spec));
  return {
    ok: true,
    data: {
      declared: true,
      at,
      intent,
      path: cutIntentLedgerPath(ctx.paths),
      // Said explicitly on a correction, because the value of an append-only
      // book is only real if the person can see that the earlier record survived.
      supersedes: previous.length - 1,
    },
    exitCode: 0,
  };
}

/**
 * A node from a bare correlative or from a workspace-relative document path.
 *
 * Both spellings are accepted because both are what a person has at hand: the
 * board prints numbers and the flows pass paths. The path form goes through
 * `nodeFromDocPath`, the one place that decides what a path IS, so this never
 * becomes a second spelling of that rule.
 */
function nodeOf(reference: string, kind: "spec" | "plan"): WorklineNodeId | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{3,}$/.test(trimmed)) return { kind, key: trimmed };
  const fromPath = nodeFromDocPath(trimmed);
  return fromPath !== null && fromPath.kind === kind ? fromPath : null;
}

function nodeList(raw: string): WorklineNodeId[] | null {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const nodes: WorklineNodeId[] = [];
  for (const part of parts) {
    const node = nodeOf(part, "plan");
    if (node === null) return null;
    nodes.push(node);
  }
  return nodes;
}

function refusal(reference: string, kind: "spec" | "plan"): string {
  return `'${reference}' no nombra ${kind === "spec" ? "una spec" : "un plan"}: usá su correlativo (por ejemplo 045) o su ruta en el workspace`;
}
