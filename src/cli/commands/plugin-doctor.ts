import {
  type PluginDoctorInput,
  runPluginDoctor,
} from "../../application/plugin-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const pluginDoctorCommand: QtcCommand = {
  name: "plugin-doctor",
  describe:
    "Health check del plugin (frontmatter, manifests, hooks, MCP, exports). " +
    "Usage: aw plugin-doctor [--plugin-root <path>] [--plugin-name <name>] " +
    "[--plugin-version <semver>] [--compat-range <range>] [--exports-file <file>].",
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
