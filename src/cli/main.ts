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
import { encodeToolResponse, toolFailure } from "../domain/database-tools.js";
import { redactSensitiveText, redactSensitiveValue } from "../domain/redaction.js";
import type { ResolvedSkills } from "../domain/skills.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import {
  DEFAULT_NAMESPACE,
  NamespaceResolver,
  type WorklineDirectory,
  WorklineDirectoryError,
} from "../runtime/namespace-resolver.js";
import { DEFAULT_RUNTIME_CONFIG } from "../runtime/types.js";
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
  redactErrorEnvelope,
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
  const prepared = prepareInvocation(argv);
  if (typeof prepared === "number") return prepared;
  const initialized = await initializeCliContext(prepared.parsed, fs, env, proc, git);
  if (initialized === null) return transportExitCode(prepared.parsed);

  return await dispatchParsedCommand({
    ...prepared,
    ctx: initialized.ctx,
    registry: commandRegistry(),
    workspaceFs: initialized.workspaceFs,
  });
}

interface PreparedInvocation {
  parsed: ParsedArgs;
  isTTY: boolean;
  hasHelp: boolean;
  output: OutputMode;
}

function prepareInvocation(argv: string[]): PreparedInvocation | ExitCode {
  const parsed = parseCli(argv);
  if (parsed === null) return rawTransportExitCode(argv);
  const hasHelp = parsed.flags.has("--help") || parsed.flags.has("-h");
  if (isMcpStdioInvocation(parsed) && (parsed.flags.has("--version") || hasHelp)) {
    process.stderr.write("aw mcp: --version y --help no son válidos para un servidor stdio\n");
    return 2;
  }
  if (parsed.flags.has("--version")) {
    writeStdout(`${readPackageVersion()}\n`);
    return 0;
  }
  const isTTY = process.stdout.isTTY === true;
  const output = resolveOutputMode(parsed, isTTY);
  if (output.ok) return { parsed, isTTY, hasHelp, output: output.mode };
  return outputModeFailure(parsed, output.message);
}

function rawTransportExitCode(argv: readonly string[]): ExitCode {
  return looksLikeMcpStdioInvocation(argv) || looksLikeToolInvocation(argv) ? 2 : 1;
}

function outputModeFailure(parsed: ParsedArgs, message: string): ExitCode {
  if (parsed.command === "tool") {
    emitToolEarlyFailure("INVALID_INPUT", message);
    return 2;
  }
  if (isMcpStdioInvocation(parsed)) {
    process.stderr.write("aw mcp: argumentos de salida inválidos para un servidor stdio\n");
    return 2;
  }
  emitError(formatArgvError(message));
  return 1;
}

function commandRegistry(): CommandRegistry {
  // ALL_COMMANDS (commands/index.ts) is the single source of truth for which
  // commands exist; its order drives the grouped `--help` listing.
  const registry = new CommandRegistry();
  for (const command of ALL_COMMANDS) registry.register(command);
  return registry;
}

async function initializeCliContext(
  parsed: ParsedArgs,
  fs: NodeFileSystem,
  env: NodeEnv,
  proc: NodeProcess,
  git: GitCliAdapter,
): Promise<{ ctx: CliContext; workspaceFs: MaterializingWorkspaceFileSystem } | null> {
  const directory = await resolveWorklineDirectory(new NamespaceResolver(fs, env), parsed);
  if (directory === null) return null;
  const namespace = { namespace: directory.namespace, source: directory.namespaceSource };
  const paths = new PathsService(namespace.namespace, env.homeDir(), directory.root);
  const workspaceFs = new MaterializingWorkspaceFileSystem(fs, paths);
  const standaloneTransport = parsed.command === "tool" || isMcpStdioInvocation(parsed);
  const runtime = standaloneTransport
    ? defaultStandaloneRuntime()
    : await new RuntimeConfigService(fs, env, paths).resolveRuntime();
  const skills = standaloneTransport
    ? ({} as ResolvedSkills)
    : (await resolveSkills(fs, paths)).skills;
  return {
    workspaceFs,
    ctx: {
      fs: workspaceFs,
      rawFs: fs,
      env,
      git,
      process: proc,
      runtime,
      namespace,
      directory,
      paths,
      skills,
      logger: new Logger({ fs, paths, enabled: !isStrictReadCommand(parsed.command) }),
    },
  };
}

function defaultStandaloneRuntime() {
  return {
    packageName: DEFAULT_RUNTIME_CONFIG.packageName,
    binName: DEFAULT_RUNTIME_CONFIG.binName,
    source: "default" as const,
  };
}

function transportExitCode(parsed: ParsedArgs): ExitCode {
  return parsed.command === "tool" || isMcpStdioInvocation(parsed) ? 2 : 1;
}

function parseCli(argv: string[]): ParsedArgs | null {
  try {
    return parseArgv(argv);
  } catch (err) {
    if (looksLikeMcpStdioInvocation(argv)) {
      process.stderr.write("aw mcp: argumentos del servidor stdio no son válidos\n");
      return null;
    }
    if (looksLikeToolInvocation(argv)) {
      emitToolEarlyFailure("INVALID_INPUT", "Los argumentos de tool no son válidos.");
      return null;
    }
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
    if (!(err instanceof WorklineDirectoryError)) {
      if (parsed.command === "tool") {
        emitToolEarlyFailure("TOOL_RUNTIME_FAILED", "La tool no pudo preparar su entorno.");
        return null;
      }
      if (isMcpStdioInvocation(parsed)) {
        process.stderr.write("aw mcp: no se pudo preparar el servidor stdio\n");
        return null;
      }
      throw err;
    }
    if (parsed.command === "tool") {
      emitToolEarlyFailure(
        "WORKLINE_NAMESPACE_AMBIGUOUS",
        "No se pudo resolver el namespace de la tool.",
      );
      return null;
    }
    if (isMcpStdioInvocation(parsed)) {
      process.stderr.write("aw mcp: no se pudo resolver el namespace del servidor stdio\n");
      return null;
    }
    emitError({
      code: err.code,
      message: err.message,
      details: { root: err.root, namespaces: err.namespaces },
    });
    return null;
  }
}

function emitToolEarlyFailure(code: string, message: string): void {
  writeStdout(encodeToolResponse(toolFailure(code, message)));
}

function looksLikeToolInvocation(argv: readonly string[]): boolean {
  return !looksLikeMcpStdioInvocation(argv) && firstCommandToken(argv) === "tool";
}

function looksLikeMcpStdioInvocation(argv: readonly string[]): boolean {
  const index = argv.indexOf("mcp");
  if (index < 0) return false;
  const subcommand = argv[index + 1];
  return subcommand === "serve" || subcommand === "serve-db" || subcommand === "dbhub";
}

function firstCommandToken(argv: readonly string[]): string | undefined {
  const globalOptionsWithValue = new Set([
    "--namespace",
    "--plugin-root",
    "--plugin-version",
    "--compat",
    // `tool` always renders its own raw JSON, but this global projection flag
    // can precede it. Skip its value while detecting a parse-time tool error so
    // the CLI never falls back to the generic `{ ok, error }` envelope.
    "--format",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) return undefined;
    if (globalOptionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--namespace=") || token.startsWith("--plugin-")) continue;
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function isMcpStdioInvocation(parsed: ParsedArgs): boolean {
  return (
    parsed.command === "mcp" &&
    (parsed.rest[0] === "serve" || parsed.rest[0] === "serve-db" || parsed.rest[0] === "dbhub")
  );
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
    if (isMcpStdioInvocation(parsed)) {
      process.stderr.write("aw mcp: el servidor stdio no pudo iniciar\n");
      return 1;
    }
    const message = redactSensitiveText(err instanceof Error ? err.message : String(err));
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
  if (result.suppressOutput) return;
  if (command.renderRawJson !== undefined) {
    writeStdout(command.renderRawJson(result));
    return;
  }
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
    error: redactErrorEnvelope(
      result.error ?? { code: "UNKNOWN", message: "el comando falló sin detallar la causa" },
    ),
  };
  if (result.data !== undefined) payload.data = redactSensitiveValue(result.data);
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

// Do not force-exit after writing JSON: a piped 4 MiB tool response may still
// be draining under stdout backpressure. `exitCode` preserves the contract
// while allowing Node to flush stdio naturally.
void run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    const argv = process.argv.slice(2);
    if (looksLikeMcpStdioInvocation(argv)) {
      process.stderr.write("aw mcp: el servidor stdio no pudo iniciar\n");
      process.exitCode = 2;
      return;
    }
    if (looksLikeToolInvocation(argv)) {
      emitToolEarlyFailure("TOOL_RUNTIME_FAILED", "La tool no pudo preparar su entorno.");
      process.exitCode = 1;
      return;
    }
    process.stderr.write("agent-workflow: fallo fatal no recuperable\n");
    process.exitCode = 1;
  });
