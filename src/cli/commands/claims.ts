import { applyRecovery, previewRecovery, scanSlots } from "../../application/claims-recovery.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const USAGE =
  "uso: claims [list] | claims recover <docs/<cat>/<NNN>-<nombre>> [--approval <digest>] [--confirm-no-producer]";

/**
 * The reservations nobody is coming back for, and the one sanctioned way to free
 * one.
 *
 * A separate surface on purpose. Releasing a correlative is not retiring a
 * document and not closing a session: it is its own authorization boundary, with
 * its own irrevocable side effect, and folding it into `aw discard` would put
 * "give a number back" behind the vocabulary of "retire work for good". Here the
 * authorization is where a person can see it.
 */
export const claimsCommand: CliCommand = {
  name: "claims",
  describe:
    "Reservations of numbered documents and legacy placeholders, plus the authorized recovery of one. 'claims' or 'claims list' shows every recoverable slot with its correlative, destination, owner and state — a published document is never one. 'claims recover <ruta>' previews the recovery and returns its digest; adding --approval <digest> seals an IRREVOCABLE revocation scoped to that claim and only then releases the slot, so a late sealed publication against it is rejected instead of colliding. A legacy placeholder names nobody, so freeing it also needs --confirm-no-producer: an explicit statement that nothing is still going to write there. Never expires anything on a timer. Usage: aw claims [list] | aw claims recover <ruta> [--approval <digest>] [--confirm-no-producer].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verb = args.rest[0] ?? "list";

    if (verb === "list") {
      const scan = await scanSlots(ctx.fs, ctx.paths);
      return {
        ok: true,
        data: {
          slots: scan.slots.map((slot) => ({
            path: slot.path,
            kind: slot.kind,
            correlative: slot.correlative,
            name: slot.name,
            owner: slot.owner,
            revoked: slot.revoked,
            // The sanctioned action, named per slot: a reservation of a live
            // session is resumed or closed by its owner, and only a slot nobody
            // is finishing is recovered.
            next:
              slot.kind === "legacy-placeholder"
                ? `aw claims recover ${slot.path} --confirm-no-producer`
                : `aw claims recover ${slot.path}`,
          })),
          ...(scan.error !== undefined ? { error: scan.error } : {}),
        },
        exitCode: 0,
      };
    }

    if (verb !== "recover") {
      return fail("INVALID_INPUT", USAGE, { error: USAGE });
    }

    const target = args.rest[1];
    if (target === undefined || target.length === 0) {
      return fail("INVALID_INPUT", USAGE, { error: USAGE });
    }
    const approval = args.values.get("approval");
    if (approval === undefined) {
      const preview = await previewRecovery(ctx.fs, ctx.paths, target);
      if ("error" in preview) {
        return fail("CLAIM_RECOVERY_REFUSED", preview.error, preview);
      }
      return {
        ok: true,
        data: {
          proposal: preview.proposal,
          next: `aw claims recover ${target} --approval ${preview.proposal.digest}${
            preview.proposal.requires_no_producer_confirmation ? " --confirm-no-producer" : ""
          }`,
        },
        exitCode: 0,
      };
    }

    const applied = await applyRecovery(ctx.fs, ctx.paths, {
      target,
      approval,
      noProducerConfirmed: args.flags.has("--confirm-no-producer"),
    });
    if ("error" in applied) {
      return fail("CLAIM_RECOVERY_REFUSED", applied.error, applied);
    }
    return { ok: true, data: applied.applied, exitCode: 0 };
  },
};
