import { applyCompaction } from "../../application/hub-compaction/apply.js";
import { inspectCompaction } from "../../application/hub-compaction/inspect.js";
import { inventoryHub } from "../../application/hub-compaction/inventory.js";
import type { CompactionDeps } from "../../application/hub-compaction/inventory.js";
import { compactionError } from "../../application/hub-compaction/paths.js";
import { prepareCompaction } from "../../application/hub-compaction/proposal.js";
import { applyRestore, prepareRestore } from "../../application/hub-compaction/restore.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const hubCompactCommand: CliCommand = {
  name: "hub-compact",
  flags: {
    known: [],
    actions: {
      inventory: { known: [] },
      prepare: { known: ["input-json"], required: ["input-json"] },
      apply: { known: ["input-json", "approval"], required: ["input-json", "approval"] },
      inspect: { known: ["path"] },
      restore: { known: ["path", "approval"] },
    },
  },
  help: {
    purpose: "Review hub knowledge and recoverable archives without opening a flow.",
    actions: {
      inventory: {
        purpose:
          "Inventory weights, provenance, exclusions and archive eligibility without writing.",
        output:
          "{version, root, fingerprint, entries[], relationships[], coverage, bytes, context}.",
      },
      prepare: {
        purpose:
          "Validate host-supplied claims and selection, and seal the exact view and archive proposal without writes.",
        flags: {
          "input-json": {
            value: "-",
            effect: "Read version, inventory_fingerprint, claims and selection from stdin.",
          },
        },
        output:
          "{version, id, request, inventory, originals, local {digest, artifacts, preview, effects}, view, catalog, policy}.",
      },
      apply: {
        purpose: "Revalidate and apply the approved proposal, or recover an interrupted operation.",
        flags: {
          "input-json": { value: "-", effect: "Read the same input supplied to prepare." },
          approval: {
            value: "<digest>",
            effect: "Required: the exact local.digest returned by prepare.",
          },
        },
        output: "{id, digest, status, already_applied, entries, view, storage, context}.",
      },
      inspect: {
        purpose:
          "Verify original integrity and inspect operation progress without restoring files.",
        args: "<id>",
        flags: {
          path: {
            value: "<original-path>",
            effect: "Inspect this original; content_base64 is included up to 1 MiB.",
          },
        },
        output: "{id, manifest, originals, integrity, complete}.",
      },
      restore: {
        purpose:
          "Preview restoration; apply it only with its approval digest, preserving the knowledge view.",
        args: "<id>",
        flags: {
          path: {
            value: "<original-path>",
            effect: "Restrict restoration to this path; repeatable.",
          },
          approval: {
            value: "<digest>",
            effect: "Apply the restoration just previewed; no overwrite of later content.",
          },
        },
        output:
          "Preview {id, paths, bases, manifest_digest, view, digest}; apply {id, digest, restored, status, view, already_applied}.",
      },
    },
    notes: [
      "No AI provider, flow, session, Git or SQL effect. prepare and apply accept JSON only with --input-json -. Originals with no gzip saving remain in place; net storage includes the catalog and the view.",
    ],
  },
  async execute(args, ctx) {
    if (!ctx.archive)
      return fail("COMPACTION_UNAVAILABLE", "Falta el puerto de archivo por streaming");
    // The sealed compaction owns its exact writes; implicit hub adoption would
    // change the inventory after approval and add an unreviewed effect.
    const deps = { ...ctx, fs: ctx.rawFs ?? ctx.fs, archive: ctx.archive };
    try {
      const data = await runCommand(args, deps);
      return { ok: true, exitCode: 0, data };
    } catch (error) {
      const failure = error as Error & { code?: string };
      return fail(failure.code ?? "COMPACTION_FAILED", failure.message);
    }
  },
  renderHuman(result) {
    return result.data === undefined ? "" : JSON.stringify(result.data, null, 2);
  },
};

async function runCommand(args: ParsedArgs, deps: CompactionDeps): Promise<unknown> {
  const [action, id] = args.rest;
  const paths = args.valuesMulti.get("path");
  const needsId = action === "inspect" || action === "restore";
  if (args.rest.length !== (needsId ? 2 : 1))
    throw compactionError("INPUT", "Argumentos posicionales inválidos");
  switch (action) {
    case "inventory":
      return inventoryHub(deps);
    case "prepare":
      return prepareCompaction(deps, await readInput(args));
    case "apply":
      return applyCompaction(deps, await readInput(args), args.values.get("approval") ?? "");
    case "inspect":
      if (paths && paths.length > 1) throw compactionError("INPUT", "inspect admite una sola ruta");
      return inspectCompaction(deps, id ?? "", paths?.[0]);
    case "restore": {
      const approval = args.values.get("approval");
      return approval === undefined
        ? prepareRestore(deps, id ?? "", paths)
        : applyRestore(deps, id ?? "", approval, paths);
    }
    default:
      throw compactionError("INPUT", "Uso: aw hub-compact inventory|prepare|apply|inspect|restore");
  }
}

async function readInput(args: ParsedArgs): Promise<unknown> {
  if (args.values.get("input-json") !== "-")
    throw compactionError("INPUT", "Usá --input-json - con JSON en stdin");
  const raw = await readRequiredStdin();
  if (Buffer.byteLength(raw) > 40 * 1024 * 1024)
    throw compactionError("SIZE_LIMIT", "Síntesis fuera del límite de 40 MiB");
  return JSON.parse(raw) as unknown;
}
