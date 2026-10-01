import { reconcileHistory } from "../../application/history-reconcile-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const historyCommand: CliCommand = {
  name: "history",
  flags: { known: [], actions: { reconcile: { known: [] } } },
  help: {
    purpose: "Check the hub history file against the local session folders.",
    actions: {
      reconcile: {
        purpose:
          "List sessions missing from the history file and rows that contradict their folder.",
        output: "{missing_rows[], contradictory_rows[] ({session, state, reason})}. Read-only.",
      },
    },
  },
  async execute(args, ctx) {
    if (args.rest[0] !== "reconcile" || args.rest.length !== 1) {
      return fail("INVALID_INPUT", "uso: aw history reconcile");
    }
    return { ok: true, data: await reconcileHistory(ctx.fs, ctx.paths), exitCode: 0 };
  },
};
