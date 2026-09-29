import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { projectMdUpsertCommand } from "../../src/cli/commands/project-md-upsert.js";
import {
  commandHelpText,
  commandSummary,
  globalHelpText,
  groupCommands,
  renderGroupedCommandLines,
} from "../../src/cli/help-groups.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";

describe("groupCommands", () => {
  it("groups known commands into their family with declared order", () => {
    const groups = groupCommands([
      "sessions",
      "session-create",
      "session-resume",
      "session-close",
      "session-artifacts",
      "self",
    ]);
    const sessionGroup = groups.find((g) => g.name === "Session lifecycle");
    expect(sessionGroup?.commands).toEqual([
      "sessions",
      "session-create",
      "session-resume",
      "session-close",
      "session-artifacts",
    ]);
    expect(groups.find((g) => g.name === "Self")?.commands).toEqual(["self"]);
  });

  it("omits empty groups when none of their commands are present", () => {
    const groups = groupCommands(["self"]);
    expect(groups.map((g) => g.name)).toEqual(["Self"]);
  });

  it("emits an 'Other' group for commands not declared in any group", () => {
    const groups = groupCommands(["self", "totally-new-command", "another-orphan"]);
    const other = groups.find((g) => g.name === "Other");
    expect(other?.commands).toEqual(["totally-new-command", "another-orphan"]);
  });

  it("does not duplicate commands between groups", () => {
    const allCommands = ["sessions", "session-create", "self", "plugin-doctor", "code-scan"];
    const groups = groupCommands(allCommands);
    const flat = groups.flatMap((g) => g.commands);
    const set = new Set(flat);
    expect(flat.length).toBe(set.size);
  });

  it("places git-flow in the Sources / Branches group", () => {
    const groups = groupCommands(["git-flow", "set-qa-branch", "self"]);
    const sources = groups.find((g) => g.name === "Sources / Branches");
    expect(sources?.commands).toContain("git-flow");
    // Not leaked into the catch-all Other group.
    expect(groups.find((g) => g.name === "Other")).toBeUndefined();
  });

  it("preserves the input order of commands within their group", () => {
    const groups = groupCommands(["session-create", "sessions", "session-close"]);
    expect(groups.find((g) => g.name === "Session lifecycle")?.commands).toEqual([
      "sessions",
      "session-create",
      "session-close",
    ]);
  });
});

describe("renderGroupedCommandLines", () => {
  it("emits a header for each group with two-space indented commands", () => {
    const lines = renderGroupedCommandLines(["self", "hook"]);
    expect(lines).toContain("Self:");
    expect(lines).toContain("Hooks:");
    expect(lines).toContain("  self");
    expect(lines).toContain("  hook");
  });

  it("inserts a blank line between groups but not after the last one", () => {
    const lines = renderGroupedCommandLines(["self", "hook"]);
    const blanks = lines.filter((l) => l === "");
    expect(blanks.length).toBe(1);
    expect(lines[lines.length - 1]).not.toBe("");
  });

  it("handles a single group cleanly", () => {
    const lines = renderGroupedCommandLines(["self"]);
    expect(lines).toEqual(["Self:", "  self"]);
  });
});

describe("guard: every registered command has a real group (no 'Other')", () => {
  it("groups all commands from the canonical registry with none left in Other", () => {
    const groups = groupCommands(ALL_COMMANDS.map((c) => c.name));
    const other = groups.find((g) => g.name === "Other");
    expect(other, `these commands fell into Other: ${other?.commands.join(", ")}`).toBeUndefined();
  });
});

describe("commandSummary (global help one-liner)", () => {
  it("takes the first sentence and drops the appended Usage clause", () => {
    expect(commandSummary("Do a thing. Usage: aw x [--flag].")).toBe("Do a thing.");
  });

  it("cuts at a real sentence boundary (period + space + capital)", () => {
    expect(commandSummary("First sentence. Second one here.")).toBe("First sentence.");
  });

  it("does not truncate at an ellipsis or a non-boundary period", () => {
    expect(commandSummary("Scan files (localhost, secrets, ...). Usage: aw code-scan.")).toBe(
      "Scan files (localhost, secrets, ...).",
    );
  });

  it("elides overly long summaries with an ellipsis", () => {
    const out = commandSummary(`${"palabra ".repeat(20)}fin.`);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderGroupedCommandLines with describes", () => {
  it("renders `name  <first sentence>` aligned when a describe map is given", () => {
    const describes = new Map([
      ["self", "Self-management umbrella. Usage: aw self <sub>."],
      ["hook", "Run a workflow hook."],
    ]);
    const lines = renderGroupedCommandLines(["self", "hook"], describes);
    expect(lines.some((l) => /self\s+Self-management umbrella\./.test(l))).toBe(true);
    expect(lines.some((l) => /hook\s+Run a workflow hook\./.test(l))).toBe(true);
    // The Usage clause is NOT spilled into the global list.
    expect(lines.every((l) => !l.includes("Usage:"))).toBe(true);
  });

  it("falls back to name-only for commands missing from the describe map", () => {
    const lines = renderGroupedCommandLines(["self"], new Map());
    expect(lines).toEqual(["Self:", "  self"]);
  });
});

function byName(name: string) {
  const command = ALL_COMMANDS.find((item) => item.name === name);
  if (!command) throw new Error(name);
  return command;
}

describe("commandHelpText", () => {
  it("generates the usage line from the contract, positionals and exclusive groups included", () => {
    expect(commandHelpText(byName("set-pipeline"))).toContain(
      "Usage: aw set-pipeline <alias> <build|test> <command|ninguno>",
    );
    expect(commandHelpText(byName("doc-branch"), "set")).toContain(
      "Usage: aw doc-branch set (--code <code> | --doc <spec|plan|quick:NNN>) (--rama <branch> | --from <spec|plan|quick:NNN>) [--session <code>] --source <alias>",
    );
    expect(commandHelpText(byName("doc-branch"), "show")).toContain(
      "Usage: aw doc-branch show (--code <code> | --doc <spec|plan|quick:NNN>) [--session <code>]",
    );
  });

  it("la ayuda global anuncia --workspace sin prometer una raíz implícita en un checkout", () => {
    const help = globalHelpText([], new Map(), "workflow");
    expect(help).toContain("[--workspace <path>]");
    expect(help).toContain("inside\nan unclaimed checkout, specify --workspace");
    expect(help).not.toContain("the invoked directory is the\nimplicit root");
  });

  it("renders its own contract, not the global list", () => {
    const out = commandHelpText({
      name: "foo",
      flags: { known: ["bar"], required: ["bar"] },
      help: {
        purpose: "Do foo.",
        flags: { bar: { value: "<n>", effect: "How many." } },
        output: "{count}.",
        exit_codes: { "2": "nothing to do." },
      },
    });
    expect(out).toBe(
      [
        "aw foo",
        "",
        "Do foo.",
        "",
        "Usage: aw foo --bar <n>",
        "",
        "Flags:",
        "  --bar <n>  How many. (required)",
        "",
        "Output (JSON data): {count}.",
        "Human output: no; the output is JSON in every mode.",
        "Exit 2: nothing to do.",
        "",
      ].join("\n"),
    );
    expect(out).not.toContain("Session lifecycle:");
  });
});

describe("ayuda derivada de la declaración que rechaza flags desconocidos", () => {
  it("todos los comandos y subverbos muestran exactamente sus flags activos", () => {
    const flagNames = (help: string) =>
      [...help.matchAll(/^ {2}--([\w-]+)(?: \S+)? {2,}/gm)].map((match) => match[1]).sort();
    for (const command of ALL_COMMANDS) {
      expect(flagNames(commandHelpText(command)), command.name).toEqual(
        [...command.flags.known].sort(),
      );
      for (const [verb, contract] of Object.entries(command.flags.actions ?? {})) {
        const actionHelp = commandHelpText(command, verb);
        expect(actionHelp, `${command.name} ${verb}`).toContain(`aw ${command.name} ${verb}`);
        expect(flagNames(actionHelp), `${command.name} ${verb}`).toEqual(
          [...new Set([...command.flags.known, ...contract.known])].sort(),
        );
      }
    }
  });

  it("project-md-upsert exige exactamente uno, y rechaza ambas operaciones juntas", async () => {
    const help = commandHelpText(projectMdUpsertCommand);
    expect(help).toContain("exactly one of: --read | --init");
    expect(help).toMatch(/--fuente <[^>]+> +Declare a source with --init\. \(repeatable\)/);
    const result = await projectMdUpsertCommand.execute(
      parseArgv(["project-md-upsert", "--read", "--init"]),
      {} as CliContext,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("no ofrece overwrite en scripts, doctor nombra sus subverbos y self sólo los propios", () => {
    expect(commandHelpText(byName("export-scripts"))).not.toContain("--overwrite");
    expect(commandHelpText(byName("export-scripts"))).toMatch(/--exclude <name> +.*\(repeatable\)/);
    expect(commandHelpText(byName("export-scripts"))).toContain("--sessions <a,b>");
    expect(commandHelpText(byName("export-manuals"), "apply")).toContain("--overwrite");
    expect(commandHelpText(byName("doctor"))).toMatch(/^ {2}prepare {2}/m);
    expect(commandHelpText(byName("doctor"))).toMatch(/^ {2}apply {4}/m);
    for (const flag of ["--host", "--only", "--skip-native"]) {
      expect(commandHelpText(byName("doctor"))).toContain(flag);
    }
    expect(commandHelpText(byName("doctor"), "prepare")).toContain("--select");
    expect(commandHelpText(byName("doctor"), "apply")).toContain("--approval");
    expect(Object.keys(byName("self").flags.actions ?? {})).toHaveLength(12);
    expect(commandHelpText(byName("self"), "update")).toContain("--dry-run");
    expect(commandHelpText(byName("flow"), "advance")).toContain("--adopt");
  });

  it("el dispatcher entrega la ayuda del subverbo solicitado, sin ejecutarlo", () => {
    const cli = resolve(__dirname, "../../dist/cli/main.js");
    for (const [args, expected] of [
      [["self", "update", "--help"], "aw self update"],
      [["doctor", "prepare", "--help"], "aw doctor prepare"],
      [["flow", "advance", "--help"], "aw flow advance"],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      expect(result.status, args.join(" ")).toBe(0);
      expect(result.stdout, args.join(" ")).toContain(expected);
    }
  });
});
