import { type HubInitFuente, runHubInit } from "../../application/hub-init-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const hubInitCommand: QtcCommand = {
  name: "hub-init",
  describe:
    "Bootstrap atómico de hub workspace: persiste QTC-PROJECT (mode=hub) + attach-multiroot. Flags: --proyecto, --fuente alias:path (repetible, mín 2), --working-branch alias:rama (repetible), [--main-branch], [--workspace], [--skip-attach], [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const proyecto = args.values.get("proyecto");
    if (proyecto === undefined || proyecto.trim().length === 0) {
      return invalid("--proyecto es obligatorio");
    }

    const fuentesRaw = args.valuesMulti.get("fuente") ?? [];
    const fuentes = parseFuentes(fuentesRaw);
    if ("error" in fuentes) return invalid(fuentes.error);

    const workingBranches = parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []);
    const mainBranch = args.values.get("main-branch");
    const workspace = args.values.get("workspace");

    const data = await runHubInit(ctx.fs, ctx.env, ctx.paths, {
      proyecto,
      fuentes: fuentes.value,
      workingBranches,
      ...(mainBranch !== undefined ? { mainBranch } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      skipAttach: args.flags.has("--skip-attach"),
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

function parseFuentes(specs: string[]): { value: HubInitFuente[] } | { error: string } {
  if (specs.length < 2) {
    return { error: "hub-init requiere mínimo 2 --fuente alias:path" };
  }
  const out: HubInitFuente[] = [];
  for (const raw of specs) {
    const trimmed = raw.trim();
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      return {
        error: `--fuente formato inválido '${raw}': se esperaba 'alias:path[:rama]'`,
      };
    }
    const alias = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1);
    const lastColon = rest.lastIndexOf(":");
    const path = lastColon < 0 ? rest.trim() : rest.slice(0, lastColon).trim();
    if (!alias || !path) {
      return {
        error: `--fuente formato inválido '${raw}': alias y path son obligatorios`,
      };
    }
    out.push({ alias, path });
  }
  return { value: out };
}

function parseWorkingBranches(specs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of specs) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const alias = raw.slice(0, idx).trim();
    const branch = raw.slice(idx + 1).trim();
    if (alias && branch) out[alias] = branch;
  }
  return out;
}

function invalid(message: string): CommandResult {
  return {
    ok: false,
    error: { code: "INVALID_INPUT", message },
    exitCode: 1,
  };
}
