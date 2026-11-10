import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";
import { type DocumentVerbResult, documentVerb, renderDocumentHuman } from "./flow-documents.js";
import {
  PLAN_RUN_VERBS,
  type PlanRunVerbResult,
  isPlanRunVerb,
  planRunVerb,
} from "./flow-plan-run.js";

type FlowResult = DocumentVerbResult | PlanRunVerbResult;

const VERBS = ["read", "save", ...PLAN_RUN_VERBS] as const;

/**
 * `aw flow` in 31.0.0 (spec 066, ID03): every call derives its position from the
 * spec or plan and from git; nothing is kept between turns — no run file, no
 * attempt counter. Human approvals travel in the conversation as digests.
 */
export const flowCommand: CliCommand<FlowResult> = {
  name: "flow",
  flags: {
    known: ["flow"],
    actions: {
      read: { known: ["doc"] },
      save: { known: ["doc", "slug", "read-digest", "approval"] },
      "propose-commit": { known: ["source", "message", "path"], repeatable: ["path"] },
      commit: { known: ["source", "message", "path", "approval"], repeatable: ["path"] },
      "close-batch": { known: ["plan", "batch", "read-digest"] },
      finish: { known: ["plan", "read-digest"] },
      unit: { known: ["plan", "batch", "source"] },
    },
  },
  help: {
    purpose:
      "Drive SPEC, PLAN and QUICK without stored state: read where a document stands, save it against the digest read, close a batch in its plan and commit by an approved digest.",
    flags: {
      flow: {
        value: "<flow>",
        effect: "read/save: spec-new, spec-refine, plan-new, plan-refine; read also plan-exec.",
      },
    },
    notes: [
      "Nothing is kept between calls: each one derives its position from the document's state field, its boxes and git. A refused answer costs nothing and is simply sent again.",
      "Every write of a spec or plan quotes the read_digest its read returned; a document changed since then is refused with DOC_CHANGED_SINCE_READ and nothing is written.",
    ],
    actions: {
      read: {
        purpose:
          "Read where a document flow stands from the document alone, with the digest this instance read. Writes nothing.",
        flags: {
          doc: {
            value: "<path>",
            effect: "Hub-relative spec or plan the flow reads; spec-new takes none.",
          },
        },
        output: "{flow, doc, read_digest, state, next, destination}.",
        notes: ["The read_digest lives in the conversation: quote it back on save or close-batch."],
      },
      save: {
        purpose:
          "Save a document flow's result from stdin: without --approval it returns the sealed preview and its approval digest; with that digest it writes only the flow's document.",
        flags: {
          doc: { value: "<path>", effect: "The document read; plan-new reads its spec." },
          slug: { value: "<slug>", effect: "Slug of the new document (spec-new, plan-new)." },
          "read-digest": {
            value: "<digest>",
            effect: "The read_digest 'aw flow read' returned; a changed document is refused.",
          },
          approval: { value: "<digest>", effect: "The approval digest the preview returned." },
        },
        output:
          "Preview {status: preview, flow, target, approval, content_digest, state}; written {status: written, flow, path, digest, state}.",
        notes: [
          "The CLI seals the state: spec-new draft, spec-refine ready-for-plan, plan-new and plan-refine ready (draft while Open questions remain). New documents take the next correlative of docs/ by exclusive creation.",
        ],
      },
      "propose-commit": {
        purpose:
          "Propose a commit of exact paths of one source, sealed by a digest of HEAD, the message and each path's bytes. Writes nothing.",
        flags: {
          source: { value: "<alias>", effect: "Source alias, or hub." },
          message: { value: "<text>", effect: "One-line commit message." },
          path: { value: "<path>", effect: "Repo-relative path to commit; repeatable." },
        },
        output: "{repo, head, message, paths[] {path, digest}, approval}.",
        notes: [
          "QUICK and plan-exec use the same pair: git is QUICK's only record. In the hub only specs, plans and the deliverables of docs/diagrams, docs/manuals, docs/reports and docs/scripts are accepted.",
        ],
      },
      commit: {
        purpose:
          "Commit exactly the proposed paths while the approval still matches the tree; a path changed after the proposal makes it stale.",
        flags: {
          source: { value: "<alias>", effect: "Source alias, or hub." },
          message: { value: "<text>", effect: "The proposed message." },
          path: { value: "<path>", effect: "The proposed paths; repeatable." },
          approval: { value: "<digest>", effect: "The approval the proposal returned." },
        },
        output: "{hash, paths[]}.",
        notes: ["COMMIT_PROPOSAL_STALE: propose again and ask for a new approval."],
      },
      "close-batch": {
        purpose:
          "Close one batch in the plan from its validations' output: boxes, phase states, next step and at most five evidence lines with the commit hashes.",
        flags: {
          plan: { value: "<path>", effect: "Hub-relative plan." },
          batch: { value: "<Bn>", effect: "The batch of ## Execution batches." },
          "read-digest": {
            value: "<digest>",
            effect: "The read_digest of 'aw flow read --flow plan-exec'.",
          },
        },
        output: "{plan, batch, phases[], state, next_step, digest}.",
        notes: [
          "stdin: {validations [{command, passed, output}], evidence {validated, failed?, pending?, external?}, commits {alias: hash}}.",
        ],
      },
      finish: {
        purpose:
          "Close the plan after its final validation: every phase validada, > Estado: done, the next step removed and > Cierre: dated.",
        flags: {
          plan: { value: "<path>", effect: "Hub-relative plan." },
          "read-digest": { value: "<digest>", effect: "The plan's current read_digest." },
        },
        output: "{plan, state, digest}.",
        notes: ["stdin: {validations [{command, passed, output}]}."],
      },
      unit: {
        purpose:
          "Create, or find again, the isolation unit of one batch of one plan in one source: a worktree on branch aw/<hub>/plan-<PPP>-<bn>.",
        flags: {
          plan: { value: "<PPP>", effect: "Plan number." },
          batch: { value: "<Bn>", effect: "Batch of the plan." },
          source: { value: "<alias>", effect: "Source the unit edits." },
        },
        output: "{created, unit {alias, plan, batch, branch, path}}.",
        notes: ["Named by plan and batch, so after a crash git alone finds the unit again."],
      },
    },
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<FlowResult>> {
    const head = args.rest[0];
    if (head === "read" || head === "save") return documentVerb(head, args, ctx);
    if (isPlanRunVerb(head)) return planRunVerb(head, args, ctx);
    const usage = `uso: aw flow ${VERBS.join(" | ")}`;
    return failSemantic({ code: "ARGS_INVALID", message: usage, action: usage });
  },

  renderHuman(result: CommandResult<FlowResult>): string {
    if (result.data === undefined) return "";
    return renderDocumentHuman(result.data) ?? `${JSON.stringify(result.data, null, 2)}\n`;
  },
};
