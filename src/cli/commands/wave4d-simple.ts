import { type ScanPattern, runCodeScan } from "../../application/code-scan-service.js";
import { runBootstrapDsn } from "../../application/dev-bootstrap-dsn-service.js";
import { runGraduate } from "../../application/dev-graduate-service.js";
import { runUpgradeHubMode } from "../../application/upgrade-hub-mode-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const bootstrapDsnCommand: QtcCommand = {
  name: "bootstrap-dsn",
  describe: "Persist DB_CERT_DSN/DB_PROD_DSN to ~/.qtc/dev/dsn.env.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const certDsn = ctx.env.get("DB_CERT_DSN");
    const prodDsn = ctx.env.get("DB_PROD_DSN");
    const result = runBootstrapDsn({ certDsn, prodDsn });
    if ("error" in result) {
      return {
        ok: false,
        error: { code: "MISSING_DSN", message: result.error },
        data: { error: result.error },
        exitCode: 2,
      };
    }
    return { ok: true, data: result, exitCode: 0 };
  },
};

export const graduateCommand: QtcCommand = {
  name: "graduate",
  describe: "Graduate a session decision (DEC-NNN) or plan (TASKS) to docs/.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: Parameters<typeof runGraduate>[3] = {};
    const kind = args.values.get("kind");
    if (kind !== undefined) input.kind = kind;
    const session = args.values.get("session");
    if (session !== undefined) input.session = session;
    const id = args.values.get("id");
    if (id !== undefined) input.decId = id;
    const slug = args.values.get("slug");
    if (slug !== undefined) input.slug = slug;
    const data = await runGraduate(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data, exitCode: 0 };
  },
};

export const upgradeHubModeCommand: QtcCommand = {
  name: "upgrade-hub-mode",
  describe: "Detect and apply Mode: hub upgrade when ≥2 sources declared.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dryRun = args.flags.has("--dry-run");
    const data = await runUpgradeHubMode(ctx.fs, ctx.env, dryRun ? { dryRun: true } : {});
    return { ok: true, data, exitCode: 0 };
  },
};

export const codeScanCommand: QtcCommand = {
  name: "code-scan",
  describe: "Scan files for release patterns (localhost, secrets, TODOs, ...).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const root = args.values.get("root");
    const patternsFile = args.values.get("patterns-file");
    const ext = args.values.get("ext");
    const exclude = args.values.get("exclude");
    const maxStr = args.values.get("max-per-pattern");

    const inlinePatterns = collectInlinePatterns(process.argv.slice(2));

    const input: Parameters<typeof runCodeScan>[3] = {};
    if (root !== undefined) input.root = root;
    if (patternsFile !== undefined) input.patternsFile = patternsFile;
    if (inlinePatterns.length > 0) input.inlinePatterns = inlinePatterns;
    if (ext !== undefined) {
      input.extOverride = ext
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
        .map((e) => `.${e.replace(/^\.+/, "")}`);
    }
    if (exclude !== undefined) {
      input.excludeOverride = exclude
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
    }
    if (maxStr !== undefined) {
      const n = Number.parseInt(maxStr, 10);
      if (Number.isFinite(n)) input.maxPerPattern = n;
    }

    const data = await runCodeScan(ctx.fs, ctx.env, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};

function collectInlinePatterns(argv: string[]): ScanPattern[] {
  const out: ScanPattern[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pattern" && i + 1 < argv.length) {
      const parsed = parsePatternArg(argv[i + 1] ?? "");
      if (parsed) out.push(parsed);
      i += 1;
    }
  }
  return out;
}

function parsePatternArg(arg: string): ScanPattern | null {
  const first = arg.indexOf(":");
  if (first === -1) return null;
  const id = arg.slice(0, first);
  const rest = arg.slice(first + 1);
  const second = rest.indexOf(":");
  let regex: string;
  let severity: string;
  if (second === -1) {
    regex = rest;
    severity = "media";
  } else {
    regex = rest.slice(0, second);
    severity = rest.slice(second + 1);
  }
  if (!id || !regex) return null;
  return { id, regex, severity, recommendation: "" };
}
