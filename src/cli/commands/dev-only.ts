import { isAbsolute, join, relative } from "node:path";
import {
  isHarnessId,
  runHarness,
  runLogs,
  runNextNumber,
  runProfiles,
} from "../../application/dev-only-services.js";
import { correlativesOf } from "../../application/doc-flow/numbering.js";
import { HARNESSES } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

// Derived from the catalog: the describe used to name two hosts out of seven.
const HARNESS_IDS = HARNESSES.map((h) => h.id).join(" | ");

export const harnessCommand: CliCommand = {
  name: "harness",
  flags: { known: ["host"] },
  help: {
    purpose: "Identify the agent host running this invocation from its environment markers.",
    flags: {
      host: {
        value: `<${HARNESS_IDS.replaceAll(" ", "")}>`,
        effect: "Bind the answer to this host instead of detecting it.",
      },
    },
    output:
      "{agent_host, terminal_host, harness (deprecated), execution, resource_policy {deterministic, semantic_default}, supports_plan_subagent, detected_via, terminal_detected_via, ...}.",
    notes: [
      "unknown is a legitimate answer: some hosts export no marker to their subprocesses. aw self detect-hosts reports what is installed on the machine.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const requested = args.values.get("host");
    if (requested !== undefined && !isHarnessId(requested)) {
      return fail(
        "INVALID_INPUT",
        `--host inválido: '${requested}'. Valores válidos: ${HARNESS_IDS}`,
      );
    }
    const data = runHarness((k) => ctx.env.get(k), requested);
    return { ok: true, data, exitCode: 0 };
  },
};

export const profilesCommand: CliCommand = {
  name: "profiles",
  flags: { known: [] },
  help: {
    purpose: "Resolve the user preferences declared in the namespace's user-config.md.",
    output:
      "{validation_mode: ask|auto|manual, teaching_mode: off|on, delegate_to_subagent, source: default|user-config, legacy_section_detected}.",
  },
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runProfiles(ctx.fs, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};

export const logsCommand: CliCommand = {
  name: "logs",
  flags: { known: ["tail", "clear"] },
  help: {
    purpose: "Show or clear the CLI's user-level daily log.",
    flags: {
      tail: { value: "<n>", effect: "Show the last n lines of today's log (default 20)." },
      clear: { effect: "Delete every daily log file instead of showing one." },
    },
    output:
      "{path, lines[], total_lines?, showing?, message?}; with --clear: {cleared: true, path}.",
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const tailStr = args.values.get("tail");
    const tail = tailStr ? Number.parseInt(tailStr, 10) : undefined;
    const clear = args.flags.has("--clear");
    const input: { tail?: number; clear?: boolean } = {};
    if (tail !== undefined && Number.isFinite(tail)) input.tail = tail;
    if (clear) input.clear = true;
    const data = await runLogs(ctx.env, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};

export const nextNumberCommand: CliCommand = {
  name: "next-number",
  flags: { known: ["publish", "dry-run"] },
  help: {
    purpose:
      "Number a new document from the folder itself: compute the next NNN, or publish the document read from stdin by exclusive creation; to publish conversation work use aw persist.",
    args: "<dir>",
    flags: {
      publish: {
        value: "<name>",
        effect:
          "Write stdin as <NNN>-<name>, synchronizing its numbered H1. The same name and content reuse the existing file; changed content gets a new number.",
      },
      "dry-run": { effect: "Preview the number without creating the directory or writing." },
    },
    output: "{published_path, directory, exists, current_max, next, files[]}.",
    notes: [
      "Without --publish it is a pure query. The folder is the only record of what is taken: no ledger and no reservation. --publish needs a Workline hub (.workflow/workline.json) and the final content on stdin; zero bytes are refused.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dir = args.rest[0];
    const usage = "uso: next-number <directorio> [--publish <nombre> [--dry-run]]";
    if (!dir) return fail("INVALID_INPUT", usage, { error: usage });
    const publish = args.values.get("publish");
    if (args.flags.has("--publish") || publish === "") {
      const message = "--publish exige su valor: el resto del nombre del archivo";
      return fail("INVALID_INPUT", message, { error: message });
    }
    const root = ctx.paths.hubDir();
    const absolute = isAbsolute(dir) ? dir : join(root, dir);
    const read = await correlativesOf(ctx.fs, absolute);
    const next = String(read.highest + 1).padStart(3, "0");
    const base = {
      directory: dir,
      exists: read.exists,
      current_max: read.highest === 0 ? null : String(read.highest).padStart(3, "0"),
      next,
      files: read.files,
    };
    if (publish === undefined || args.flags.has("--dry-run")) {
      return { ok: true, data: { published_path: null, ...base }, exitCode: 0 };
    }
    if (!(await ctx.fs.exists(ctx.paths.cwdMarkerFile()))) {
      return fail("HUB_ABSENT", "--publish necesita un hub Workline; no se creó ninguno", {
        action: "invocá el comando desde un hub con .workflow/workline.json",
      });
    }
    const content = await readRequiredStdin();
    if (content.length === 0) {
      const message = "--publish exige el contenido final del documento por stdin";
      return fail("INVALID_INPUT", message, { error: message });
    }
    const published = await runNextNumber(ctx.fs, ctx.env, ctx.paths, {
      directory: dir,
      publish: { name: publish, content },
    });
    if (published.published_path === null) throw new Error("la publicación no devolvió su ruta");
    return {
      ok: true,
      data: {
        published_path: relative(root, published.published_path),
        ...base,
        next: published.next,
      },
      exitCode: 0,
    };
  },
};
