import { runArtifactsCommand } from "../../application/artifacts-service.js";
import { readSessionArtifacts } from "../../application/release-data/artifacts.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
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

export const sessionArtifactsCommand: QtcCommand = {
  name: "session-artifacts",
  describe:
    "Consolidated view of a session's artifacts. Default: counts + presence flags. " +
    "Usage: aw session-artifacts --code <NNN> [--verbose] " +
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
      const dump = await readSessionArtifacts(ctx.fs, ctx.env, ctx.paths, code, kinds, ctx.runtime);
      if (dump.error !== undefined) {
        const errCode = String(dump.error).startsWith("session_not_found")
          ? "SESSION_NOT_FOUND"
          : "LEGACY_FORMAT";
        return fail(errCode, String(dump.hint ?? dump.error), dump);
      }
      return { ok: true, data: dump, exitCode: 0 };
    }

    const verbose = args.flags.has("--verbose");
    const input: { code?: string; verbose?: boolean } = {};
    if (code !== undefined) input.code = code;
    if (verbose) input.verbose = true;
    const data = await runArtifactsCommand(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return fail("SESSION_NOT_FOUND", data.error, data);
    }
    return { ok: true, data, exitCode: 0 };
  },
};
