import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { commandHelpText, globalHelpText } from "../../src/cli/help-groups.js";
import type { CliCommand } from "../../src/cli/registry.js";

/**
 * One term for the unit: «hub» (plan 086, F4 · D1, D8).
 *
 * The help, the error codes and actions, the `w` bundle and the TUI texts never
 * name the unit «workspace», «project» or «proyecto». What remains is an
 * external term, listed below with the reason it is not ours to rename.
 */

const REPO = resolve(__dirname, "..", "..");
const BANNED = /\b(workspaces?|projects?|proyectos?)\b/gi;

/** External terms, each with why it stays. Matched against the text around the hit. */
const ALLOWED: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\.code-workspace\b/i, reason: "VS Code workspace file" },
  { pattern: /\bnpm workspaces?\b/i, reason: "npm workspaces" },
  { pattern: /\bherdr\b[^.\n]*\bworkspace/i, reason: "Herdr's own workspace" },
  { pattern: /projectMcpPath|projects_trusted|ANTIGRAVITY_PROJECT_ID/, reason: "host config keys" },
  { pattern: /~\/\.claude\/projects/, reason: "Claude Code's memory path" },
  { pattern: /\bproject-file\b/, reason: "doctor kind: the host's CLAUDE.md/AGENTS.md file" },
  { pattern: /workspace's `\.agents\/`/, reason: "Antigravity's workspace root" },
  {
    pattern: /\b(user and project tiers|project-only|project-level|project `\.mcp\.json`)/,
    reason: "a host's own project scope (HARNESS.md host tiers)",
  },
  { pattern: /--project-dir\b|the project's stack/, reason: "the user's software project (stack)" },
  {
    pattern:
      /PROJECT block or an older namespace|## Proyecto heading|reserved alias workspace to hub/,
    reason: "hub-migrate names the pre-29 spelling it rewrites",
  },
];

function hits(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(BANNED)) {
      if (ALLOWED.some(({ pattern }) => pattern.test(line))) continue;
      found.push(`${match[0]} · ${line.trim().slice(0, 140)}`);
    }
  }
  return found;
}

function files(dir: string, extension: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path, extension);
    return extension.test(entry) ? [path] : [];
  });
}

/** Code lines only: comments and imports name files and identifiers, not the reader's text. */
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !(
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("} from ")
    );
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g;
const JSX_TEXT = />([^<>{}\n]+)</g;

function literals(line: string): string[] {
  return [...line.matchAll(LITERAL), ...line.matchAll(JSX_TEXT)].map((m) => m[1] ?? m[0]);
}

function helpTexts(): Array<[string, string]> {
  const texts: Array<[string, string]> = [["aw --help", globalHelpText(ALL_COMMANDS, "workflow")]];
  for (const command of ALL_COMMANDS) {
    texts.push([`aw ${command.name} --help`, commandHelpText(command)]);
    for (const action of Object.keys(command.flags.actions ?? {}))
      texts.push([`aw ${command.name} ${action} --help`, commandHelpText(command, action)]);
  }
  return texts;
}

const ERROR_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ERROR_GUIDANCE = /\b(action|hint|guidance)\b\s*[:=(]/;

/** The error codes (UPPER_SNAKE literals) a line carries, plus its literals when it hands back guidance. */
function errorTextsOf(line: string): string[] {
  const found = literals(line)
    .map((literal) => literal.replace(/^["'`]|["'`]$/g, ""))
    .filter((bare) => ERROR_CODE.test(bare));
  return ERROR_GUIDANCE.test(line) ? [...found, ...literals(line)] : found;
}

/** Error codes and the actions/hints/guidance an error hands back, across `src`. */
function errorTexts(): Array<[string, string]> {
  return files(join(REPO, "src"), /\.tsx?$/).flatMap((path) =>
    codeLines(readFileSync(path, "utf8")).flatMap((line) =>
      errorTextsOf(line).map((text): [string, string] => [relative(REPO, path), text]),
    ),
  );
}

function bundleTexts(): Array<[string, string]> {
  return files(join(REPO, "skills", "w"), /\.(md|json)$/).map((path) => [
    relative(REPO, path),
    readFileSync(path, "utf8"),
  ]);
}

function tuiTexts(): Array<[string, string]> {
  return files(join(REPO, "src", "cli", "tui"), /\.tsx?$/).flatMap((path) =>
    codeLines(readFileSync(path, "utf8")).flatMap((line) =>
      literals(line).map((literal): [string, string] => [relative(REPO, path), literal]),
    ),
  );
}

function offending(texts: Array<[string, string]>): string[] {
  return texts.flatMap(([where, text]) => hits(text).map((hit) => `${where}: ${hit}`));
}

describe("the unit is called hub everywhere a person or an agent reads it", () => {
  it("in the global help and every command and subverb help", () => {
    expect(offending(helpTexts())).toEqual([]);
  });

  it("in the error codes and the actions an error hands back", () => {
    expect(offending(errorTexts())).toEqual([]);
  });

  it("in the w bundle", () => {
    expect(offending(bundleTexts())).toEqual([]);
  });

  it("in the TUI texts", () => {
    expect(offending(tuiTexts())).toEqual([]);
  });

  it("sweeps real material, not an empty list", () => {
    expect(helpTexts().length).toBeGreaterThan(ALL_COMMANDS.length);
    expect(errorTexts().some(([, text]) => text === "HUB_MIGRATION_REQUIRED")).toBe(true);
    expect(bundleTexts().some(([where]) => where.endsWith("skills/w/SKILL.md"))).toBe(true);
    expect(tuiTexts().some(([, text]) => text.includes("Quitar del hub"))).toBe(true);
  });

  it("goes red when «workspace» comes back into a help", () => {
    const reintroduced = {
      ...(ALL_COMMANDS[0] as CliCommand),
      help: { ...(ALL_COMMANDS[0] as CliCommand).help, purpose: "Show the workspace state." },
    } as CliCommand;
    expect(offending([["aw x --help", commandHelpText(reintroduced)]])).not.toEqual([]);
  });
});
