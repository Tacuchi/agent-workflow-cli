#!/usr/bin/env node
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
import { MaterializingWorkspaceFileSystem } from "../application/workspace-materialization-service.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import {
  DEFAULT_NAMESPACE,
  NamespaceResolver,
  type WorklineDirectory,
  WorklineDirectoryError,
} from "../runtime/namespace-resolver.js";
import { readPackageVersion } from "../runtime/version.js";
import { ALL_COMMANDS, commandDescribes } from "./commands/index.js";
import { commandHelpText, renderGroupedCommandLines } from "./help-groups.js";
import { type MenuAction, shouldShowInteractiveMenu } from "./interactive-menu.js";
import { type OutputMode, resolveOutputMode } from "./output-mode.js";
import { type ParsedArgs, parseArgv } from "./parser.js";
import { type CliCommand, CommandRegistry } from "./registry.js";
import {
  emitError,
  fail,
  formatArgvError,
  formatUnknownCommand,
  renderHumanError,
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

  const parsed = parseCli(argv);
  if (parsed === null) return 1;

  if (parsed.flags.has("--version")) {
    writeStdout(`${readPackageVersion()}\n`);
    return 0;
  }

  const isTTY = process.stdout.isTTY === true;
  const hasHelp = parsed.flags.has("--help") || parsed.flags.has("-h");

  const output = resolveOutputMode(parsed, isTTY);
  if (!output.ok) {
    emitError(formatArgvError(output.message));
    return 1;
  }

  const namespaceResolver = new NamespaceResolver(fs, env);
  const directory = await resolveWorklineDirectory(namespaceResolver, parsed);
  if (directory === null) return 1;
  const namespace = { namespace: directory.namespace, source: directory.namespaceSource };

  // All workspace-scoped services receive the same root.  In a virgin folder it
  // is exactly the invoked cwd; in a materialized workspace it is its nearest
  // canonical marker's parent — never a guessed repository root.
  const paths = new PathsService(namespace.namespace, env.homeDir(), directory.root);
  // Direct writers are spread across the command surface.  Guard their first
  // workspace-scoped write here so no command can create docs/state before the
  // canonical sessions marker exists.  The two services that already own their
  // materialization receipt receive the raw port below, avoiding a duplicate
  // materialization whose receipt would look merely "existing".
  const workspaceFs = new MaterializingWorkspaceFileSystem(fs, paths);

  const runtimeService = new RuntimeConfigService(fs, env, paths);
  const runtime = await runtimeService.resolveRuntime();

  // Operational logger → global user-level daily log. Best-effort; never throws.
  // Built before ctx so the TUI (and its tabs, via ctx.logger) can log too.
  // `status` and `resume` are strict filesystem reads. Their operational trace
  // must not create even the global daily log when invoked from a virgin folder.
  const logger = new Logger({ fs, paths, enabled: !isStrictReadCommand(parsed.command) });

  const skillsResolution = await resolveSkills(fs, paths);
  const ctx: CliContext = {
    fs: workspaceFs,
    rawFs: fs,
    env,
    git,
    process: proc,
    runtime,
    namespace,
    directory,
    paths,
    skills: skillsResolution.skills,
    logger,
  };

  return await dispatchParsedCommand({
    parsed,
    ctx,
    registry,
    isTTY,
    hasHelp,
    output: output.mode,
    workspaceFs,
  });
}

function parseCli(argv: string[]): ParsedArgs | null {
  try {
    return parseArgv(argv);
  } catch (err) {
    emitError(formatArgvError((err as Error).message));
    return null;
  }
}

async function resolveWorklineDirectory(
  resolver: NamespaceResolver,
  parsed: ParsedArgs,
): Promise<WorklineDirectory | null> {
  try {
    return await resolver.resolveDirectory(parsed.values.get("namespace"));
  } catch (err) {
    if (!(err instanceof WorklineDirectoryError)) throw err;
    emitError({
      code: err.code,
      message: err.message,
      details: { root: err.root, namespaces: err.namespaces },
    });
    return null;
  }
}

interface ParsedCommandDispatch {
  parsed: ParsedArgs;
  ctx: CliContext;
  registry: CommandRegistry;
  isTTY: boolean;
  hasHelp: boolean;
  output: OutputMode;
  workspaceFs: MaterializingWorkspaceFileSystem;
}

async function dispatchParsedCommand(input: ParsedCommandDispatch): Promise<ExitCode> {
  const { parsed, ctx, registry, isTTY, hasHelp, output, workspaceFs } = input;
  if (shouldShowInteractiveMenu({ command: parsed.command, isTTY, hasHelp })) {
    return await runInteractiveMenu(ctx, registry);
  }

  if (parsed.command === undefined) {
    printHelp(registry.list());
    return 0;
  }

  const command = registry.resolve(parsed.command);
  if (command === undefined) {
    emitError(formatUnknownCommand(parsed.command, registry.list()));
    return 1;
  }

  // `<command> --help` shows the subcommand's help (its describe), not the global help.
  if (hasHelp) {
    printCommandHelp(command);
    return 0;
  }

  return await executeCommand(parsed, ctx, command, output, workspaceFs);
}

async function runInteractiveMenu(ctx: CliContext, registry: CommandRegistry): Promise<ExitCode> {
  await ctx.logger?.info(formatTuiEvent("open"));
  const tuiResult = await runTui(readPackageVersion(), ctx);
  return tuiResult.kind === "menu-action"
    ? await dispatchMenuAction(tuiResult.action, registry)
    : tuiResult.exitCode;
}

async function executeCommand(
  parsed: ParsedArgs,
  ctx: CliContext,
  command: CliCommand,
  output: OutputMode,
  workspaceFs: MaterializingWorkspaceFileSystem,
): Promise<ExitCode> {
  await ctx.logger?.info(formatCommandInvocation(parsed));
  try {
    const commandCtx = commandOwnsMaterializationReceipt(command.name)
      ? { ...ctx, fs: ctx.rawFs ?? ctx.fs }
      : ctx;
    const result = attachMaterializationReceipt(
      await command.execute(parsed, commandCtx),
      workspaceFs,
    );
    await ctx.logger?.log(
      result.ok ? "info" : "error",
      formatCommandOutcome(command.name, result.exitCode),
    );
    emit(result, command, output);
    return result.exitCode;
  } catch (err) {
    await ctx.logger?.error(formatCommandError(command.name, err));
    const message = err instanceof Error ? err.message : String(err);
    emit(fail("UNHANDLED", message), command, output);
    return 1;
  }
}

/** Services whose public output already declares the exact first-write effects. */
function commandOwnsMaterializationReceipt(command: string): boolean {
  return command === "workspace-init" || command === "session-create";
}

/**
 * A generic workspace writer still needs to tell its caller that it created the
 * runtime marker.  Preserve every typed command payload and add the forward
 * receipt only when the payload is an object and does not already own that key.
 */
function attachMaterializationReceipt(
  result: CommandResult,
  fs: MaterializingWorkspaceFileSystem,
): CommandResult {
  const materialization = fs.materialization();
  if (
    materialization === undefined ||
    !materialization.materialized ||
    result.data === undefined ||
    result.data === null ||
    Array.isArray(result.data) ||
    typeof result.data !== "object" ||
    "materialization" in result.data
  ) {
    return result;
  }
  return { ...result, data: { ...result.data, materialization } };
}

function isStrictReadCommand(command: string | undefined): boolean {
  return command === "status" || command === "resume";
}

function emit(result: CommandResult, command: CliCommand, mode: OutputMode): void {
  if (result.ok && result.data === undefined) {
    // Command already wrote stdout itself (custom rendering); nothing more to emit.
    return;
  }
  if (mode.format === "human") {
    const rendered = renderHuman(result, command, mode);
    if (rendered !== undefined) {
      writeStdout(rendered);
      return;
    }
  }
  emitJson(result);
}

/**
 * Human projection, or `undefined` when the command declares none — in which
 * case the runtime keeps JSON. Success and failure are kept together on
 * purpose: a command that renders prose on error but JSON on success would be
 * incoherent to read and to script against.
 */
function renderHuman(
  result: CommandResult,
  command: CliCommand,
  mode: OutputMode,
): string | undefined {
  if (command.renderHuman === undefined) return undefined;
  if (!result.ok) return renderHumanError(result.error, result.data);
  return command.renderHuman(result, { detail: mode.detail });
}

function emitJson(result: CommandResult): void {
  if (result.ok) {
    writeStdout(renderRaw(result.data));
    return;
  }
  const payload: { ok: boolean; error: typeof result.error; data?: unknown } = {
    ok: result.ok,
    error: result.error,
  };
  if (result.data !== undefined) payload.data = result.data;
  writeStdout(renderRaw(payload));
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
      // The fallback pre-materializes the current implicit root.  Source
      // configuration remains the Project tab's explicit secondary action.
      return await run(["workspace-init"]);
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
    "agent-workflow — Workline runtime CLI (session lifecycle)",
    "",
    "Usage:",
    "  agent-workflow [--namespace <name>]",
    "                 [--plugin-root <path>] [--plugin-version <semver>] [--compat <range>]",
    "                 <command> [args...]",
    "",
    "Namespace resolution order: --namespace flag > AW_NAMESPACE env > nearest",
    "ancestor marker (.<ns>/sessions/) > ~/.config/agent-workflow/namespace >",
    `default '${DEFAULT_NAMESPACE}'. Without a marker, the invoked directory is the`,
    "implicit root; new workspaces materialize .<namespace>/sessions/ on first write.",
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

function printCommandHelp(command: CliCommand): void {
  writeStdout(`${commandHelpText(command)}\n`);
}

run(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
