#!/usr/bin/env node
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { GitCliAdapter } from "../adapters/git-cli.js";
import { NodeEnv } from "../adapters/node-env.js";
import { NodeFileSystem } from "../adapters/node-file-system.js";
import { NodeProcess } from "../adapters/node-process.js";
import { PathsService } from "../application/paths-service.js";
import { resolveSkills } from "../application/skills-resolver-service.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import { NamespaceResolver } from "../runtime/namespace-resolver.js";
import { bootstrapDsnCommand } from "./commands/bootstrap-dsn.js";
import { checkBranchCommand } from "./commands/check-branch.js";
import { checkpointReadCommand } from "./commands/checkpoint-read.js";
import { autoCompactOnCloseCommand, checkpointWriteCommand } from "./commands/checkpoint-write.js";
import { codeScanCommand } from "./commands/code-scan.js";
import { compressCheckpointCommand } from "./commands/compress-checkpoint.js";
import {
  harnessCommand,
  logsCommand,
  nextNumberCommand,
  profilesCommand,
} from "./commands/dev-only.js";
import { historyDataCommand } from "./commands/history-data.js";
import { historyUpdateCommand } from "./commands/history-update.js";
import { hookCommand } from "./commands/hook.js";
import { hostDoctorCommand } from "./commands/host-doctor.js";
import { mcpCommand } from "./commands/mcp.js";
import { attachMultirootCommand, detachMultirootCommand } from "./commands/multiroot.js";
import { pluginCacheCommand } from "./commands/plugin-cache.js";
import { pluginDoctorCommand } from "./commands/plugin-doctor.js";
import { projectMdUpsertCommand } from "./commands/project-md-upsert.js";
import { releaseDataCommand } from "./commands/release-data.js";
import { resumeSummaryCommand } from "./commands/resume-summary.js";
import { selfCommand } from "./commands/self.js";
import { sessionArtifactsCommand } from "./commands/session-artifacts.js";
import { sessionCloseCommand } from "./commands/session-close.js";
import { sessionCreateCommand } from "./commands/session-create.js";
import { sessionResumeCommand } from "./commands/session-resume.js";
import { sessionsCommand } from "./commands/sessions.js";
import { setWorkingBranchCommand } from "./commands/set-working-branch.js";
import { skillIndexCommand } from "./commands/skill-index.js";
import { skillsCommand } from "./commands/skills.js";
import { sourcesCommand } from "./commands/sources.js";
import { stackCommand } from "./commands/stack.js";
import { visibilityCommand } from "./commands/visibility.js";
import { workspaceInitCommand } from "./commands/workspace-init.js";
import { commandHelpText, renderGroupedCommandLines } from "./help-groups.js";
import { type MenuAction, shouldShowInteractiveMenu } from "./interactive-menu.js";
import { parseArgv } from "./parser.js";
import { CommandRegistry, type QtcCommand } from "./registry.js";
import {
  emitError,
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

  const registry = new CommandRegistry();
  registry.register(sessionsCommand);
  registry.register(historyDataCommand);
  registry.register(historyUpdateCommand);
  registry.register(sessionArtifactsCommand);
  registry.register(sessionCloseCommand);
  registry.register(sessionCreateCommand);
  registry.register(stackCommand);
  registry.register(workspaceInitCommand);
  registry.register(skillIndexCommand);
  registry.register(skillsCommand);
  registry.register(sourcesCommand);
  registry.register(setWorkingBranchCommand);
  registry.register(checkpointReadCommand);
  registry.register(resumeSummaryCommand);
  registry.register(compressCheckpointCommand);
  registry.register(checkBranchCommand);
  registry.register(checkpointWriteCommand);
  registry.register(autoCompactOnCloseCommand);
  registry.register(hookCommand);
  registry.register(mcpCommand);
  registry.register(visibilityCommand);
  registry.register(harnessCommand);
  registry.register(profilesCommand);
  registry.register(logsCommand);
  registry.register(nextNumberCommand);
  registry.register(bootstrapDsnCommand);
  registry.register(codeScanCommand);
  registry.register(pluginCacheCommand);
  registry.register(pluginDoctorCommand);
  registry.register(hostDoctorCommand);
  registry.register(releaseDataCommand);
  registry.register(attachMultirootCommand);
  registry.register(detachMultirootCommand);
  registry.register(projectMdUpsertCommand);
  registry.register(sessionResumeCommand);
  registry.register(selfCommand);

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

  const coreConfigPath = resolveCoreConfigPath(env, paths);
  const runtimeService = new RuntimeConfigService(
    fs,
    env,
    paths,
    coreConfigPath ? { coreConfigPath } : {},
  );
  const runtime = await runtimeService.resolveRuntime();

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
  };

  if (
    shouldShowInteractiveMenu({
      command: parsed.command,
      isTTY,
      hasHelp,
    })
  ) {
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

  // `<command> --help` muestra la ayuda del subcomando (su describe), no la global.
  if (hasHelp) {
    printCommandHelp(command);
    return 0;
  }

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
      // Inicializa el directorio como workspace (1+ fuentes). Sin distinción
      // project/hub. La forma interactiva con recolección de fuentes vive en el
      // TUI (project-tab → WorkspaceInitForm); este path es el fallback CLI con la
      // cwd como única fuente.
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

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
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
    ...renderGroupedCommandLines(commands),
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

function resolveCoreConfigPath(env: NodeEnv, paths: PathsService): string | undefined {
  const fromEnv = env.get("AGENT_WORKFLOW_CONFIG_PATH");
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return join(paths.userLibConfigDir(), "agent-workflow-runtime.json");
}

run(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
