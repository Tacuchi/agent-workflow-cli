import type { ParsedArgs } from "../../cli/parser.js";
/**
 * El adaptador entre una acción del lote y la función que YA sabe escribir.
 *
 * Cada operación del catálogo nombra un delegado, y los delegados no comparten
 * firma: unos esperan `(args, ctx)` porque nacieron como comandos, otros
 * `(env, input)` porque nacieron como servicios. Este archivo es el único lugar
 * donde esa diferencia se resuelve, y existe para que no haya un segundo lugar:
 * dos formas de invocar la misma reparación terminan discrepando en un flag y
 * entonces el doctor arregla algo distinto de lo que el comando especializado
 * arregla.
 *
 * El `ParsedArgs` se construye CAMPO POR CAMPO. El `verb` del catálogo existe
 * para mostrar; ejecutar una reparación pasando su texto a un shell sería una
 * inyección esperando el nombre de recurso equivocado, y los nombres de este
 * informe salen de archivos que escribió otra persona.
 */
import type { CliContext } from "../../cli/types.js";
import type { InstallTarget } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import { runMultiroot } from "../multiroot-service.js";
import { selfCleanLegacy } from "../self/clean-legacy.js";
import { selfInstallHooks } from "../self/install-hooks.js";
import { selfInstallSkill } from "../self/install-skill.js";
import { selfUninstall } from "../self/uninstall.js";
import type { DoctorActionOutcome } from "./apply.js";
import type { DoctorBatchAction } from "./prepare.js";
import { applyRetiredSectionRemoval } from "./provider-hub-block.js";

/** Un `ParsedArgs` explícito: sin comando, sin positional y con los flags que la operación pide. */
function argsOf(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

/** Un `CommandResult` se traduce por su `ok` y su `exitCode`, nunca por su prosa. */
function fromCommand(result: CommandResult<unknown>, what: string): DoctorActionOutcome {
  if (result.ok) return { status: "applied", detail: `${what}: aplicado` };
  const code = result.error?.code ?? "sin código";
  // `blocked` es el estado que `install-hooks` usa cuando una entrada inválida
  // de la persona desarmaría la sección: no es un fallo del doctor, es una
  // negativa deliberada de la operación, y se respeta como tal.
  const blocked = code === "HOOKS_BLOCKED" || code.endsWith("_BLOCKED");
  return {
    status: blocked ? "blocked" : "failed",
    detail: `${what}: ${code}`,
  };
}

export async function runDoctorRepair(
  action: DoctorBatchAction,
  ctx: CliContext,
): Promise<DoctorActionOutcome> {
  switch (action.op) {
    case "self.install-skill":
      return fromCommand(
        await selfInstallSkill(argsOf({ target: target(action) }), ctx),
        "instalar el bundle",
      );
    case "self.uninstall":
      return fromCommand(
        await selfUninstall(argsOf({ target: target(action) }), ctx),
        "retirar la configuración residual",
      );
    case "self.install-hooks":
      return fromCommand(
        await selfInstallHooks(argsOf({ target: target(action) }), ctx),
        "armar los hooks",
      );
    case "self.clean-legacy":
      return fromCommand(
        await selfCleanLegacy(argsOf({ target: target(action) }), ctx),
        "limpiar el resto legacy",
      );
    case "multiroot.attach":
    case "multiroot.detach":
      return repairMultiroot(action, ctx);
    case "hub.remove-retired-section": {
      const path = action.locator;
      if (
        path === null ||
        !["CLAUDE.md", "AGENTS.md"].some((file) => path === `${ctx.paths.hubDir()}/${file}`)
      )
        return { status: "failed", detail: "archivo de proyecto fuera del hub" };
      const removed = await applyRetiredSectionRemoval(ctx.fs, path, ctx.paths.blockMarkers());
      return {
        status: removed ? "applied" : "failed",
        detail: removed ? "secciones retiradas quitadas" : "sin secciones retiradas",
      };
    }
    default:
      // Una operación que el catálogo declara y este adaptador no sabe correr es
      // un fallo declarado, no un `applied` optimista: el recurso queda como
      // estaba y la recomprobación lo va a confirmar.
      return { status: "failed", detail: `no hay adaptador para la operación '${action.op}'` };
  }
}

function target(action: DoctorBatchAction): InstallTarget {
  return (action.args.target ?? "") as InstallTarget;
}

function multirootOutcome(result: unknown): DoctorActionOutcome {
  const error =
    result !== null && typeof result === "object" && "error" in result
      ? String((result as { error: unknown }).error)
      : null;
  return error === null
    ? { status: "applied", detail: "visibilidad multiroot: aplicada" }
    : {
        status: "failed",
        detail: `visibilidad multiroot: ${error}${result && typeof result === "object" && "hint" in result ? ` — ${String(result.hint)}` : ""}`,
      };
}

async function repairMultiroot(
  action: DoctorBatchAction,
  ctx: CliContext,
): Promise<DoctorActionOutcome> {
  if (!action.args.paths || !["claude", "codex"].includes(action.args.host ?? ""))
    return { status: "failed", detail: "propuesta de rutas sin host ni rutas selladas" };
  let exact: unknown;
  try {
    exact = JSON.parse(action.args.paths);
  } catch {
    return { status: "failed", detail: "lista de rutas selladas ilegible" };
  }
  if (
    !Array.isArray(exact) ||
    exact.length === 0 ||
    !exact.every((value) => typeof value === "string" && value.startsWith("/"))
  )
    return { status: "failed", detail: "lista de rutas selladas inválida" };
  return multirootOutcome(
    await runMultiroot(
      ctx.fs,
      ctx.env,
      ctx.paths,
      action.op === "multiroot.attach" ? "attach" : "detach",
      {
        paths: exact as string[],
        useGlobal: action.args.scope === "global",
        skipClaude: action.args.host !== "claude",
        skipCodex: action.args.host !== "codex",
        skipWarp: true,
        skipOz: true,
      },
    ),
  );
}
