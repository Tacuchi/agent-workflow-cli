import { selfBootstrap } from "../../application/self/bootstrap.js";
import { selfDoctor } from "../../application/self/doctor-self.js";
import { installPluginSkillsFromGit } from "../../application/self/install-plugin-skills-git.js";
import { selfInstallPluginSkills } from "../../application/self/install-plugin-skills.js";
import { selfInstallSkill } from "../../application/self/install-skill.js";
import { selfMcpConfig } from "../../application/self/mcp-config.js";
import { selfNamespace } from "../../application/self/namespace-info.js";
import { selfUninstallSkill } from "../../application/self/uninstall-skill.js";
import { selfUpdate } from "../../application/self/update-self.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

const SELF_SUBCOMMANDS = [
  "namespace",
  "doctor",
  "update",
  "install-skill",
  "install-plugin-skills",
  "install-plugin-skills-git",
  "uninstall-skill",
  "mcp",
  "bootstrap",
] as const;

export const selfCommand: QtcCommand = {
  name: "self",
  describe:
    "Manage the agent-workflow CLI itself (namespace, doctor, update, install-skill, install-plugin-skills, install-plugin-skills-git, uninstall-skill, mcp, bootstrap).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const sub = args.rest[0];
    switch (sub) {
      case "namespace":
        return selfNamespace(ctx);
      case "doctor":
        return selfDoctor(ctx);
      case "update":
        return selfUpdate(args, ctx);
      case "install-skill":
        return selfInstallSkill(args, ctx);
      case "install-plugin-skills":
        return selfInstallPluginSkills(args, ctx);
      case "install-plugin-skills-git":
        return installPluginSkillsFromGit(args, ctx);
      case "uninstall-skill":
        return selfUninstallSkill(args, ctx);
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
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: `unknown self subcommand: '${sub}'. uso: self <${SELF_SUBCOMMANDS.join("|")}>`,
          },
          exitCode: 1,
        };
    }
  },
};
