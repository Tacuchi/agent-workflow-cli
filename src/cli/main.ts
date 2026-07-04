#!/usr/bin/env node
import { basename } from "node:path";
import { GitCliAdapter } from "../adapters/git-cli.js";
import { NodeEnv } from "../adapters/node-env.js";
import { NodeFileSystem } from "../adapters/node-file-system.js";
import { NodeProcess } from "../adapters/node-process.js";
import {
  formatCommandError,
  formatCommandInvocation,
  formatCommandOutcome,
  formatTuiEvent,
} from "../application/logging/log-events.js";
import { Logger } from "../application/logging/logger.js";
import { PathsService } from "../application/paths-service.js";
import { resolveSkills } from "../application/skills-resolver-service.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import { NamespaceResolver } from "../runtime/namespace-resolver.js";
import { readPackageVersion } from "../runtime/version.js";
import { ALL_COMMANDS, commandDescribes } from "./commands/index.js";
import { commandHelpText, renderGroupedCommandLines } from "./help-groups.js";
import { type MenuAction, shouldShowInteractiveMenu } from "./interactive-menu.js";
import { parseArgv } from "./parser.js";
import { CommandRegistry, type QtcCommand } from "./registry.js";
import {
  emitError,
  fail,
  formatArgvError,
  formatUnknownCommand,
  renderRaw,
  writeStdout,
} from "./render.js";
import { runTui } from "./tui/run.js";
import type { CliContext } from "./types.js";

async function run(argv: string[]): Promise<ExitCode> {
  const fs = new NodeFileSystem();
  const env = new NodeEnv();
  const proc = new NodeProcess();
  const git = new GitCliAdapter(proc);

  // ALL_COMMANDS (commands/index.ts) is the single source of truth for which
  // commands exist; its order drives the grouped `--help` listing.
  const registry = new CommandRegistry();
  for (const command of ALL_COMMANDS) registry.register(command);

  let parsed: ReturnType<typeof parseArgv>;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    emitError(formatArgvError((err as Error).message));
    return 1;
  }

  if (parsed.flags.has("--version")) {
    writeStdout(`${readPackageVersion()}\n`);
    return 0;
  }

  const isTTY = process.stdout.isTTY === true;
  const hasHelp = parsed.flags.has("--help") || parsed.flags.has("-h");

  const namespaceResolver = new NamespaceResolver(fs, env);
  const namespace = await namespaceResolver.resolve(parsed.values.get("namespace"));

  const paths = new PathsService(namespace.namespace, env.homeDir(), env.cwd());

  const runtimeService = new RuntimeConfigService(fs, env, paths);
  const runtime = await runtimeService.resolveRuntime();

  // Operational logger → global user-level daily log. Best-effort; never throws.
  // Built before ctx so the TUI (and its tabs, via ctx.logger) can log too.
  const logger = new Logger({ fs, paths });

  const skillsResolution = await resolveSkills(fs, paths);
  const ctx: CliContext = {
    fs,
    env,
    git,
    process: proc,
    runtime,
    namespace,
    paths,
    skills: skillsResolution.skills,
    logger,
  };

  if (
    shouldShowInteractiveMenu({
      command: parsed.command,
      isTTY,
      hasHelp,
    })
  ) {
    await logger.info(formatTuiEvent("open"));
    const tuiResult = await runTui(readPackageVersion(), ctx);
    if (tuiResult.kind === "menu-action") {
      return await dispatchMenuAction(tuiResult.action, registry);
    }
    return tuiResult.exitCode;
  }

  if (parsed.command === undefined) {
    printHelp(registry.list());
    return 0;
  }

  const command = registry.resolve(parsed.command);
  if (!command) {
    emitError(formatUnknownCommand(parsed.command, registry.list()));
    return 1;
  }

  // `<command> --help` shows the subcommand's help (its describe), not the global help.
  if (hasHelp) {
    printCommandHelp(command);
    return 0;
  }

  await logger.info(formatCommandInvocation(parsed));
  try {
    const result = await command.execute(parsed, ctx);
    await logger.log(
      result.ok ? "info" : "error",
      formatCommandOutcome(command.name, result.exitCode),
    );
    emit(result);
    return result.exitCode;
  } catch (err) {
    await logger.error(formatCommandError(command.name, err));
    const message = err instanceof Error ? err.message : String(err);
    emit(fail("UNHANDLED", message));
    return 1;
  }
}

function emit<T>(result: CommandResult<T>): void {
  if (result.ok && result.data !== undefined) {
    writeStdout(renderRaw(result.data));
  } else if (result.ok && result.data === undefined) {
    // Command already wrote stdout itself (custom rendering); nothing more to emit.
    return;
  } else {
    const payload: { ok: boolean; error: typeof result.error; data?: unknown } = {
      ok: result.ok,
      error: result.error,
    };
    if (result.data !== undefined) payload.data = result.data;
    writeStdout(renderRaw(payload));
  }
}

async function dispatchMenuAction(
  action: MenuAction,
  registry: CommandRegistry,
): Promise<ExitCode> {
  switch (action) {
    case "doctor":
      return await run(["self", "doctor"]);
    case "install-skill":
      return await run(["self", "install-skill", "--force"]);
    case "mcp":
      return await run(["self", "mcp"]);
    case "update":
      // The TUI menu selection is already the confirmation; --yes
      // suppresses the redundant inquirer prompt (which also races with
      // ink's stdin teardown and can phantom-cancel).
      return await run(["self", "update", "--yes"]);
    case "workspace-init": {
      // Initializes the directory as a workspace (1+ sources). No project/hub
      // distinction. The interactive form that collects sources lives in the
      // TUI (project-tab → WorkspaceInitForm); this path is the CLI fallback
      // with the cwd as the only source.
      const cwd = process.cwd();
      return await run(["workspace-init", "--source", `${basename(cwd)}:${cwd}`]);
    }
    case "help":
      printHelp(registry.list());
      return 0;
    case "exit":
      return 0;
  }
}

function printHelp(commands: string[]): void {
  const lines = [
    "agent-workflow — generic session-lifecycle CLI",
    "",
    "Usage:",
    "  agent-workflow [--namespace <name>]",
    "                 [--plugin-root <path>] [--plugin-version <semver>] [--compat <range>]",
    "                 <command> [args...]",
    "",
    "Namespace resolution order: --namespace flag > AW_NAMESPACE env > workspace",
    "auto-detect (.<ns>/sessions/ in cwd) > ~/.config/agent-workflow/namespace >",
    "default 'agent-workflow'. Plugins can reclaim a namespace via SessionStart",
    "hook; new workspaces use .<namespace>/sessions/.",
    "",
    "Commands:",
    "",
    ...renderGroupedCommandLines(commands, commandDescribes()),
    "",
    "Aliases:",
    "  aw                  short alias of `agent-workflow`",
    "",
  ];
  writeStdout(`${lines.join("\n")}\n`);
}

function printCommandHelp(command: QtcCommand): void {
  writeStdout(`${commandHelpText(command)}\n`);
}

run(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
