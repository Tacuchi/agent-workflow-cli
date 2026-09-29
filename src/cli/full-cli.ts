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
import { preparationMismatch, recordPreparation } from "../application/preparation-receipts.js";
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
import {
  WorkspaceResolutionError,
  registerResolvedWorkspace,
  resolveWorkspaceDirectory,
} from "../runtime/workspace-resolution.js";
import { ALL_COMMANDS, commandDescribes } from "./commands/index.js";
import { gateFlags } from "./commands/unknown-flags.js";
import { planDispatch, resolveGlobalAlias } from "./dispatch-plan.js";
import { commandHelpText, globalHelpText } from "./help-groups.js";
import type { MenuAction } from "./interactive-menu.js";
import { ASCII_ENV, type OutputMode, resolveOutputMode } from "./output-mode.js";
import { type ParsedArgs, parseArgv } from "./parser.js";
import { type CliCommand, CommandRegistry } from "./registry.js";
import {
  emitError,
  fail,
  forPerson,
  formatArgvError,
  formatUnknownCommand,
  redactErrorEnvelope,
  renderHumanProjection,
  renderRaw,
  useAsciiStderr,
  writeStderr,
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
  if (initialized === null)
    return prepared.parsed.command === "hook" ? 0 : transportExitCode(prepared.parsed);

  const exit = await dispatchParsedCommand({
    ...prepared,
    ctx: initialized.ctx,
    registry: commandRegistry(),
    workspaceFs: initialized.workspaceFs,
  });
  const warning = initialized.ctx.directory
    ? await registerResolvedWorkspace(fs, env.homeDir(), initialized.ctx.directory)
    : null;
  if (warning) writeStderr(warning);
  return exit;
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
  // Global ONLY when nothing else was asked. With a command present `--version`
  // belongs to that command — `release-pass` names one on every verb — and
  // answering with the CLI's own version would silently swallow the invocation.
  if (parsed.command === undefined && parsed.flags.has("--version")) {
    writeStdout(`${readPackageVersion()}\n`);
    return 0;
  }
  const isTTY = process.stdout.isTTY === true;
  const output = resolveOutputMode(parsed, isTTY, process.env[ASCII_ENV]);
  if (output.ok) {
    useAsciiStderr(output.mode.ascii);
    return { parsed, isTTY, hasHelp, output: output.mode };
  }
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
  const directory = await resolveWorklineDirectory(new NamespaceResolver(fs, env), parsed, fs, env);
  if (directory === null) return null;
  const warning = await registerResolvedWorkspace(fs, env.homeDir(), directory);
  if (warning) writeStderr(warning);
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
      logger: new Logger({
        fs,
        paths,
        enabled: !isStrictReadCommand(parsed),
      }),
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
  fs: NodeFileSystem,
  env: NodeEnv,
): Promise<WorklineDirectory | null> {
  try {
    const directory = await resolver.resolveDirectory(parsed.values.get("namespace"));
    if (parsed.command === "workspace-init") return directory;
    const bypass =
      parsed.command === "tool" ||
      parsed.command === "self" ||
      parsed.command === "context-budget" ||
      isMcpStdioInvocation(parsed) ||
      parsed.flags.has("--help") ||
      parsed.flags.has("-h") ||
      parsed.command === undefined;
    try {
      return await resolveWorkspaceDirectory(
        fs,
        directory,
        env.cwd(),
        env.homeDir(),
        parsed.values.get("workspace"),
      );
    } catch (error) {
      if (error instanceof WorkspaceResolutionError && (bypass || parsed.command === "hook")) {
        if (parsed.command === "hook") {
          writeStderr(error.message);
          return null;
        }
        return { ...directory, root: env.cwd(), materialized: false };
      }
      throw error;
    }
  } catch (err) {
    if (err instanceof WorkspaceResolutionError) {
      if (parsed.command === "hook") {
        writeStderr(err.message);
        return null;
      }
      emitError({ code: err.code, message: err.message, details: { roots: err.roots } });
      return null;
    }
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
    "--workspace",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) return undefined;
    if (globalOptionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--namespace=") ||
      token.startsWith("--workspace=") ||
      token.startsWith("--plugin-")
    )
      continue;
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
  // The decision — menu, help or which command, alias included — belongs to
  // `planDispatch`, which is importable and therefore testable. What is left
  // here is carrying it out: no ordering and no command name of its own.
  const plan = planDispatch({ command: parsed.command, flags: parsed.flags, isTTY, hasHelp });
  if (plan.kind === "menu") return await runInteractiveMenu(ctx, registry, output);
  if (plan.kind === "global-help") {
    printHelp(registry.list(), output);
    return 0;
  }

  const command = registry.resolve(plan.name);
  if (command === undefined) {
    emitError(formatUnknownCommand(plan.name, registry.list()));
    return 1;
  }

  // `<command> --help` shows the subcommand's help (its describe), not the global help.
  if (plan.help) {
    printCommandHelp(command, output, parsed.rest[0]);
    return 0;
  }

  return await executeCommand(parsed, ctx, command, output, workspaceFs);
}

async function runInteractiveMenu(
  ctx: CliContext,
  registry: CommandRegistry,
  output: OutputMode,
): Promise<ExitCode> {
  await ctx.logger?.info(formatTuiEvent("open"));
  const tuiResult = await runTui(readPackageVersion(), ctx);
  return tuiResult.kind === "menu-action"
    ? await dispatchMenuAction(tuiResult.action, registry, output)
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
  // Before `execute`, so a flag the command would ignore can never leave it
  // waiting on a stdin its caller meant to replace.
  const gate = gateFlags(command, parsed);
  if (gate.kind === "refuse") {
    await ctx.logger?.error(formatCommandOutcome(command.name, gate.result.exitCode));
    emit(gate.result, command, output);
    return gate.result.exitCode;
  }
  if (gate.notice !== undefined) writeStderr(gate.notice);
  try {
    const approval = parsed.values.get("approval");
    if (approval && WORKSPACE_SEALED_COMMANDS.has(command.name)) {
      const mismatch = await preparationMismatch(ctx.paths, command.name, approval);
      if (mismatch) {
        const refused = fail("WORKSPACE_MISMATCH", mismatch);
        emit(refused, command, output);
        return refused.exitCode;
      }
    }
    const commandCtx = commandOwnsMaterializationReceipt(command.name)
      ? { ...ctx, fs: ctx.rawFs ?? ctx.fs }
      : ctx;
    const result = attachMaterializationReceipt(
      await command.execute(parsed, commandCtx),
      workspaceFs,
    );
    if (
      result.ok &&
      WORKSPACE_SEALED_COMMANDS.has(command.name) &&
      result.data &&
      typeof result.data === "object"
    ) {
      const data = result.data as Record<string, unknown>;
      const digest =
        data.approval_digest ??
        data.digest ??
        (data.proposal && typeof data.proposal === "object"
          ? (data.proposal as Record<string, unknown>).digest
          : undefined);
      if (typeof digest === "string" && digest.length > 0 && parsed.rest[0] !== "apply") {
        try {
          await recordPreparation(ctx.rawFs ?? ctx.fs, ctx.paths, command.name, digest);
        } catch (error) {
          writeStderr(`No se pudo guardar el recibo de preparación: ${String(error)}`);
        }
      }
    }
    await ctx.logger?.log(
      result.ok ? "info" : "error",
      formatCommandOutcome(command.name, result.exitCode),
    );
    emit(result, command, output, adoptionNotice(command, workspaceFs));
    return result.exitCode;
  } catch (err) {
    await ctx.logger?.error(formatCommandError(command.name, err));
    if (isMcpStdioInvocation(parsed)) {
      process.stderr.write("aw mcp: el servidor stdio no pudo iniciar\n");
      return 1;
    }
    const message = redactSensitiveText(err instanceof Error ? err.message : String(err));
    emit(fail("UNHANDLED", message), command, output, adoptionNotice(command, workspaceFs));
    return 1;
  }
}

const WORKSPACE_SEALED_COMMANDS = new Set([
  "persist",
  "export-scripts",
  "export-diagrams",
  "export-reports",
  "export-manuals",
  "capability",
  "reseal",
  "settle",
  "claims",
  "flow",
  "discard",
  "reset",
  "doctor",
]);

/** Services whose public output already declares the exact first-write effects. */
function commandOwnsMaterializationReceipt(command: string): boolean {
  return command === "workspace-init" || command === "session-create";
}

/**
 * The line that says out loud which path Workline just adopted, or `undefined`.
 *
 * The receipt already travelled in `result.data`, and in a terminal nobody reads
 * that: the human projection is each command's own `renderHuman`, and the only
 * one that printed the adoption was `workspace-init` — the command nobody needs
 * to be told by. So adopting a directory was silent exactly where it matters,
 * and a command launched one folder down from a real workspace could found a
 * second one inside it without a word. It is emitted once, by the dispatcher, so
 * no command has to remember; the two that declare it themselves are skipped.
 */
function adoptionNotice(
  command: CliCommand,
  fs: MaterializingWorkspaceFileSystem,
): string | undefined {
  if (commandOwnsMaterializationReceipt(command.name)) return undefined;
  const materialization = fs.materialization();
  if (materialization === undefined || !materialization.materialized) return undefined;
  return `Workline adoptó ${materialization.root} como workspace (namespace ${materialization.namespace}).`;
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

/**
 * El comando que la invocación va a correr de verdad: el explícito, o el que
 * resuelve un alias global.
 *
 * `aw --doctor` no lleva comando —el alias lo resuelve `planDispatch` más
 * tarde—, así que juzgar sólo `parsed.command` dejaba justo a esa superficie
 * (la que la spec pinta como «corrélo a ciegas») fuera de la exención de sólo
 * lectura y con la bitácora habilitada.
 */
function effectiveCommandName(parsed: ParsedArgs): string | undefined {
  if (parsed.command !== undefined) return parsed.command;
  return resolveGlobalAlias({
    command: parsed.command,
    flags: parsed.flags,
    isTTY: false,
    hasHelp: false,
  });
}

/**
 * Comandos que prometen NO tocar el disco de la persona, ni siquiera su bitácora.
 *
 * `doctor` está acá porque su contrato es exactamente ese: la fase diagnóstica se
 * corre a ciegas y no deja rastro. Con el logger habilitado, cada `aw doctor`
 * creaba `~/.workflow/logs/` y le anexaba la invocación y el resultado, así que
 * la promesa era falsa en la superficie real aunque ningún proveedor escribiera.
 *
 * Pero la exención es del INFORME, no del comando: `doctor apply` reescribe la
 * configuración de los hosts y corre programas, y `doctor prepare` es el paso que
 * produce el digest que autoriza eso. Eximirlos por compartir el nombre dejaba sin
 * rastro justamente las dos invocaciones que hay que poder auditar después. Por
 * eso el subverbo cuenta: exento cuando `aw doctor` se corre a secas, registrado
 * en cuanto hay uno.
 */
function isStrictReadCommand(parsed: ParsedArgs): boolean {
  const command = effectiveCommandName(parsed);
  // `host-memory` reads other hosts' private memory: its trace stays out of the log too.
  if (command === "status" || command === "resume" || command === "host-memory") return true;
  return command === "doctor" && parsed.rest.length === 0;
}

function emit(
  result: CommandResult,
  command: CliCommand,
  mode: OutputMode,
  adopted?: string,
): void {
  if (result.suppressOutput) return;
  // Before anything the command prints: the adoption is the frame its output
  // happened in, and it reads as an afterthought underneath a JSON blob.
  if (adopted !== undefined && mode.format === "human" && command.renderRawJson === undefined) {
    writeStdout(forPerson(`${adopted}\n`, mode));
  }
  if (command.renderRawJson !== undefined) {
    writeStdout(command.renderRawJson(result));
    return;
  }
  if (result.ok && result.data === undefined) {
    // Command already wrote stdout itself (custom rendering); nothing more to emit.
    return;
  }
  if (mode.format === "human") {
    const rendered = renderHumanProjection(result, command, mode);
    if (rendered !== undefined) {
      writeStdout(rendered);
      return;
    }
  }
  emitJson(result);
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
  output: OutputMode,
): Promise<ExitCode> {
  // Each action re-enters `run` with a fresh argv, which resolves the output
  // mode again: the mark the menu was opened with has to travel with it.
  const mark = output.ascii ? ["--ascii"] : [];
  switch (action) {
    case "doctor":
      return await run(["self", "doctor", ...mark]);
    case "install-skill":
      return await run(["self", "install-skill", "--force", ...mark]);
    case "mcp":
      return await run(["self", "mcp", ...mark]);
    case "update":
      // The TUI menu selection is already the confirmation; --yes
      // suppresses the redundant inquirer prompt (which also races with
      // ink's stdin teardown and can phantom-cancel).
      return await run(["self", "update", "--yes", ...mark]);
    case "workspace-init": {
      // The fallback pre-materializes the current implicit root.  Source
      // configuration remains the Project tab's explicit secondary action.
      return await run(["workspace-init", ...mark]);
    }
    case "help":
      printHelp(registry.list(), output);
      return 0;
    case "exit":
      return 0;
  }
}

function printHelp(commands: string[], mode: Pick<OutputMode, "ascii">): void {
  writeStdout(forPerson(globalHelpText(commands, commandDescribes(), DEFAULT_NAMESPACE), mode));
}

function printCommandHelp(
  command: CliCommand,
  mode: Pick<OutputMode, "ascii">,
  action?: string,
): void {
  writeStdout(forPerson(`${commandHelpText(command, action)}\n`, mode));
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
