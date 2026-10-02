/**
 * `aw hubs`: the user's registry of hubs, run from any folder.
 *
 * Listing, scanning without `--apply` and `status` only read. `scan --apply`
 * and `prune` write `~/.<ns>/hubs.json` through the registry's single atomic
 * write, with the raw filesystem: the registry is user-level state and never
 * materializes a hub in the folder the command was launched from.
 */

import {
  type HubScan,
  type RegisteredHub,
  listRegisteredHubs,
  pruneHubs,
  registerScannedHubs,
  scanHubs,
  systemTempRoots,
} from "../../application/hub-registry.js";
import { type HubsStatusOutput, runHubsStatus } from "../../application/hubs-status-service.js";
import { type HubsSyncOutput, runHubsSync } from "../../application/hubs-sync-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";
import { statusNotices } from "./status.js";

type HubsOutput =
  | { action: "list"; hubs: RegisteredHub[] }
  | ({ action: "scan"; applied: boolean } & HubScan)
  | { action: "prune"; removed: RegisteredHub[] }
  | ({ action: "status" } & HubsStatusOutput)
  | ({ action: "sync" } & HubsSyncOutput);

const USAGE = "uso: hubs [scan [<carpeta>…] [--apply] | prune | status | sync --ide [--dry-run]]";

export const hubsCommand: CliCommand<HubsOutput> = {
  name: "hubs",
  flags: {
    known: [],
    actions: {
      scan: { known: ["apply"] },
      prune: { known: [] },
      status: { known: [] },
      sync: { known: ["ide", "dry-run"] },
    },
  },
  help: {
    purpose:
      "List the hubs registered on this machine with their state, from any folder; its actions scan, prune and summarize them.",
    output:
      "{action: list, hubs[] {name, root, state: ok|missing|not-a-hub|ephemeral}}. Read-only.",
    notes: [
      "The registry is ~/.<ns>/hubs.json. Every aw invocation registers the hub it resolves, except one under the system temp folder (os.tmpdir(), /tmp, /private/tmp): that is shown as ephemeral.",
      "A hub is named after its folder; two registered hubs sharing one are both named <parent>/<folder>.",
    ],
    actions: {
      scan: {
        purpose:
          "Find the hubs under each folder (3 levels deep, skipping node_modules, .git and hidden folders) and register them with --apply.",
        args: "[<folder>…]",
        flags: {
          apply: { effect: "Register what was found; without it nothing is written." },
        },
        output:
          "{action: scan, applied, found[], registered[], skipped[] {path, reason}}: found are the hubs it would register, registered the ones already known, skipped the .<ns>/ folders without a hub marker.",
        notes: [
          "Without a folder it scans the parents of the registered hubs. A folder counts only when it passes the hub marker check, never because .<ns>/ exists.",
        ],
      },
      prune: {
        purpose: "Remove from the registry every hub that is missing, not a hub or ephemeral.",
        output: "{action: prune, removed[] {name, root, state}}.",
      },
      status: {
        purpose:
          "One line per registered hub with its pending work, notices and next command, from the same reading aw status and aw resume use.",
        output:
          "{action: status, hubs[] ({name, root, ok: true, pending, next, notices, last_activity} | {name, root, ok: false, reason: missing|not-a-hub|unreadable}), counts {hubs, ok, pending, notices}}. Read-only.",
        notes: [
          "pending and notices are the counts of the default aw status board; next is the command aw resume proposes, or null with nothing pending. The size follows the number of hubs, never their history.",
        ],
      },
      sync: {
        purpose:
          "Project every ok hub onto the tools around it: --ide writes <hub>/<folder>.code-workspace with the hub and its sources.",
        flags: {
          ide: {
            effect:
              "Write the .code-workspace of each ok hub: the hub first, under its registry name, then each source with a resolved path. Only folders is replaced; every other key is kept.",
          },
          "dry-run": { effect: "Report what would change without writing anything." },
        },
        output:
          "{action: sync, dry_run, ide: {hubs[] {name, root, action: created|updated|unchanged|skipped, file, reason?, omitted_sources?[] {alias, reason}}} | null}.",
        notes: [
          "A hub that is not ok is skipped with its state as the reason, and so is a .code-workspace that is not a readable JSON object. A source path is relative when hub and source share a folder other than / and $HOME.",
          "In a hub inside a git repository, /<folder>.code-workspace is added to <hub>/.gitignore. The registry and each hub block are the only inputs: nothing is read back from the file.",
        ],
      },
    },
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<HubsOutput>> {
    const [action, ...rest] = args.rest;
    const fs = ctx.rawFs ?? ctx.fs;
    const home = ctx.env.homeDir();
    const namespace = ctx.paths.namespace;
    if (action === undefined) {
      const hubs = await listRegisteredHubs(fs, home, namespace, await systemTempRoots());
      return { ok: true, data: { action: "list", hubs }, exitCode: 0 };
    }
    if (action === "scan") {
      const scan = await scanHubs(fs, home, namespace, rest);
      const applied = args.flags.has("--apply");
      if (applied) await registerScannedHubs(fs, home, namespace, scan.found);
      return { ok: true, data: { action: "scan", applied, ...scan }, exitCode: 0 };
    }
    if (rest.length > 0) return fail("INVALID_INPUT", USAGE);
    if (action === "prune") {
      const removed = await pruneHubs(fs, home, namespace, await systemTempRoots());
      return { ok: true, data: { action: "prune", removed }, exitCode: 0 };
    }
    if (action === "sync") {
      if (!args.flags.has("--ide")) return fail("INVALID_INPUT", USAGE);
      const sync = await runHubsSync(fs, home, namespace, await systemTempRoots(), {
        ide: true,
        dryRun: args.flags.has("--dry-run"),
      });
      return { ok: true, data: { action: "sync", ...sync }, exitCode: 0 };
    }
    if (action === "status") {
      const status = await runHubsStatus(
        { fs, env: ctx.env, git: ctx.git },
        namespace,
        (board) => statusNotices(board).length,
      );
      return { ok: true, data: { action: "status", ...status }, exitCode: 0 };
    }
    return fail("INVALID_INPUT", USAGE);
  },

  renderHuman(result): string {
    const data = result.data;
    if (!result.ok || data === undefined) return "";
    if (data.action === "list") {
      if (data.hubs.length === 0) return "sin hubs registrados\n";
      return lines(data.hubs.map((hub) => `${hub.name}  ${hub.state}  ${hub.root}`));
    }
    if (data.action === "scan") {
      return lines([
        ...data.found.map((root) => `${data.applied ? "registrado" : "nuevo"}  ${root}`),
        ...data.registered.map((root) => `ya registrado  ${root}`),
        ...data.skipped.map((skip) => `rechazado  ${skip.path}  (${skip.reason})`),
        ...(data.found.length > 0 && !data.applied
          ? ["", "aw hubs scan --apply los registra"]
          : []),
      ]);
    }
    if (data.action === "prune") {
      if (data.removed.length === 0) return "nada que podar\n";
      return lines(data.removed.map((hub) => `quitado  ${hub.name}  ${hub.state}  ${hub.root}`));
    }
    if (data.action === "sync") return renderSync(data);
    if (data.hubs.length === 0) return "sin hubs registrados\n";
    return lines(
      data.hubs.map((hub) =>
        hub.ok
          ? `${hub.name}  ${hub.pending} pendientes · ${hub.notices} avisos · ${hub.next ?? "nada pendiente"}`
          : `${hub.name}  ${hub.reason}  ${hub.root}`,
      ),
    );
  },
};

function renderSync(data: HubsSyncOutput): string {
  const rows = (data.ide?.hubs ?? []).map((hub) =>
    [
      `ide  ${hub.name}  ${hub.action}`,
      hub.reason !== undefined ? `  (${hub.reason})` : `  ${hub.file}`,
      ...(hub.omitted_sources ?? []).map((source) => `  · sin ${source.alias}: ${source.reason}`),
    ].join(""),
  );
  return lines(data.dry_run ? [...rows, "", "--dry-run: no se escribió nada"] : rows);
}

function lines(rows: string[]): string {
  return rows.length === 0 ? "nada que mostrar\n" : `${rows.join("\n")}\n`;
}
