import { selfBootstrap } from "../../application/self/bootstrap.js";
import { selfCleanLegacy } from "../../application/self/clean-legacy.js";
import { selfDetectHosts } from "../../application/self/detect-hosts.js";
import { selfDoctor } from "../../application/self/doctor-self.js";
import { selfInstallHooks } from "../../application/self/install-hooks.js";
import { selfInstallSkill } from "../../application/self/install-skill.js";
import { selfMcpConfig } from "../../application/self/mcp-config.js";
import { selfNamespace, selfNamespacePin } from "../../application/self/namespace-info.js";
import { selfUninstallSkill } from "../../application/self/uninstall-skill.js";
import { selfUninstall } from "../../application/self/uninstall.js";
import { selfUpdate } from "../../application/self/update-self.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
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
  "uninstall",
  "uninstall-skill",
  "clean-legacy",
  "mcp",
  "bootstrap",
] as const;

const INSTALL_SKILL_FLAGS = [
  "target",
  "from",
  "force",
  "dry-run",
  "confirm-all",
  "keep-legacy",
  "no-commands",
  "no-hooks",
  "skill-only",
];

const INSTALL_SKILL_HELP = {
  target: { value: "<host|all>", effect: "Host to install into, or all hosts." },
  from: { value: "<path>", effect: "Skill source directory instead of the bundled one." },
  force: { effect: "Overwrite destinations that already exist." },
  "dry-run": { effect: "Report what would be installed without writing." },
  "confirm-all": { effect: "Acknowledge that --target all writes into every host." },
  "keep-legacy": { effect: "Keep legacy artifacts instead of cleaning them." },
  "no-commands": { effect: "Skip installing the commands." },
  "no-hooks": { effect: "Skip installing the hooks." },
  "skill-only": { effect: "Install only the skill: implies --no-commands and --no-hooks." },
};

const INSTALL_SKILL_OUTPUT =
  "{status (installed|dry-run|partial), source, source_kind (path|bundled), dests[]}.";

export const selfCommand: CliCommand = {
  name: "self",
  flags: {
    known: [],
    actions: {
      // SessionStart runs `self namespace --pin`: a hook, so it warns and runs.
      namespace: { known: ["pin"], mode: "warn" },
      doctor: { known: [] },
      "detect-hosts": { known: [] },
      update: { known: ["dry-run", "yes", "y"] },
      install: { known: INSTALL_SKILL_FLAGS, required: ["target"] },
      "install-skill": { known: INSTALL_SKILL_FLAGS, required: ["target"] },
      "install-hooks": { known: ["target", "template", "dry-run"], required: ["target"] },
      uninstall: {
        known: ["target", "legacy", "no-commands", "skill-only", "with-hooks", "dry-run"],
      },
      "uninstall-skill": { known: ["target", "legacy", "dry-run"] },
      "clean-legacy": { known: ["target", "dry-run"] },
      mcp: {
        known: ["action", "name", "instance", "var", "dsn-var", "dry-run"],
        repeatable: ["var"],
      },
      bootstrap: { known: ["dry-run"] },
    },
  },
  help: {
    purpose:
      "Manage the agent-workflow CLI itself: namespace, installation per host, hooks, MCP and updates.",
    notes: [
      "Without an action, `aw self` returns {subcommands[], help_hint}. install is an alias of install-skill.",
    ],
    actions: {
      namespace: {
        purpose:
          "Print the active namespace and where it was resolved from, or pin one for this user (SessionStart hook runs it).",
        flags: {
          pin: {
            value: "<name>",
            effect: "Persist this namespace to ~/.config/agent-workflow/namespace.",
          },
        },
        output: "{namespace, source}; with --pin: {pinned, path}.",
      },
      doctor: {
        purpose:
          "Report the CLI version, namespace, runtime paths and where the skill is installed per host.",
        flags: {},
        output:
          "{cli_version, namespace {value, source}, paths {user_root, cwd_root, runtime_json}, runtime {package_name, bin_name, source, config_path?, display_name?}, skill {installed, targets[]}}. Read-only.",
      },
      "detect-hosts": {
        purpose:
          "Detect which supported hosts exist on this machine and which carry an installation.",
        flags: {},
        output:
          "{hosts[], shared_destinations[], detected_count, installed_count, residual_count, summary}. Read-only.",
      },
      update: {
        purpose:
          "Install the latest published CLI version globally through npm, showing its contract changes first.",
        flags: {
          "dry-run": { effect: "Show the npm command and the target version without running it." },
          yes: { effect: "Skip the interactive confirmation." },
          y: { effect: "Alias of --yes." },
        },
        output:
          "{command, exit_code, stdout, stderr, target_version, contract_changes, would_run?}.",
        exit_codes: { "2": "npm itself exited with code 2; its output is in data." },
        notes: [
          "The installed version is the one the notice described, never a moving latest tag.",
        ],
      },
      install: {
        purpose:
          "Alias of install-skill: install the Workline skill, commands and hooks into a host.",
        flags: INSTALL_SKILL_HELP,
        output: INSTALL_SKILL_OUTPUT,
      },
      "install-skill": {
        purpose:
          "Install the Workline skill, its commands and its hooks into one host or every host.",
        flags: INSTALL_SKILL_HELP,
        output: INSTALL_SKILL_OUTPUT,
        notes: [
          "--target all reaches every host but not the shared skills directories (install those with an explicit --target) and requires --confirm-all unless --dry-run. An existing destination is refused without --force.",
        ],
      },
      "install-hooks": {
        purpose: "Merge the Workline lifecycle hooks into one host's configuration.",
        flags: {
          target: { value: "<host>", effect: "Host whose hooks configuration to update." },
          template: {
            value: "<path>",
            effect: "Hooks template to install instead of the bundled hooks.template.json.",
          },
          "dry-run": { effect: "Report what would be installed without writing." },
        },
        output:
          "{status (installed|dry-run|noop|unsupported|blocked|generated|retired), target, config_path, events_installed[], events_already_present[], backup_path, warning?}.",
        notes: [
          "blocked means nothing was written because the host would reject an entry and discard the whole section; generated means an artifact was written that only the person can arm.",
        ],
      },
      uninstall: {
        purpose:
          "Remove what install placed in one host or every host: skill, commands and, on request, hooks.",
        flags: {
          target: { value: "<host|all>", effect: "Host to uninstall from; defaults to all." },
          legacy: { effect: "Also remove legacy command files." },
          "no-commands": { effect: "Keep the commands." },
          "skill-only": { effect: "Remove only the skill; keeps commands and hooks." },
          "with-hooks": { effect: "Also remove the Workline hooks from the host configuration." },
          "dry-run": { effect: "Report what would be removed without deleting." },
        },
        output:
          "{status (removed|dry-run|noop|partial), steps[], lock_updated, lock_path?, lock_warning?, untouched_note?}.",
      },
      "uninstall-skill": {
        purpose: "Remove only the installed skill directories from one host or every host.",
        flags: {
          target: {
            value: "<host|all>",
            effect: "Host to remove the skill from; defaults to all.",
          },
          legacy: { effect: "Also remove skills installed under legacy names." },
          "dry-run": { effect: "Report what would be removed without deleting." },
        },
        output:
          "{status (removed|dry-run|noop|partial), removed[], lock_updated, lock_path?, lock_warning?}.",
      },
      "clean-legacy": {
        purpose:
          "Delete skills left over from pre-v3 installs in every directory a host reads skills from.",
        flags: {
          target: {
            value: "<host|all>",
            effect: "Host whose skill directories to scan; defaults to all.",
          },
          "dry-run": { effect: "Report what would be removed without deleting." },
        },
        output:
          "{status (removed|dry-run|noop), removed[], prefixes_used[], scanned_dirs[], summary}.",
      },
      mcp: {
        purpose: "Register, install, diagnose or remove the Workline PostgreSQL MCP connections.",
        flags: {
          action: {
            value: "<list|use-env|create-env|doctor|remove|cancel|install-<host>>",
            effect:
              "Operation to run; also accepted as the second positional. Without it an interactive menu asks.",
          },
          name: {
            value: "<name>",
            effect: "Connection name (kebab-case slug); asked for when absent.",
          },
          instance: { value: "<name>", effect: "Alias of --name." },
          var: { value: "<VAR>", effect: "Alias of --dsn-var." },
          "dsn-var": {
            value: "<VAR>",
            effect:
              "Environment variable (UPPER_SNAKE_CASE) holding the connection DSN; asked for when absent.",
          },
          "dry-run": { effect: "Report the setup or removal without writing." },
        },
        output:
          "{action, connection, installed?, connections[]?, table?, registry? {path, changed}, registry_error?, setup?, remove?, preserved_foreign[]?, doctor?, env_help?, summary}.",
        exit_codes: {
          "2": "The local MCP registry is invalid and needs repair, or a global install was refused without force.",
        },
      },
      bootstrap: {
        purpose:
          "Run doctor, remove legacy leftovers and install the skill in one pass, then list the next steps.",
        flags: { "dry-run": { effect: "Run every step as a preview without writing." } },
        output: "{steps[] ({name, status, message?, data?}), next_steps[], summary}.",
        notes: ["Stops at the first failing step and returns exit 1 with the steps run so far."],
      },
    },
  },
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
      case "uninstall":
        return selfUninstall(args, ctx);
      case "uninstall-skill":
        return selfUninstallSkill(args, ctx);
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
