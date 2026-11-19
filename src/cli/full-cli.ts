import { dirname, resolve } from "node:path";
import { GitCliAdapter } from "../adapters/git-cli.js";
import { NodeArchive } from "../adapters/node-archive.js";
import { NodeEnv } from "../adapters/node-env.js";
import { NodeFileSystem } from "../adapters/node-file-system.js";
import { NodeProcess } from "../adapters/node-process.js";
import { MaterializingHubFileSystem } from "../application/hub-materialization-service.js";
import {
  formatCommandError,
  formatCommandInvocation,
  formatCommandOutcome,
  formatTuiEvent,
} from "../application/logging/log-events.js";
import { Logger } from "../application/logging/logger.js";
import { legacyBlockFiles } from "../application/parsers/hub-block.js";
import { PathsService } from "../application/paths-service.js";
import { preparationMismatch, recordPreparation } from "../application/preparation-receipts.js";
import { retiredNameState } from "../application/retired-name-migration.js";
import { resolveSkills } from "../application/skills-resolver-service.js";
import { redactSensitiveText, redactSensitiveValue } from "../domain/redaction.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { isAgentWorkflowRoot } from "../runtime/agent-workflow-marker.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import {
  HubResolutionError,
  hubMigrationRequired,
  hubSessionsMigrationRequired,
  registerResolvedHub,
  resolveHubDirectory,
  sessionModelLeftovers,
} from "../runtime/hub-resolution.js";
import {
  type AgentWorkflowDirectory,
  AgentWorkflowDirectoryError,
  DEFAULT_NAMESPACE,
  NamespaceResolver,
} from "../runtime/namespace-resolver.js";
import { readPackageVersion } from "../runtime/version.js";
import { ALL_COMMANDS } from "./commands/index.js";
import { gateFlags } from "./commands/unknown-flags.js";
import { planDispatch, resolveGlobalAlias } from "./dispatch-plan.js";
import { commandHelpText, globalHelpText } from "./help-groups.js";
import { OUTSIDE_HUB_TEXT, insideHub } from "./interactive-menu.js";
import { nextStepOfError, nextStepOfRoots } from "./next-step-emit.js";
import { ASCII_ENV, type OutputMode, resolveOutputMode } from "./output-mode.js";
import { type ParsedArgs, parseArgv } from "./parser.js";
import { type CliCommand, CommandRegistry } from "./registry.js";
import { renamedInvocation } from "./renamed.js";
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
import type { CliContext } from "./types.js";

async function run(argv: string[]): Promise<ExitCode> {
  const fs = new NodeFileSystem();
  const env = new NodeEnv();
  const proc = new NodeProcess();
  const git = new GitCliAdapter(proc);
  const prepared = prepareInvocation(argv);
  if (typeof prepared === "number") return prepared;
  const initialized = await initializeCliContext(prepared.parsed, fs, env, proc, git);
  if (initialized === null) {
    return isHookCommand(prepared.parsed) ? 0 : 1;
  }

  const retired = await retiredNameState(fs, initialized.ctx.paths);
  const exit = await dispatchParsedCommand({
    ...prepared,
    ctx: initialized.ctx,
    registry: commandRegistry(),
    hubFs: initialized.hubFs,
  });
  const after = await retiredNameState(fs, initialized.ctx.paths);
  if ((retired.marker && !after.marker) || (retired.heading && !after.heading))
    writeStderr(
      "Migrado el nombre retirado Workline a agent-workflow: marcador, encabezado y notas de decisión.",
    );
  else if (retired.marker || retired.heading)
    writeStderr(
      "El hub usa el nombre retirado Workline; aw hub-migrate muestra la migración y --apply la aplica.",
    );
  const warning = initialized.ctx.directory
    ? await registerResolvedHub(fs, env.homeDir(), initialized.ctx.directory)
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
  if (parsed === null) return 1;
  const retired = renamedInvocation(parsed);
  if (retired !== null) {
    emitError(retired);
    return 1;
  }
  const hasHelp = parsed.flags.has("--help") || parsed.flags.has("-h");
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
  return outputModeFailure(output.message);
}

function outputModeFailure(message: string): ExitCode {
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
): Promise<{ ctx: CliContext; hubFs: MaterializingHubFileSystem } | null> {
  const directory = await resolveAgentWorkflowDirectory(
    new NamespaceResolver(fs, env),
    parsed,
    fs,
    env,
  );
  if (directory === null) return null;
  const warning = await registerResolvedHub(fs, env.homeDir(), directory);
  if (warning) writeStderr(warning);
  const namespace = { namespace: directory.namespace, source: directory.namespaceSource };
  const paths = new PathsService(namespace.namespace, env.homeDir(), directory.root);
  const hubFs = new MaterializingHubFileSystem(fs, paths);
  const runtime = await new RuntimeConfigService(fs, env, paths).resolveRuntime();
  const skills = (await resolveSkills(fs, paths)).skills;
  return {
    hubFs,
    ctx: {
      archive: new NodeArchive(),
      fs: hubFs,
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

function parseCli(argv: string[]): ParsedArgs | null {
  try {
    return parseArgv(argv);
  } catch (err) {
    emitError(formatArgvError((err as Error).message));
    return null;
  }
}

async function resolveAgentWorkflowDirectory(
  resolver: NamespaceResolver,
  parsed: ParsedArgs,
  fs: NodeFileSystem,
  env: NodeEnv,
): Promise<AgentWorkflowDirectory | null> {
  try {
    const directory = await resolveCliDirectory(resolver, parsed, fs, env);
    if (directory !== null && !exemptFromHubMigration(parsed)) {
      const legacy = await legacyBlockFiles(fs, directory.root);
      if (legacy.length > 0) throw hubMigrationRequired(directory.root, legacy);
      const leftovers = await sessionModelLeftovers(fs, directory.root, directory.namespace);
      if (leftovers.length > 0) throw hubSessionsMigrationRequired(directory.root, leftovers);
    }
    return directory;
  } catch (err) {
    return directoryFailure(err, parsed);
  }
}

/**
 * What still answers in a hub whose block wears pre-29 markers: the migration
 * itself, and what does not operate on a hub (doctor, help, the
 * machine-scoped commands).
 */
function exemptFromHubMigration(parsed: ParsedArgs): boolean {
  return parsed.command === "hub-migrate" || runsWithoutHub(parsed);
}

async function resolveCliDirectory(
  resolver: NamespaceResolver,
  parsed: ParsedArgs,
  fs: NodeFileSystem,
  env: NodeEnv,
): Promise<AgentWorkflowDirectory | null> {
  const directory = await resolver.resolveDirectory(parsed.values.get("namespace"));
  if (parsed.command === "hub-init") return directory;
  try {
    return await resolveHubDirectory(
      fs,
      directory,
      env.cwd(),
      env.homeDir(),
      parsed.values.get("hub"),
    );
  } catch (error) {
    if (!(error instanceof HubResolutionError)) throw error;
    const withoutHub = { ...directory, root: env.cwd(), materialized: false };
    if (isHookCommand(parsed)) {
      writeStderr(error.message);
      return null;
    }
    if (runsWithoutHub(parsed)) return withoutHub;
    throw error;
  }
}

// `checkpoint-write` is no hook target since 29.0.0, but hosts not yet
// reinstalled still run it on PreCompact, $HOME included: a non-zero exit would
// hold that event back, so without a hub it only reports on stderr.
function isHookCommand(parsed: ParsedArgs): boolean {
  return parsed.command === "checkpoint-write";
}

// Their scope is the user's machine (installation, host configs), not a
// hub, so any cwd works — $HOME included.
const MACHINE_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "self",
  "context-budget",
  "doctor",
  "hubs",
]);

function runsWithoutHub(parsed: ParsedArgs): boolean {
  return (
    parsed.command === undefined ||
    MACHINE_SCOPED_COMMANDS.has(parsed.command) ||
    parsed.flags.has("--help") ||
    parsed.flags.has("-h")
  );
}

interface ParsedCommandDispatch {
  parsed: ParsedArgs;
  ctx: CliContext;
  registry: CommandRegistry;
  isTTY: boolean;
  hasHelp: boolean;
  output: OutputMode;
  hubFs: MaterializingHubFileSystem;
}

async function dispatchParsedCommand(input: ParsedCommandDispatch): Promise<ExitCode> {
  const { parsed, ctx, registry, isTTY, hasHelp, output, hubFs } = input;
  // The decision — menu, help or which command, alias included — belongs to
  // `planDispatch`, which is importable and therefore testable. What is left
  // here is carrying it out: no ordering and no command name of its own.
  const plan = planDispatch({ command: parsed.command, flags: parsed.flags, isTTY, hasHelp });
  if (plan.kind === "menu") return await runInteractiveMenu(ctx, output);
  if (plan.kind === "global-help") {
    printHelp(registry.list(), output, parsed.flags.has("--all"));
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

  return await executeCommand(parsed, ctx, command, output, hubFs);
}

async function runInteractiveMenu(ctx: CliContext, output: OutputMode): Promise<ExitCode> {
  if (!(await insideHub(ctx))) {
    writeStdout(forPerson(OUTSIDE_HUB_TEXT, output));
    return 0;
  }
  await ctx.logger?.info(formatTuiEvent("open"));
  const { runTui } = await import("./tui/run.js");
  const tuiResult = await runTui(readPackageVersion(), ctx);
  if (tuiResult.kind === "exit") return tuiResult.exitCode;
  // Re-entering `run` resolves the output mode again: the mark the TUI was
  // opened with travels with it. Pressing `u` is already the confirmation;
  // --yes keeps inquirer from racing Ink's stdin teardown.
  return await run(["self", "update", "--yes", ...(output.ascii ? ["--ascii"] : [])]);
}

async function executeCommand(
  parsed: ParsedArgs,
  ctx: CliContext,
  command: CliCommand,
  output: OutputMode,
  hubFs: MaterializingHubFileSystem,
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
    if (approval && HUB_SEALED_COMMANDS.has(command.name)) {
      const mismatch = await preparationMismatch(ctx.paths, command.name, approval);
      if (mismatch) {
        const refused = fail("HUB_MISMATCH", mismatch);
        emit(refused, command, output);
        return refused.exitCode;
      }
    }
    const commandCtx =
      commandOwnsMaterializationReceipt(command.name) ||
      (await machineScopedWithoutHub(command.name, ctx))
        ? { ...ctx, fs: ctx.rawFs ?? ctx.fs }
        : ctx;
    const result = attachMaterializationReceipt(await command.execute(parsed, commandCtx), hubFs);
    await recordCommandPreparation(result, command, parsed, ctx);
    await ctx.logger?.log(
      result.ok ? "info" : "error",
      formatCommandOutcome(command.name, result.exitCode),
    );
    emit(result, command, output, adoptionNotice(command, hubFs));
    return result.exitCode;
  } catch (err) {
    await ctx.logger?.error(formatCommandError(command.name, err));
    return commandCrashExit(err, command, output, hubFs);
  }
}

function commandCrashExit(
  err: unknown,
  command: CliCommand,
  output: OutputMode,
  hubFs: MaterializingHubFileSystem,
): ExitCode {
  const message = redactSensitiveText(err instanceof Error ? err.message : String(err));
  // A hub refused mid-command (a materializing write, a guarded path) keeps its
  // own code, as when resolution refuses it before the command runs.
  const code = err instanceof HubResolutionError ? err.code : "UNHANDLED";
  emit(fail(code, message), command, output, adoptionNotice(command, hubFs));
  return 1;
}

const HUB_SEALED_COMMANDS = new Set([
  "persist",
  "hub-compact",
  "export-scripts",
  "capability",
  "reseal",
  "settle",
  "flow",
  "discard",
  "doctor",
]);

/** Services whose public output already declares the exact first-write effects. */
/**
 * A machine-scoped command launched where no hub resolved writes host and user
 * state (`~/.claude/settings.json`, `~/.<ns>/hubs.json`), never a hub: with the
 * materializing port, a write under the cwd — `$HOME` itself — would try to
 * found one there and fail with «$HOME no es un hub».
 */
async function machineScopedWithoutHub(command: string, ctx: CliContext): Promise<boolean> {
  if (!MACHINE_SCOPED_COMMANDS.has(command)) return false;
  const root = resolve(ctx.paths.hubDir());
  // ~/.<ns> carries the user-level marker, yet $HOME is never a hub.
  if (root === dirname(ctx.paths.userRoot())) return true;
  return !(await isAgentWorkflowRoot(ctx.rawFs ?? ctx.fs, root, ctx.paths.namespace));
}

function commandOwnsMaterializationReceipt(command: string): boolean {
  return command === "hub-init" || command === "session-create";
}

/**
 * The line that says out loud which path agent-workflow just adopted, or `undefined`.
 *
 * The receipt already travelled in `result.data`, and in a terminal nobody reads
 * that: the human projection is each command's own `renderHuman`, and the only
 * one that printed the adoption was `hub-init` — the command nobody needs
 * to be told by. So adopting a directory was silent exactly where it matters,
 * and a command launched one folder down from a real hub could found a
 * second one inside it without a word. It is emitted once, by the dispatcher, so
 * no command has to remember; the two that declare it themselves are skipped.
 */
function adoptionNotice(command: CliCommand, fs: MaterializingHubFileSystem): string | undefined {
  if (commandOwnsMaterializationReceipt(command.name)) return undefined;
  const materialization = fs.materialization();
  if (materialization === undefined || !materialization.materialized) return undefined;
  return `agent-workflow adoptó ${materialization.root} como hub (namespace ${materialization.namespace}).`;
}

/**
 * A generic hub writer still needs to tell its caller that it created the
 * runtime marker.  Preserve every typed command payload and add the forward
 * receipt only when the payload is an object and does not already own that key.
 */
function attachMaterializationReceipt(
  result: CommandResult,
  fs: MaterializingHubFileSystem,
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
  if (
    command === "hub-compact" &&
    parsed.rest[0] !== "apply" &&
    !(parsed.rest[0] === "restore" && parsed.values.has("approval"))
  )
    return true;
  // `host-memory` reads other hosts' private memory: its trace stays out of the log too.
  if (command === "status" || command === "resume" || command === "host-memory") return true;
  if (command === "flow" && parsed.rest[0] === "read") return true;
  return command === "doctor" && parsed.rest.length === 0;
}

function emit(
  outcome: CommandResult,
  command: CliCommand,
  mode: OutputMode,
  adopted?: string,
): void {
  if (outcome.suppressOutput) return;
  const result = outcome.ok ? outcome : withNextStep(outcome);
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
  emitJson(result, command, mode);
}

/** A failed result with the typed next step its error knows, in `data.next_step`. */
function withNextStep(result: CommandResult): CommandResult {
  const next = nextStepOfError(result.data, process.argv.slice(2));
  if (next === null) return result;
  return { ...result, data: { ...(result.data as object | undefined), ...next } };
}

function emitJson(result: CommandResult, command: CliCommand, mode: OutputMode): void {
  if (result.ok) {
    const data =
      command.projectJson === undefined
        ? result.data
        : command.projectJson(result.data, { detail: mode.detail });
    writeStdout(renderRaw(data));
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

function printHelp(commands: string[], mode: Pick<OutputMode, "ascii">, all = false): void {
  const registered = new Set(commands);
  const entries = ALL_COMMANDS.filter((command) => registered.has(command.name));
  writeStdout(forPerson(globalHelpText(entries, DEFAULT_NAMESPACE, { all }), mode));
}

function printCommandHelp(
  command: CliCommand,
  mode: Pick<OutputMode, "ascii">,
  action?: string,
): void {
  writeStdout(forPerson(`${commandHelpText(command, action)}\n`, mode));
}

// Do not force-exit after writing JSON: a large response may still
// be draining under stdout backpressure. `exitCode` preserves the contract
// while allowing Node to flush stdio naturally.
void run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.stderr.write("agent-workflow: fallo fatal no recuperable\n");
    process.exitCode = 1;
  });

function directoryFailure(err: unknown, parsed: ParsedArgs): null {
  if (err instanceof HubResolutionError) {
    if (isHookCommand(parsed)) {
      writeStderr(err.message);
      return null;
    }
    const next =
      err.action !== undefined
        ? { action: err.action }
        : nextStepOfRoots(err.roots, process.argv.slice(2));
    emitError(
      { code: err.code, message: err.message, details: { roots: err.roots } },
      next ?? undefined,
    );
    return null;
  }
  if (!(err instanceof AgentWorkflowDirectoryError)) throw err;
  emitError({
    code: err.code,
    message: err.message,
    details: { root: err.root, namespaces: err.namespaces },
  });
  return null;
}

async function recordCommandPreparation(
  result: CommandResult,
  command: CliCommand,
  parsed: ParsedArgs,
  ctx: CliContext,
): Promise<void> {
  if (
    result.ok &&
    HUB_SEALED_COMMANDS.has(command.name) &&
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
}
