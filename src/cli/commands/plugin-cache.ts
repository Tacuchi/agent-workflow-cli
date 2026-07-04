import { selfClearPluginCache } from "../../application/self/plugin-cache-clear.js";
import { selfReloadPluginCache } from "../../application/self/plugin-cache-reload.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const pluginCacheCommand: QtcCommand = {
  name: "plugin-cache",
  describe:
    "Limpia o recarga el cache de un plugin instalado en un host. Subcomandos: clear, reload. Flags: --plugin <ns> --target <claude|codex|warp|agents> [--from <path>] [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return fail("INVALID_INPUT", "plugin-cache requiere un subcomando: clear | reload");
    }
    if (subcommand === "clear") {
      return await selfClearPluginCache(args, ctx);
    }
    if (subcommand === "reload") {
      return await selfReloadPluginCache(args, ctx);
    }
    return fail(
      "INVALID_INPUT",
      `plugin-cache: subcomando desconocido '${subcommand}'. Usá: clear | reload`,
    );
  },
};
