import {
  type ArtifactsInput,
  type ArtifactsOutput,
  runArtifactsCommand,
} from "../../application/artifacts-service.js";
import { readSessionArtifacts } from "../../application/release-data/artifacts.js";
import type { NarrativeFact } from "../../domain/session/narrative.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

const DUMP_KINDS = new Set([
  "objetivo",
  "decisiones",
  "conclusiones",
  "tasks",
  "checkpoint",
  "backlog",
  "scripts",
]);

export const sessionArtifactsCommand: CliCommand = {
  name: "session-artifacts",
  describe:
    "Consolidated view of a session's artifacts. Default: counts + presence flags. " +
    "Usage: aw session-artifacts --code <NNN> [--verbose] [--detail] [--no-narrative] " +
    "[--dump [objetivo,decisiones,conclusiones,tasks,checkpoint,backlog,scripts]] — " +
    "--dump devuelve {path, content, size} por artefacto (sin CSV: todos).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const dumpCsv = args.values.get("dump");
    const wantsDump = dumpCsv !== undefined || args.flags.has("--dump");

    if (wantsDump) {
      if (code === undefined) {
        return fail("INVALID_INPUT", "--dump requiere --code <NNN>");
      }
      let kinds: string[] | undefined;
      if (dumpCsv !== undefined) {
        kinds = dumpCsv.split(",").map((k) => k.trim().toLowerCase());
        const invalid = kinds.filter((k) => !DUMP_KINDS.has(k));
        if (invalid.length > 0) {
          return fail(
            "INVALID_INPUT",
            `--dump kinds inválidos: ${invalid.join(", ")}. Válidos: ${[...DUMP_KINDS].join(", ")}`,
          );
        }
      }
      const dump = await readSessionArtifacts(ctx.fs, ctx.paths, code, kinds, ctx.runtime);
      if (dump.sessionError !== undefined) return failSessionResolution(dump.sessionError);
      if (dump.error !== undefined) {
        return fail("LEGACY_FORMAT", String(dump.hint ?? dump.error), dump);
      }
      return { ok: true, data: dump, exitCode: 0 };
    }

    const input: ArtifactsInput = {};
    if (code !== undefined) input.code = code;
    if (args.flags.has("--verbose")) input.verbose = true;
    if (args.flags.has("--no-narrative")) input.noNarrative = true;
    const contextId = readContextId(ctx.env);
    if (contextId !== undefined) input.contextId = contextId;

    const data = await runArtifactsCommand(ctx.fs, ctx.env, ctx.paths, input);
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    return { ok: true, data, exitCode: 0 };
  },

  /**
   * The human view is the RECORRIDO; the counts are the detail underneath it.
   *
   * A person asking about a session wants what it set out to do, what happened and
   * what is next — not five presence booleans. Those stay, at the bottom and in
   * the JSON, because they answer a real question too: which artifacts exist. What
   * changed is which of the two comes first.
   */
  renderHuman(result: CommandResult, context: HumanRenderContext): string {
    const data = result.data as ArtifactsOutput | undefined;
    if (data === undefined) return "";
    const narrative = data.narrative;
    if (narrative === undefined) return `${JSON.stringify(data, null, 2)}\n`;

    // Jargon waits to be asked for: ids, digests and transition names are real
    // and stay reachable with `--detail`, but a normal reading is the sentence.
    const detail = context.detail === true;
    const lines = [`${narrative.session} · ${narrative.phase}`];
    if (narrative.objective !== null) lines.push(`Objetivo: ${narrative.objective.text}`);
    if (narrative.next !== null) lines.push(`Siguiente: ${narrative.next.text}`);
    block(lines, "Qué pasó", narrative.sequence, detail);
    block(lines, "Tareas", narrative.tasks, detail);
    block(lines, "Decisiones", narrative.decisions, detail);
    block(lines, "Resultados", narrative.results, detail);
    block(lines, "Evidencia", narrative.evidence, detail);
    block(lines, "Pendiente", narrative.pending, detail);
    if (narrative.links.length > 0) {
      lines.push("", `Detalle: ${narrative.links.map((link) => link.label).join(" · ")}`);
    }
    return `${lines.join("\n")}\n`;
  },
};

/** One section, with each fact's state and the artifact it came from. */
function block(
  lines: string[],
  title: string,
  facts: readonly NarrativeFact[],
  detail: boolean,
): void {
  if (facts.length === 0) return;
  lines.push("", `${title}:`);
  for (const fact of facts) {
    if (!detail) {
      lines.push(`  · ${fact.text} [${fact.state} · ${fact.source.artifact}]`);
      continue;
    }
    const where =
      fact.source.locator === null
        ? fact.source.artifact
        : `${fact.source.artifact} › ${fact.source.locator}`;
    const technical = fact.detail === null ? "" : ` · ${fact.detail}`;
    lines.push(`  · ${fact.text} [${fact.state} · ${where}${technical}]`);
  }
}
