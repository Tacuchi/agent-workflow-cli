import { reconcileHistory } from "../../application/history-reconcile-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const historyCommand: CliCommand = {
  name: "history",
  flags: { known: [], usage: "aw history reconcile" },
  describe:
    "Read-only comparison of HISTORY and local session folders. Usage: aw history reconcile.",
  async execute(args, ctx) {
    if (args.rest[0] !== "reconcile" || args.rest.length !== 1) {
      return fail("INVALID_INPUT", "uso: aw history reconcile");
    }
    return { ok: true, data: await reconcileHistory(ctx.fs, ctx.paths), exitCode: 0 };
  },
};
