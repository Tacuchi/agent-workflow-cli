#!/usr/bin/env node
import { join } from "node:path";
import { GitCliAdapter } from "../adapters/git-cli.js";
import { NodeEnv } from "../adapters/node-env.js";
import { NodeFileSystem } from "../adapters/node-file-system.js";
import { NodeProcess } from "../adapters/node-process.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import { sessionsCommand } from "./commands/sessions.js";
import { parseArgv } from "./parser.js";
import { CommandRegistry } from "./registry.js";
import { renderRaw, writeStderr, writeStdout } from "./render.js";
import type { CliContext } from "./types.js";

async function run(argv: string[]): Promise<ExitCode> {
  const fs = new NodeFileSystem();
  const env = new NodeEnv();
  const proc = new NodeProcess();
  const git = new GitCliAdapter(proc);

  const registry = new CommandRegistry();
  registry.register(sessionsCommand);

  let parsed: ReturnType<typeof parseArgv>;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    writeStderr(`${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.command === undefined || parsed.flags.has("--help") || parsed.flags.has("-h")) {
    printHelp(registry.list());
    return parsed.command === undefined ? 1 : 0;
  }

  const command = registry.resolve(parsed.command);
  if (!command) {
    writeStderr(`Unknown command: ${parsed.command}\n`);
    printHelp(registry.list());
    return 1;
  }

  const coreConfigPath = resolveCoreConfigPath(env);
  const runtimeService = new RuntimeConfigService(
    fs,
    env,
    coreConfigPath ? { coreConfigPath } : {},
  );
  const runtime = await runtimeService.resolveRuntime();

  const ctx: CliContext = { fs, env, git, process: proc, runtime };

  try {
    const result = await command.execute(parsed, ctx);
    emit(result);
    return result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ ok: false, error: { code: "UNHANDLED", message }, exitCode: 1 });
    return 1;
  }
}

function emit<T>(result: CommandResult<T>): void {
  if (result.ok && result.data !== undefined) {
    writeStdout(renderRaw(result.data));
  } else {
    writeStdout(renderRaw({ ok: result.ok, error: result.error }));
  }
}

function printHelp(commands: string[]): void {
  const lines = [
    "agent-workflow — runtime CLI for the qtc-* plugin family",
    "",
    "Usage:",
    "  agent-workflow [--flow <core|dev|design|analyze>] [--plugin-root <path>]",
    "                 [--plugin-version <semver>] [--compat <range>] <command> [args...]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c}`),
    "",
    "Aliases:",
    "  aw                  short alias of `agent-workflow`",
    "",
  ];
  writeStdout(`${lines.join("\n")}\n`);
}

function resolveCoreConfigPath(env: NodeEnv): string | undefined {
  const fromEnv = env.get("QTC_CORE_CONFIG_PATH");
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return join(env.homeDir(), ".qtc", "lib", "config", "agent-workflow-runtime.json");
}

run(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
