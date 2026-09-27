import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointWriteCommand } from "../../src/cli/commands/checkpoint-write.js";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import { hookCommand } from "../../src/cli/commands/hook.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { mcpCommand } from "../../src/cli/commands/mcp.js";
import { resumeSummaryCommand } from "../../src/cli/commands/resume-summary.js";
import { selfCommand } from "../../src/cli/commands/self.js";
import { sessionCloseCommand } from "../../src/cli/commands/session-close.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { contractFor, gateFlags, isRuntimeFlag } from "../../src/cli/commands/unknown-flags.js";
import { planDispatch } from "../../src/cli/dispatch-plan.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliCommand } from "../../src/cli/registry.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";
import { worklineMcpEntry } from "../../src/domain/workline-mcp-entry.js";

const REPO = resolve(__dirname, "../..");
const SRC = join(REPO, "src");
const COMMANDS_DIR = join(SRC, "cli/commands");

function command(name: string): CliCommand {
  const found = ALL_COMMANDS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no command '${name}'`);
  return found;
}

function gate(target: CliCommand, argv: string[]) {
  return gateFlags(target, parseArgv([target.name, ...argv]));
}

/** Every name a command accepts, whichever action it belongs to. */
function acceptedAnywhere(target: CliCommand): Set<string> {
  const names = new Set([...target.flags.known, ...(target.flags.retired ?? [])]);
  for (const own of Object.values(target.flags.actions ?? {})) {
    for (const name of [...own.known, ...(own.retired ?? [])]) names.add(name);
  }
  return names;
}

// ── sweep 1: every flag the code reads is in its command's contract ─────────

const READ_PATTERNS = [
  /(?:values|valuesMulti)\.(?:get|has)\(\s*"([a-z][a-z0-9-]*)"/g,
  /flags\.has\(\s*"--?([a-z][a-z0-9-]*)"/g,
  /flagValue\(\s*[\w.]+,\s*"([a-z][a-z0-9-]*)"/g,
];

function flagsReadIn(source: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of READ_PATTERNS) {
    for (const match of source.matchAll(pattern)) names.add(match[1] as string);
  }
  // The shared session reader: `--code`, with `--session` as its alias.
  if (source.includes("sessionCodeFlag(")) {
    names.add("code");
    names.add("session");
  }
  return names;
}

/**
 * The file plus the modules it hands its `args` to: its direct non-type imports
 * in `src/application/self/` and `src/application/doctor/`, where `self`,
 * `plugin-cache` and `doctor` read the flags their actions take. One hop only:
 * a module further down receives arguments its caller built, not the CLI's.
 */
function reachableFiles(entry: string): string[] {
  const files = [entry];
  const text = readFileSync(entry, "utf8");
  for (const match of text.matchAll(/^import (?!type )[^;]*?from "(\.[^"]+)\.js";/gms)) {
    const target = resolve(dirname(entry), `${match[1]}.ts`);
    const rel = relative(SRC, target);
    if (rel.startsWith("application/self/") || rel.startsWith("application/doctor/")) {
      files.push(target);
    }
  }
  return files;
}

/** The commands each `src/cli/commands/*.ts` file defines, as index.ts imports them. */
async function commandsByFile(): Promise<Map<string, CliCommand[]>> {
  const index = readFileSync(join(COMMANDS_DIR, "index.ts"), "utf8");
  const byFile = new Map<string, CliCommand[]>();
  for (const match of index.matchAll(/^import \{([^}]+)\} from "\.\/([\w-]+)\.js";/gm)) {
    const file = join(COMMANDS_DIR, `${match[2]}.ts`);
    const module = (await import(file)) as Record<string, CliCommand>;
    const symbols = (match[1] as string)
      .split(",")
      .map((symbol) => symbol.trim())
      .filter((symbol) => symbol.length > 0);
    byFile.set(
      file,
      symbols.map((symbol) => module[symbol] as CliCommand),
    );
  }
  return byFile;
}

// ── sweep 2: no documented invocation is refused ───────────────────────────

const INVOCATION = /(?:^|[\s`"'(])(?:aw|agent-workflow)\s+([a-z][a-z0-9-]*)([^`\n|;&<>#)]*)/g;

function bundleFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...bundleFiles(path));
    else if (/\.(md|json|toml)$/.test(entry)) files.push(path);
  }
  return files;
}

interface Invocation {
  file: string;
  argv: string[];
}

function documentedInvocations(): Invocation[] {
  const invocations: Invocation[] = [];
  const known = new Set(ALL_COMMANDS.map((c) => c.name));
  for (const file of bundleFiles(join(REPO, "skills/w"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(INVOCATION)) {
      const name = match[1] as string;
      if (!known.has(name)) continue;
      // `[--refs <csv>]` documents an optional flag: the brackets are prose.
      const words = (match[2] as string)
        .replace(/[[\]{}]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 0 && word !== "..." && word !== "…");
      invocations.push({ file: relative(REPO, file), argv: [name, ...words] });
    }
  }
  return invocations;
}

describe("flag contracts · every command declares one", () => {
  it("each command of ALL_COMMANDS carries a contract of flag names", () => {
    for (const target of ALL_COMMANDS) {
      for (const name of acceptedAnywhere(target)) {
        expect(name, `${target.name}: '${name}'`).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  // Per command, not per action: a flag read by one action and declared only on
  // another still passes here. The per-action cases below pin the ones that matter.
  it("every flag a command reads is in some action of its contract (sweep over the code)", async () => {
    const byFile = await commandsByFile();
    expect([...byFile.values()].flat().length).toBe(ALL_COMMANDS.length);
    const missing: string[] = [];
    for (const [file, commands] of byFile) {
      const names = commands.map((target) => target.name);
      const accepted = new Set(commands.flatMap((target) => [...acceptedAnywhere(target)]));
      for (const reached of reachableFiles(file)) {
        for (const flag of flagsReadIn(readFileSync(reached, "utf8"))) {
          if (!accepted.has(flag) && !isRuntimeFlag(flag)) {
            missing.push(`${relative(SRC, reached)} lee --${flag} (${names.join(", ")})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("no invocation in skills/w/ nor the hooks template is refused (sweep over the bundle)", () => {
    const invocations = documentedInvocations();
    expect(invocations.length).toBeGreaterThan(50);
    const refused = invocations
      .map(({ file, argv }) => ({
        file,
        argv,
        gate: gateFlags(command(argv[0] as string), parseArgv(argv)),
      }))
      .filter(({ gate: outcome }) => outcome.kind === "refuse")
      .map(({ file, argv }) => `${file}: aw ${argv.join(" ")}`);
    expect(refused).toEqual([]);
  });
});

describe("flag contracts · the invocations the CLI itself writes", () => {
  function servedArgs(args: readonly string[]): string[] {
    return args.slice(args.indexOf("mcp"));
  }

  it.each(["workspace", "global"] as const)(
    "the database MCP descriptor (%s) launches without a notice",
    (scope) => {
      const entry = buildMcpEntry("cert", "CERT_DATABASE_URL", {
        nodePath: "/usr/bin/node",
        entrypoint: "/opt/aw/dist/cli/main.js",
        host: "claude",
        scope,
        descriptorGeneration: "25.7.0",
      });
      expect(gateFlags(mcpCommand, parseArgv(servedArgs(entry.args)))).toEqual({ kind: "run" });
    },
  );

  it("the elicitation MCP descriptor launches without a notice", () => {
    const entry = worklineMcpEntry("claude", "linux");
    expect(gateFlags(mcpCommand, parseArgv(servedArgs(entry.args)))).toEqual({ kind: "run" });
  });

  it("a stdio server warns instead of refusing: the host would see a dead server", () => {
    expect(gate(mcpCommand, ["serve-db", "--instance", "cert", "--bogus"])).toMatchObject({
      kind: "run",
    });
  });
});

describe("flag contracts · the dispatcher refuses what no command reads", () => {
  it("`aw flow submit --file x.json` is refused with UNKNOWN_FLAG", () => {
    const outcome = gate(flowCommand, ["submit", "--session", "001", "--file", "x.json"]);
    expect(outcome.kind).toBe("refuse");
    if (outcome.kind !== "refuse") return;
    expect(outcome.result.error?.code).toBe("UNKNOWN_FLAG");
    expect(outcome.result.error?.message).toContain("--file");
    expect(outcome.result.exitCode).toBe(1);
  });

  it("the refusal runs before the command, so nothing reads stdin for an ignored flag", () => {
    // full-cli.ts runs the CLI on import, so the order is read from its source: the
    // gate returns before `command.execute` is ever reached.
    const main = readFileSync(join(SRC, "cli/full-cli.ts"), "utf8");
    const body = main.slice(main.indexOf("async function executeCommand("));
    const gateAt = body.indexOf("gateFlags(command, parsed)");
    const refuseAt = body.indexOf('if (gate.kind === "refuse")');
    const executeAt = body.indexOf("command.execute(");
    expect(gateAt).toBeGreaterThan(0);
    expect(refuseAt).toBeGreaterThan(gateAt);
    expect(executeAt).toBeGreaterThan(refuseAt);
  });

  it("a flag of another action is refused: the contract is per action", () => {
    expect(gate(flowCommand, ["prove", "--session", "001", "--source", "cli"]).kind).toBe("run");
    expect(gate(flowCommand, ["advance", "--session", "001", "--source", "cli"]).kind).toBe(
      "refuse",
    );
  });

  it("a bare `--` never swallows the positional after it", () => {
    const parsed = parseArgv(["flow", "submit", "--session", "001", "--", "foo"]);
    expect(parsed.values.has("")).toBe(false);
    expect(parsed.rest).toEqual(["submit", "foo"]);
    expect(gateFlags(flowCommand, parsed).kind).toBe("run");
  });

  it("a single-dash token is a flag, so an unknown one is refused too", () => {
    expect(parseArgv(["status", "-x"]).flags.has("-x")).toBe(true);
    expect(parseArgv(["tool", "call", "-"]).rest).toEqual(["call", "-"]);
    const outcome = gate(statusCommand, ["-x"]);
    expect(outcome.kind).toBe("refuse");
    if (outcome.kind === "refuse") expect(outcome.result.error?.message).toContain("-x no es");
    expect(gate(selfCommand, ["update", "-y"]).kind).toBe("run");
  });

  it("runtime flags pass on every command", () => {
    expect(gate(statusCommand, ["--json", "--namespace", "workflow", "--ascii"]).kind).toBe("run");
  });

  it("`aw --doctor` still dispatches to doctor, and doctor accepts the alias flag", () => {
    const parsed = parseArgv(["--doctor"]);
    expect(
      planDispatch({ command: undefined, flags: parsed.flags, isTTY: false, hasHelp: false }),
    ).toEqual({ kind: "command", name: "doctor", help: false });
    expect(gateFlags(doctorCommand, parsed).kind).toBe("run");
  });

  it("any other command still refuses --doctor", () => {
    const outcome = gate(sessionCloseCommand, ["--code", "001", "--doctor"]);
    expect(outcome.kind).toBe("refuse");
  });

  it("the refusals that already existed keep their code, message and next action", () => {
    const outcome = gate(sessionCloseCommand, ["--code", "001", "--name", "x"]);
    expect(outcome.kind).toBe("refuse");
    if (outcome.kind !== "refuse") return;
    expect(outcome.result.error).toEqual({
      code: "UNKNOWN_FLAG",
      message: "--name no es un flag de este comando; acepta --code, --refs",
    });
    expect(outcome.result.data).toEqual({
      unknown_flags: ["--name"],
      action: "corregí el flag y reintentá: `aw session-close --code <sesión> [--refs <csv>]`",
    });
  });
});

describe("flag contracts · a command the host runs as a hook warns and runs", () => {
  it("checkpoint-write with an unknown flag runs, with one stderr line naming it", () => {
    const outcome = gate(checkpointWriteCommand, ["--code", "001", "--bogus"]);
    expect(outcome.kind).toBe("run");
    if (outcome.kind !== "run") return;
    expect(outcome.notice).toMatch(/^aw checkpoint-write: --bogus no es un flag de este comando/);
    expect(outcome.notice?.trimEnd().includes("\n")).toBe(false);
  });

  it("the other hook targets warn too, `self namespace` included", () => {
    expect(gate(resumeSummaryCommand, ["--bogus"])).toMatchObject({ kind: "run" });
    expect(gate(hookCommand, ["branch-check", "--bogus"])).toMatchObject({ kind: "run" });
    expect(gate(command("auto-compact-on-close"), ["--bogus"])).toMatchObject({ kind: "run" });
    expect(gate(selfCommand, ["namespace", "--pin", "workflow", "--bogus"])).toMatchObject({
      kind: "run",
    });
    // Only that action: the rest of `self` refuses.
    expect(gate(selfCommand, ["update", "--bogus"]).kind).toBe("refuse");
  });

  it("--can-pause is retired, not unknown: accepted without a notice", () => {
    expect(gate(checkpointWriteCommand, ["--can-pause"])).toEqual({ kind: "run" });
    expect(contractFor(checkpointWriteCommand.flags, undefined).retired).toEqual(["can-pause"]);
  });
});
