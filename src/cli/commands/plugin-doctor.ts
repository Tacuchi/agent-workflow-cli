import {
  type PluginDoctorInput,
  runPluginDoctor,
} from "../../application/plugin-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const pluginDoctorCommand: CliCommand = {
  name: "plugin-doctor",
  flags: {
    known: ["plugin-root", "plugin-version", "plugin-name", "compat-range", "exports-file"],
  },
  help: {
    purpose:
      "Check one plugin package only (frontmatter, manifests, hooks, MCP, exports); for the whole installation use aw doctor.",
    flags: {
      "plugin-root": { value: "<path>", effect: "Plugin directory to check." },
      "plugin-version": { value: "<semver>", effect: "Version the plugin is expected to carry." },
      "plugin-name": { value: "<name>", effect: "Name the plugin is expected to carry." },
      "compat-range": { value: "<range>", effect: "CLI version range the plugin declares." },
      "exports-file": { value: "<file>", effect: "Exports manifest to check the skills against." },
    },
    output:
      "{status (ok|warn|error), plugin, plugin_root, plugin_version, compat_range, skills_count, readme_count_expected, readme_count_match, manifests, hooks, mcp, skills[], exported_skills[], findings[]}.",
    exit_codes: {
      "1": "At least one finding is an error; ok is still true and data is the full report.",
    },
    notes: ["Read-only."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: PluginDoctorInput = {};
    const root = args.values.get("plugin-root") ?? args.plugin.pluginRoot;
    if (root !== undefined) input.pluginRoot = root;
    const pluginVersion = args.plugin.pluginVersion ?? args.values.get("plugin-version");
    if (pluginVersion !== undefined) input.pluginVersion = pluginVersion;
    const pluginName = args.values.get("plugin-name");
    if (pluginName !== undefined) input.pluginName = pluginName;
    const compatRange = args.plugin.compat ?? args.values.get("compat-range");
    if (compatRange !== undefined) input.compatRange = compatRange;
    const exportsFile = args.values.get("exports-file");
    if (exportsFile !== undefined) input.exportsFile = exportsFile;

    const { data, hasError } = await runPluginDoctor(
      ctx.fs,
      ctx.env,
      ctx.paths,
      ctx.runtime,
      input,
    );
    return { ok: true, data, exitCode: hasError ? 1 : 0 };
  },
};
