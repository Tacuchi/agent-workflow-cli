import { type HubInitFuente, runHubInit } from "../../application/hub-init-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import { type FuenteSpec, parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const hubInitCommand: QtcCommand = {
  name: "hub-init",
  describe:
    "Escribe el bloque <NS>-PROJECT (mode=hub) con N fuentes y SIEMPRE configura la visibilidad multi-root (settings.local.json + config.toml, gitignored), reconciliando fuentes agregadas/removidas. Flags: --proyecto, --fuente alias:path (repetible, mín 2), --working-branch alias:rama (repetible), [--main-branch], [--workspace], [--dry-run]. La forma interactiva vive en el TUI (tab Project → Initialize as hub).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const proyecto = args.values.get("proyecto");
    if (proyecto === undefined || proyecto.trim().length === 0) {
      return invalid("--proyecto es obligatorio");
    }

    const fuentesRaw = args.valuesMulti.get("fuente") ?? [];
    if (fuentesRaw.length < 2) {
      return invalid("hub-init requiere mínimo 2 --fuente alias:path");
    }
    const fuentesParsed = parseFuentesSpecs(fuentesRaw);
    if ("error" in fuentesParsed) return invalid(fuentesParsed.error);
    const fuentes = fuentesParsed.fuentes.map(toHubInitFuente);

    const workingBranches =
      parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []) ?? {};
    const mainBranch = args.values.get("main-branch");
    const workspace = args.values.get("workspace");

    const data = await runHubInit(ctx.fs, ctx.env, ctx.paths, {
      proyecto,
      fuentes,
      workingBranches,
      ...(mainBranch !== undefined ? { mainBranch } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      dryRun: args.flags.has("--dry-run"),
    });

    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.hint ?? data.error },
        data,
        exitCode: 1,
      };
    }

    return {
      ok: data.ok,
      data,
      ...(data.ok
        ? {}
        : {
            error: {
              code: "HUB_INIT_FAILED",
              message:
                "hub-init no completó exitosamente; revisar data.project_md y data.attach_multiroot",
            },
          }),
      exitCode: data.ok ? 0 : 1,
    };
  },
};

function toHubInitFuente(spec: FuenteSpec): HubInitFuente {
  return { alias: spec.alias, path: spec.path };
}

function invalid(message: string): CommandResult {
  return {
    ok: false,
    error: { code: "INVALID_INPUT", message },
    exitCode: 1,
  };
}
