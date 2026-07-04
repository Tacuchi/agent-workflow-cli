import { selfBootstrap } from "../../application/self/bootstrap.js";
import { selfCleanLegacy } from "../../application/self/clean-legacy.js";
import { selfDetectHosts } from "../../application/self/detect-hosts.js";
import { selfDoctor } from "../../application/self/doctor-self.js";
import { selfInstallHooks } from "../../application/self/install-hooks.js";
import { installPluginSkillsFromGit } from "../../application/self/install-plugin-skills-git.js";
import { selfInstallPluginSkills } from "../../application/self/install-plugin-skills.js";
import { selfInstallSkill } from "../../application/self/install-skill.js";
import { selfMcpConfig } from "../../application/self/mcp-config.js";
import { selfNamespace, selfNamespacePin } from "../../application/self/namespace-info.js";
import { selfClearPluginCache } from "../../application/self/plugin-cache-clear.js";
import { selfUninstallSkill } from "../../application/self/uninstall-skill.js";
import { selfUninstall } from "../../application/self/uninstall.js";
import { selfUpdate } from "../../application/self/update-self.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const SELF_SUBCOMMANDS = [
  "namespace",
  "doctor",
  "detect-hosts",
  "update",
  "install",
  "install-skill",
  "install-hooks",
  "install-plugin-skills",
  "install-plugin-skills-git",
  "uninstall",
  "uninstall-skill",
  "clean-cache",
  "clean-legacy",
  "mcp",
  "bootstrap",
] as const;

export const selfCommand: QtcCommand = {
  name: "self",
  describe:
    "Manage the agent-workflow CLI itself (namespace, doctor, detect-hosts, update, install-skill, install-hooks, install-plugin-skills, install-plugin-skills-git, uninstall-skill, mcp, bootstrap). 'self namespace' prints the active namespace; 'self namespace --pin <name>' persists it to ~/.config/agent-workflow/namespace (cross-platform).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const sub = args.rest[0];
    switch (sub) {
      case "namespace": {
        const pin = args.values.get("pin");
        return pin !== undefined ? selfNamespacePin(ctx, pin) : selfNamespace(ctx);
      }
      case "doctor":
        return selfDoctor(ctx);
      case "detect-hosts":
        return selfDetectHosts(ctx);
      case "update":
        return selfUpdate(args, ctx);
      case "install":
      case "install-skill":
        return selfInstallSkill(args, ctx);
      case "install-hooks":
        return selfInstallHooks(args, ctx);
      case "install-plugin-skills":
        return selfInstallPluginSkills(args, ctx);
      case "install-plugin-skills-git":
        return installPluginSkillsFromGit(args, ctx);
      case "uninstall":
        return selfUninstall(args, ctx);
      case "uninstall-skill":
        return selfUninstallSkill(args, ctx);
      case "clean-cache":
        return runCleanCache(args, ctx);
      case "clean-legacy":
        return selfCleanLegacy(args, ctx);
      case "mcp":
        return selfMcpConfig(args, ctx);
      case "bootstrap":
        return selfBootstrap(args, ctx);
      case undefined:
      case "":
        return {
          ok: true,
          data: {
            subcommands: [...SELF_SUBCOMMANDS],
            help_hint:
              "uso: aw self <subcommand>. Ej: 'aw self mcp' (configurar MCP database), 'aw self bootstrap' o 'aw self doctor'.",
          },
          exitCode: 0,
        };
      default:
        return fail(
          "INVALID_INPUT",
          `unknown self subcommand: '${sub}'. uso: self <${SELF_SUBCOMMANDS.join("|")}>`,
        );
    }
  },
};

async function runCleanCache(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  if (!args.values.has("plugin")) args.values.set("plugin", "agent-workflow");
  return selfClearPluginCache(args, ctx);
}
