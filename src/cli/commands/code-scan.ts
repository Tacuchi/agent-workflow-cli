import { type ScanPattern, runCodeScan } from "../../application/code-scan-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const codeScanCommand: CliCommand = {
  name: "code-scan",
  flags: {
    known: ["root", "pattern", "patterns-file", "ext", "exclude", "max-per-pattern"],
    repeatable: ["pattern"],
  },
  help: {
    purpose: "Scan files for release patterns such as localhost URLs, secrets and TODOs.",
    flags: {
      root: { value: "<dir>", effect: "Directory to scan; defaults to the hub." },
      pattern: {
        value: "<id:regex[:severity]>",
        effect: "Inline pattern; replaces the built-in and file patterns.",
      },
      "patterns-file": { value: "<file>", effect: "File of patterns replacing the built-in ones." },
      ext: { value: "<csv>", effect: "File extensions to scan instead of the defaults." },
      exclude: { value: "<csv>", effect: "Directory names to skip instead of the defaults." },
      "max-per-pattern": { value: "<n>", effect: "Cap on the matches reported per pattern." },
    },
    output:
      "{matches[] {pattern_id, severity, file, line, snippet, recommendation}, counts, by_severity {alta, media, baja}, root, patterns_used[], total_matches}; or {error, root?, file?} when the root or the patterns file is unusable.",
    notes: ["Read-only. The default severity of an inline pattern is media."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const root = args.values.get("root");
    const patternsFile = args.values.get("patterns-file");
    const ext = args.values.get("ext");
    const exclude = args.values.get("exclude");
    const maxStr = args.values.get("max-per-pattern");

    const inlinePatterns = collectInlinePatterns(args.valuesMulti.get("pattern") ?? []);

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

function collectInlinePatterns(rawPatterns: string[]): ScanPattern[] {
  const out: ScanPattern[] = [];
  for (const raw of rawPatterns) {
    const parsed = parsePatternArg(raw);
    if (parsed) out.push(parsed);
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
