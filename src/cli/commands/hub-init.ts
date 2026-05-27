import { basename } from "node:path";
import { type HubInitFuente, runHubInit } from "../../application/hub-init-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { EnvPort } from "../../ports/env.js";
import type { ParsedArgs } from "../parser.js";
import { type FuenteSpec, parseFuentesSpecs } from "../parsers/fuentes.js";
import { parseWorkingBranches } from "../parsers/working-branches.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

const DEFAULT_MAIN_BRANCH = "certificacion";

export const hubInitCommand: QtcCommand = {
  name: "hub-init",
  describe:
    "Bootstrap atómico de hub workspace: persiste <NS>-PROJECT (mode=hub) + attach-multiroot. Omitir --proyecto en un TTY abre un wizard interactivo (proyecto + fuentes + rama). Flags: --proyecto, --fuente alias:path (repetible, mín 2), --working-branch alias:rama (repetible), [--main-branch], [--workspace], [--skip-attach], [--dry-run].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const resolved = await resolveInputs(args, ctx);
    if ("error" in resolved) return invalid(resolved.error);
    const { proyecto, fuentes, mainBranch } = resolved;

    const workingBranches =
      parseWorkingBranches(args.valuesMulti.get("working-branch") ?? []) ?? {};
    const workspace = args.values.get("workspace");

    const data = await runHubInit(ctx.fs, ctx.env, ctx.paths, {
      proyecto,
      fuentes,
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

interface ResolvedInputs {
  proyecto: string;
  fuentes: HubInitFuente[];
  mainBranch?: string;
}

/**
 * Resuelve proyecto + fuentes desde flags. Si falta --proyecto y hay TTY, abre
 * el wizard interactivo en lugar de fallar (la opción "Initialize as hub" del
 * TUI llega acá sin args). Sin TTY mantiene el error explícito para scripts.
 */
async function resolveInputs(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<ResolvedInputs | { error: string }> {
  const proyecto = args.values.get("proyecto");
  const mainBranchArg = args.values.get("main-branch");

  if (proyecto === undefined || proyecto.trim().length === 0) {
    if (!isInteractive()) return { error: "--proyecto es obligatorio" };
    const wizard = await collectHubInitInteractive(await loadHubInitPrompts(), ctx.env);
    return {
      proyecto: wizard.proyecto,
      fuentes: wizard.fuentes,
      mainBranch: mainBranchArg ?? wizard.mainBranch,
    };
  }

  const fuentesRaw = args.valuesMulti.get("fuente") ?? [];
  if (fuentesRaw.length < 2) return { error: "hub-init requiere mínimo 2 --fuente alias:path" };
  const fuentesParsed = parseFuentesSpecs(fuentesRaw);
  if ("error" in fuentesParsed) return { error: fuentesParsed.error };
  return {
    proyecto,
    fuentes: fuentesParsed.fuentes.map(toHubInitFuente),
    ...(mainBranchArg !== undefined ? { mainBranch: mainBranchArg } : {}),
  };
}

// ---------- Wizard interactivo ----------

export interface HubInitPrompts {
  input(opts: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string;
  }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

export interface HubInitWizardResult {
  proyecto: string;
  fuentes: HubInitFuente[];
  mainBranch: string;
}

/**
 * Recolecta proyecto + fuentes + rama base por prompts. El alias de cada fuente
 * se infiere del nombre de su carpeta (basename del path) y no se pregunta. Pide
 * paths hasta tener ≥2 fuentes y recién entonces ofrece agregar más.
 */
export async function collectHubInitInteractive(
  prompts: HubInitPrompts,
  env: EnvPort,
): Promise<HubInitWizardResult> {
  const proyecto = await prompts.input({
    message: "Nombre del proyecto",
    default: basename(env.cwd()),
    validate: nonEmpty("El nombre no puede estar vacío"),
  });

  const fuentes: HubInitFuente[] = [];
  const aliases = new Set<string>();
  for (;;) {
    const path = (
      await prompts.input({
        message: `Fuente #${fuentes.length + 1} · path`,
        validate: nonEmpty("El path no puede estar vacío"),
      })
    ).trim();
    fuentes.push({ alias: dedupeAlias(deriveAlias(path), aliases), path });
    if (fuentes.length >= 2) {
      const more = await prompts.confirm({ message: "¿Agregar otra fuente?", default: false });
      if (!more) break;
    }
  }

  const mainBranch = await prompts.input({
    message: "Rama base",
    default: DEFAULT_MAIN_BRANCH,
    validate: nonEmpty("La rama no puede estar vacía"),
  });

  return { proyecto: proyecto.trim(), fuentes, mainBranch: mainBranch.trim() };
}

/** Alias = nombre de la carpeta del path (tal cual), sin barras finales. */
function deriveAlias(path: string): string {
  return basename(path.replace(/[/\\]+$/, "")) || path;
}

/** Sufija -2, -3, … si dos fuentes comparten nombre de carpeta. */
function dedupeAlias(alias: string, seen: Set<string>): string {
  let candidate = alias;
  let n = 2;
  while (seen.has(candidate)) candidate = `${alias}-${n++}`;
  seen.add(candidate);
  return candidate;
}

function nonEmpty(message: string): (value: string) => boolean | string {
  return (value) => value.trim().length > 0 || message;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function loadHubInitPrompts(): Promise<HubInitPrompts> {
  const prompts = await import("@inquirer/prompts");
  return { input: prompts.input, confirm: prompts.confirm };
}

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
