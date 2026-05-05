import { runPluginDoctor } from "../../application/plugin-doctor-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const pluginDoctorCommand: QtcCommand = {
  name: "plugin-doctor",
  describe: "Health check del plugin (frontmatter, manifests, hooks, MCP, scripts, exports).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: Parameters<typeof runPluginDoctor>[2] = {};
    const root = args.values.get("plugin-root") ?? args.plugin.pluginRoot;
    if (root !== undefined) input.pluginRoot = root;
    const flow = args.plugin.flow;
    if (flow !== undefined) input.flow = flow;
    const pluginVersion = args.plugin.pluginVersion ?? args.values.get("plugin-version");
    if (pluginVersion !== undefined) input.pluginVersion = pluginVersion;
    const pluginName = args.values.get("plugin-name");
    if (pluginName !== undefined) input.pluginName = pluginName;
    const compatRange = args.plugin.compat ?? args.values.get("compat-range");
    if (compatRange !== undefined) input.compatRange = compatRange;
    const exportsFile = args.values.get("exports-file");
    if (exportsFile !== undefined) input.exportsFile = exportsFile;
    const expected = args.values.get("expected-scripts");
    if (expected !== undefined) {
      input.expectedScripts = expected
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    const { data, hasError } = await runPluginDoctor(ctx.fs, ctx.env, input);
    return { ok: true, data, exitCode: hasError ? 1 : 0 };
  },
};
