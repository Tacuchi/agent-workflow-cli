import {
  type GitFlowAction,
  type GitFlowInput,
  type GitFlowResult,
  runGitFlow,
} from "../../application/git-flow-service.js";
import { formatGitFlowSourceLine } from "../../application/logging/log-events.js";
import { attributeCliInvocation, grantProdConsent } from "../../application/prod-consent.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const ACTIONS: ReadonlySet<string> = new Set(["sync", "to-dev", "to-qa", "to-prod"]);

const NEEDS_PERSON =
  "publicar en PROD lo hace la persona: desde el TUI (`aw`) o desde su propia terminal";
const DECLINED = "publicación en PROD no confirmada: ninguna rama cambió";

export type ConfirmFn = (message: string) => Promise<boolean>;

// "No" by default and no `--yes`: unlike `aw self update`, the one thing that
// may publish in PROD is the person answering yes to the preview.
const defaultConfirm: ConfirmFn = async (message) => {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: false });
};

export function createGitFlowCommand(confirm: ConfirmFn = defaultConfirm): CliCommand {
  return {
    name: "git-flow",
    flags: { known: ["source", "all", "target", "dry-run"] },
    describe:
      "Run a per-source git flow. Usage: aw git-flow <sync|to-dev|to-qa|to-prod> " +
      "[--source <alias>]... [--all] [--target <branch>] [--dry-run]. " +
      "Publishing in PROD asks the person in an interactive terminal.",
    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
      const action = args.rest[0];
      if (!action || !ACTIONS.has(action)) {
        return fail(
          "INVALID_INPUT",
          "Usage: aw git-flow <sync|to-dev|to-qa|to-prod> [--source <alias>]... [--all] [--target <branch>] [--dry-run]",
        );
      }

      const input = inputFrom(action as GitFlowAction, args);
      let data = await runGitFlow(ctx.fs, ctx.git, ctx.paths, input);
      if (data.consent_required !== undefined) {
        const consented = await askThePerson(data, ctx, confirm);
        if ("refusal" in consented) return consented.refusal;
        data = await runGitFlow(ctx.fs, ctx.git, ctx.paths, {
          ...input,
          consent: consented.consent,
        });
      }
      await logFailedSources(data, ctx);
      return outcome(data);
    },
  };
}

export const gitFlowCommand: CliCommand = createGitFlowCommand();

function inputFrom(action: GitFlowAction, args: ParsedArgs): GitFlowInput {
  const input: GitFlowInput = { action };
  const sources = args.valuesMulti.get("source") ?? [];
  if (sources.length > 0) input.sources = sources;
  const target = flagValue(args, "target");
  if (target !== undefined) input.target = target;
  if (args.flags.has("--all")) input.all = true;
  if (args.flags.has("--dry-run")) input.dryRun = true;
  return input;
}

/**
 * The preview goes first, and only an attributable invocation is asked. No
 * flag stands in for the answer: the consent is built from the yes itself.
 */
async function askThePerson(
  preview: GitFlowResult,
  ctx: CliContext,
  confirm: ConfirmFn,
): Promise<
  { consent: NonNullable<GitFlowInput["consent"]> } | { refusal: CommandResult<GitFlowResult> }
> {
  const sources = preview.consent_required?.sources ?? [];
  const planDigest = preview.consent_required?.plan ?? "";
  const attribution = attributeCliInvocation(ctx.env, ctx.process.hasTty());
  const plan = renderPreview(preview);
  if (!attribution.person) {
    return {
      refusal: fail(
        "GIT_FLOW_NEEDS_PERSON",
        `${NEEDS_PERSON} (${attribution.reason}).\n${plan}`,
        preview,
      ),
    };
  }
  let yes: boolean;
  try {
    yes = await confirm(`${plan}\n\n¿Publicar en PROD ${sources.join(", ")}?`);
  } catch {
    // Inquirer rejects on Ctrl-C/Esc: a closed prompt is a no.
    yes = false;
  }
  const consent = yes ? grantProdConsent(attribution, sources, planDigest) : null;
  return consent === null
    ? { refusal: fail("GIT_FLOW_PROD_DECLINED", DECLINED, preview) }
    : { consent };
}

/** One line per source: the steps that would run, with the real branch names. */
export function renderPreview(preview: GitFlowResult): string {
  const lines = preview.results.map((r) =>
    r.status === "error"
      ? `${r.source}: ${r.error ?? "error"}`
      : `${r.source}: ${r.steps.map((s) => s.preview ?? s.step).join(" → ")}`,
  );
  return ["Se publicará en la rama de PROD de cada fuente listada:", ...lines].join("\n");
}

/** The daily log gets the source, the step and git's stderr of every source that did not finish. */
async function logFailedSources(data: GitFlowResult, ctx: CliContext): Promise<void> {
  for (const result of data.results) {
    if (result.status === "ok") continue;
    const level = result.status === "conflict" ? "warn" : "error";
    await ctx.logger?.log(level, formatGitFlowSourceLine(data.action, result));
  }
}

function outcome(data: GitFlowResult): CommandResult {
  if (data.status === "error") {
    return fail("GIT_FLOW_ERROR", data.error ?? "git-flow failed", data);
  }
  // A conflict is a paused-but-expected outcome: exitCode 2 (like check-branch
  // strict) so callers/loops can detect "needs resolution" distinct from error.
  const exit: 0 | 2 = data.status === "conflict" ? 2 : 0;
  return { ok: true, data, exitCode: exit };
}
