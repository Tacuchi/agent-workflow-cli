import { describe, expect, it } from "vitest";
import { hubBlockUpsertCommand } from "../../src/cli/commands/hub-block.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  INTENTS,
  commandHelpText,
  globalHelpText,
  groupCommands,
  renderGroupedCommandLines,
} from "../../src/cli/help-groups.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";

describe("groupCommands", () => {
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
});

describe("renderGroupedCommandLines", () => {
  it("emits a header for each group with two-space indented commands", () => {
    const lines = renderGroupedCommandLines(["self", "status"]);
    expect(lines).toContain("Self:");
    expect(lines).toContain("Orchestration:");
    expect(lines).toContain("  self");
    expect(lines).toContain("  status");
  });

  it("inserts a blank line between groups but not after the last one", () => {
    const lines = renderGroupedCommandLines(["self", "status"]);
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

describe("renderGroupedCommandLines with purposes", () => {
  it("renders `name  <purpose>` aligned and whole, never cut mid-sentence", () => {
    const long = `Manage it ${"really ".repeat(20)}well. Then more.`;
    const lines = renderGroupedCommandLines(
      ["self", "status"],
      new Map([
        ["self", long],
        ["status", "Show what is pending."],
      ]),
    );
    expect(lines).toContain(`  self    ${long}`);
    expect(lines).toContain("  status  Show what is pending.");
  });

  it("falls back to name-only for commands missing from the describe map", () => {
    const lines = renderGroupedCommandLines(["self"], new Map());
    expect(lines).toEqual(["Self:", "  self"]);
  });
});

describe("commandHelpText", () => {
  it("la ayuda global anuncia --hub sin prometer una raíz implícita en un checkout", () => {
    const help = globalHelpText([], "workflow");
    expect(help).toContain("[--hub <path>]");
    expect(help).toContain("inside\nan unclaimed checkout, specify --hub");
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

  it("hub-block exige exactamente uno, y rechaza ambas operaciones juntas", async () => {
    const help = commandHelpText(hubBlockUpsertCommand);
    expect(help).toContain("exactly one of: --read | --init");
    expect(help).toMatch(/--fuente <[^>]+> +Declare a source with --init\. \(repeatable\)/);
    const result = await hubBlockUpsertCommand.execute(
      parseArgv(["hub-block", "--read", "--init"]),
      {} as CliContext,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("aw --help — contract once, one command per intent, dev-only apart", () => {
  const help = globalHelpText(ALL_COMMANDS, "workflow");

  it("declares the common contract exactly once", () => {
    for (const line of [
      "Common contract (every command",
      "Error    {ok: false, error: {code, message, details?}, data?}",
      "Exit 0   success.",
      "Exit 1   error",
      "Exit 2   a condition the command declares in its own help",
      "Format   --format human|json",
    ]) {
      expect(help.split(line).length - 1, line).toBe(1);
    }
  });

  it("no command help restates the common envelope or the success exit", () => {
    // An exit 1 of its own (an unhealthy verdict with ok: true) differs from the
    // contract, so a command declares it; the shared meanings stay here only.
    for (const command of ALL_COMMANDS) {
      for (const action of [undefined, ...Object.keys(command.flags.actions ?? {})]) {
        const own = commandHelpText(command, action);
        expect(own, `${command.name} ${action ?? ""}`).not.toMatch(
          /\{ok: false|^Exit 0:|^Exit 1: error/m,
        );
      }
    }
  });

  it("leads with seven intents, each answered by exactly one registered command", () => {
    expect(INTENTS.map((row) => row.intent)).toEqual([
      "what to resume",
      "what is pending",
      "publish a document in docs/",
      "number a new document",
      "diagnose the installation",
      "consolidate SQL",
      "read where a flow stands",
    ]);
    const commands = INTENTS.map((row) => row.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const { intent, command } of INTENTS) {
      // A command, or a command and its action (`flow start`), both registered.
      const [name, action] = command.split(" ");
      const registered = ALL_COMMANDS.find((c) => c.name === name);
      expect(registered, command).toBeDefined();
      if (action !== undefined) expect(registered?.flags.actions?.[action], command).toBeDefined();
      expect(help, intent).toMatch(new RegExp(`^ {2}${intent} +aw ${command}$`, "m"));
    }
    expect(help.indexOf("By intent:")).toBeLessThan(help.indexOf("Commands:"));
  });

  it("without --all it names no dev-only command, and says how to see them", () => {
    const commandsSection = help.slice(help.indexOf("Commands:"), help.indexOf("Aliases:"));
    expect(help).not.toContain("Dev-only:");
    for (const name of ["harness", "profiles", "logs"]) {
      expect(commandsSection, name).not.toMatch(new RegExp(`^ {2}${name} `, "m"));
    }
    expect(help).toContain("aw --help --all also lists the dev-only commands.");
    const full = globalHelpText(ALL_COMMANDS, "workflow", { all: true });
    expect(full).toContain("Dev-only:");
    for (const name of ["harness", "profiles", "logs"]) {
      expect(full, name).toMatch(new RegExp(`^ {2}${name} `, "m"));
    }
    expect(full).not.toContain("--help --all also lists");
  });

  it("prints every purpose whole with --all", () => {
    const full = globalHelpText(ALL_COMMANDS, "workflow", { all: true });
    expect(full).not.toContain("…");
    for (const command of ALL_COMMANDS) expect(full).toContain(command.help.purpose);
  });
});
