import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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
  it("groups known commands into their family with declared order", () => {
    const groups = groupCommands([
      "sessions",
      "session-create",
      "session-load",
      "session-close",
      "session-artifacts",
      "self",
    ]);
    const sessionGroup = groups.find((g) => g.name === "Session lifecycle");
    expect(sessionGroup?.commands).toEqual([
      "sessions",
      "session-create",
      "session-load",
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
    const agentFacing = ALL_COMMANDS.filter((c) => c.hook !== true);
    const groups = groupCommands(agentFacing.map((c) => c.name));
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

describe("aw --help — contract once, one command per intent, hook targets apart", () => {
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
      "open a run",
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

  it("the only hook target is `hook`, listed apart and only with --all", () => {
    expect(ALL_COMMANDS.filter((c) => c.hook === true).map((c) => c.name)).toEqual(["hook"]);
    const full = globalHelpText(ALL_COMMANDS, "workflow", { all: true });
    const section = full.slice(full.indexOf("Hook targets"), full.indexOf("Aliases:"));
    const listed = [...section.matchAll(/^ {2}([\w-]+) {2,}/gm)].map((m) => m[1]);
    expect(listed).toEqual(["hook"]);
    const commandsSection = full.slice(full.indexOf("Commands:"), full.indexOf("Hook targets"));
    expect(commandsSection).not.toMatch(/^ {2}hook /m);
  });

  it("without --all it names no hook target and no dev-only command, and says how to see them", () => {
    const commandsSection = help.slice(help.indexOf("Commands:"), help.indexOf("Aliases:"));
    expect(help).not.toContain("Hook targets");
    expect(help).not.toContain("Dev-only:");
    for (const name of ["hook", "harness", "profiles", "logs"]) {
      expect(commandsSection, name).not.toMatch(new RegExp(`^ {2}${name} `, "m"));
    }
    expect(help).toContain(
      "aw --help --all also lists the hook targets and the dev-only commands.",
    );
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
