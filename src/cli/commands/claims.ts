import {
  applyRecovery,
  previewRecovery,
  sanctionedActionFor,
  scanSlots,
} from "../../application/claims-recovery.js";
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
  flags: {
    known: ["approval", "confirm-no-producer"],
    actions: { list: { known: [] }, recover: { known: [] } },
  },
  help: {
    purpose:
      "List reservations of numbered documents and legacy placeholders, and recover one with authorization.",
    flags: {
      approval: {
        value: "<digest>",
        effect: "recover only: the preview digest; seals the revocation and releases the slot.",
      },
      "confirm-no-producer": {
        effect:
          "recover only: state that nothing will still write there; required when the slot names nobody.",
      },
    },
    actions: {
      list: {
        purpose: "Show every recoverable slot; the default when no action is given.",
        output:
          "{slots[] ({path, kind, correlative, name, owner, revoked, intact, next}), error?}. Read-only.",
        notes: ["A published document is never a slot."],
      },
      recover: {
        purpose: "Preview the recovery of one slot, or apply it with the approved digest.",
        args: "<docs/<category>/<NNN>-<name>>",
        output:
          "Preview: {proposal {target, kind, claim, requires_no_producer_confirmation, digest, ...}, next}. Applied: {target, revoked, released, resumed, digest}.",
        notes: [
          "With --approval the revocation is IRREVOCABLE and scoped to that claim: a late sealed publication against it is rejected instead of colliding. Nothing ever expires on a timer. Refusals use CLAIM_RECOVERY_REFUSED.",
        ],
      },
    },
  },
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
            intact: slot.intact,
            next: sanctionedActionFor(slot),
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
