#!/usr/bin/env node
import { createRequire } from "node:module";
import { join } from "node:path";
import { GitCliAdapter } from "../adapters/git-cli.js";
import { NodeEnv } from "../adapters/node-env.js";
import { NodeFileSystem } from "../adapters/node-file-system.js";
import { NodeProcess } from "../adapters/node-process.js";
import { PathsService } from "../application/paths-service.js";
import type { CommandResult, ExitCode } from "../domain/types.js";
import { RuntimeConfigService } from "../runtime/config-service.js";
import { NamespaceResolver } from "../runtime/namespace-resolver.js";
import { autoCompactOnCloseCommand, checkpointWriteCommand } from "./commands/checkpoint-write.js";
import { decisionesListCommand } from "./commands/decisiones-list.js";
import { dependenciasListCommand } from "./commands/dependencias-list.js";
import {
  harnessCommand,
  logsCommand,
  nextNumberCommand,
  profilesCommand,
} from "./commands/dev-only.js";
import { historyDataCommand } from "./commands/history-data.js";
import { historyUpdateCommand } from "./commands/history-update.js";
import { hookCommand } from "./commands/hook.js";
import { mcpCommand } from "./commands/mcp.js";
import { attachMultirootCommand, detachMultirootCommand } from "./commands/multiroot.js";
import { objetivoDataCommand } from "./commands/objetivo-data.js";
import {
  autoPlanDecideCommand,
  specialtyChooseCommand,
  topicChangeCheckCommand,
} from "./commands/orchestration.js";
import { pluginDoctorCommand } from "./commands/plugin-doctor.js";
import { projectMdUpsertCommand } from "./commands/project-md-upsert.js";
import { releaseDataCommand } from "./commands/release-data.js";
import { sessionArtifactsCommand } from "./commands/session-artifacts.js";
import { sessionCloseCommand } from "./commands/session-close.js";
import { sessionCreateCommand } from "./commands/session-create.js";
import { sessionResumeCommand } from "./commands/session-resume.js";
import { sessionsCommand } from "./commands/sessions.js";
import { tasksDataCommand } from "./commands/tasks-data.js";
import {
  phaseDetectCommand,
  skillIndexCommand,
  stackCommand,
  workflowsCommand,
  workspaceModeCommand,
} from "./commands/wave2-extras.js";
import {
  checkBranchCommand,
  checkpointReadCommand,
  compressCheckpointCommand,
  phaseNextCommand,
  resumeSummaryCommand,
  sourcesCommand,
} from "./commands/wave2-final.js";
import {
  bootstrapDsnCommand,
  codeScanCommand,
  graduateCommand,
  upgradeHubModeCommand,
} from "./commands/wave4d-simple.js";
import {
  type MenuAction,
  runInteractiveMenu,
  shouldShowInteractiveMenu,
} from "./interactive-menu.js";
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
  registry.register(objetivoDataCommand);
  registry.register(tasksDataCommand);
  registry.register(decisionesListCommand);
  registry.register(dependenciasListCommand);
  registry.register(historyDataCommand);
  registry.register(historyUpdateCommand);
  registry.register(sessionArtifactsCommand);
  registry.register(sessionCloseCommand);
  registry.register(sessionCreateCommand);
  registry.register(autoPlanDecideCommand);
  registry.register(topicChangeCheckCommand);
  registry.register(specialtyChooseCommand);
  registry.register(stackCommand);
  registry.register(workspaceModeCommand);
  registry.register(skillIndexCommand);
  registry.register(phaseDetectCommand);
  registry.register(workflowsCommand);
  registry.register(sourcesCommand);
  registry.register(checkpointReadCommand);
  registry.register(resumeSummaryCommand);
  registry.register(compressCheckpointCommand);
  registry.register(phaseNextCommand);
  registry.register(checkBranchCommand);
  registry.register(checkpointWriteCommand);
  registry.register(autoCompactOnCloseCommand);
  registry.register(hookCommand);
  registry.register(mcpCommand);
  registry.register(harnessCommand);
  registry.register(profilesCommand);
  registry.register(logsCommand);
  registry.register(nextNumberCommand);
  registry.register(bootstrapDsnCommand);
  registry.register(graduateCommand);
  registry.register(upgradeHubModeCommand);
  registry.register(codeScanCommand);
  registry.register(pluginDoctorCommand);
  registry.register(releaseDataCommand);
  registry.register(attachMultirootCommand);
  registry.register(detachMultirootCommand);
  registry.register(projectMdUpsertCommand);
  registry.register(sessionResumeCommand);

  let parsed: ReturnType<typeof parseArgv>;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    writeStderr(`${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.flags.has("--version")) {
    writeStdout(`${readPackageVersion()}\n`);
    return 0;
  }

  const isTTY = process.stdout.isTTY === true;
  const hasHelp = parsed.flags.has("--help") || parsed.flags.has("-h");

  if (
    shouldShowInteractiveMenu({
      command: parsed.command,
      isTTY,
      hasHelp,
    })
  ) {
    const action = await runInteractiveMenu(readPackageVersion());
    return await dispatchMenuAction(action, registry);
  }

  if (parsed.command === undefined || hasHelp) {
    printHelp(registry.list());
    return 0;
  }

  const command = registry.resolve(parsed.command);
  if (!command) {
    writeStderr(`Unknown command: ${parsed.command}\n`);
    printHelp(registry.list());
    return 1;
  }

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

  const ctx: CliContext = { fs, env, git, process: proc, runtime, namespace, paths };

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
    // Command already wrote stdout itself (e.g., auto-plan-decide with custom float repr).
    return;
  } else {
    writeStdout(renderRaw({ ok: result.ok, error: result.error }));
  }
}

async function dispatchMenuAction(
  action: MenuAction,
  registry: CommandRegistry,
): Promise<ExitCode> {
  switch (action) {
    case "doctor":
      writeStdout("Doctor will run in Phase 5b. For now, use `agent-workflow plugin-doctor`.\n");
      return 0;
    case "update":
      writeStdout(
        "Update will run in Phase 5b. For now, run `npm install -g @tacuchi/agent-workflow@latest` manually.\n",
      );
      return 0;
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
    "  agent-workflow [--namespace <name>] [--flow <core|dev|design|analyze>]",
    "                 [--plugin-root <path>] [--plugin-version <semver>] [--compat <range>]",
    "                 <command> [args...]",
    "",
    "Namespace controls the artifact directory (default: 'agent-workflow'). Set",
    "`AW_NAMESPACE=<name>` or pass `--namespace <name>` to use a custom namespace.",
    "For qtc-* plugin compatibility, use --namespace qtc.",
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

function resolveCoreConfigPath(env: NodeEnv, paths: PathsService): string | undefined {
  const fromEnv = env.get("QTC_CORE_CONFIG_PATH");
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return join(paths.userLibConfigDir(), "agent-workflow-runtime.json");
}

run(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
