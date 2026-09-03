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
import type { McpHost } from "../../domain/mcp-entry.js";
import type { CommandResult } from "../../domain/types.js";
import { readMcpConnections } from "../mcp-connections-service.js";
import { runMcpMigration } from "../mcp-migration-service.js";
import { runMcpRemove } from "../mcp-remove-service.js";
import { runMcpSetup } from "../mcp-setup-service.js";
import { runMultiroot } from "../multiroot-service.js";
import { selfCleanLegacy } from "../self/clean-legacy.js";
import { selfInstallHooks } from "../self/install-hooks.js";
import { selfInstallSkill } from "../self/install-skill.js";
import { reinstallSkill } from "../self/skills-manager.js";
import { selfUninstall } from "../self/uninstall.js";
import type { DoctorActionOutcome } from "./apply.js";
import { runDoctorAuthFlow } from "./auth-flow.js";
import type { DoctorBatchAction } from "./prepare.js";

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
    case "skills.reinstall":
      return fromCommand(await reinstallSkill(ctx, action.args.name ?? ""), "reinstalar la skill");
    case "mcp.setup":
      return mcpOutcome(runMcpSetup(ctx.env, mcpInput(ctx, action)), "registrar la entrada MCP");
    case "mcp.remove":
      return mcpOutcome(runMcpRemove(ctx.env, mcpInput(ctx, action)), "retirar la entrada MCP");
    case "mcp.migrate":
      return migrateOutcome(action, ctx);
    case "auth.flow":
      return runDoctorAuthFlow(action, ctx);
    case "multiroot.attach":
    case "multiroot.detach":
      return multirootOutcome(
        await runMultiroot(
          ctx.fs,
          ctx.env,
          ctx.paths,
          action.op === "multiroot.attach" ? "attach" : "detach",
          {
            fromSources: true,
            useGlobal: action.args.scope === "global",
          },
        ),
      );
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

/**
 * El scope global exige su propia autorización, y acá la hay.
 *
 * `globalApproval: "explicit-self-action"` es exactamente lo que este caso es:
 * una persona leyó la vista previa de este lote y aprobó su digest. Sin ese
 * valor `runMcpSetup` se niega a escribir una configuración global, y con razón
 * — tocarla afecta todos los proyectos de la máquina.
 */
function mcpInput(ctx: CliContext, action: DoctorBatchAction) {
  const host = (action.args.host ?? "") as McpHost;
  const instance = action.args.instance ?? "";
  const connections = readMcpConnections(ctx.paths, ctx.env).filter(
    (connection) => connection.name === instance,
  );
  const scope = action.args.scope === "global" ? "global" : "workspace";
  return {
    hosts: [host],
    connections,
    ...(scope === "global"
      ? { scope: "global" as const, globalApproval: "explicit-self-action" as const }
      : { scope: "workspace" as const, workspace: ctx.paths.workspaceDir() }),
  };
}

/**
 * Los servicios de MCP no lanzan: acumulan y devuelven parcial.
 *
 * Así que el resultado se lee de sus listas, no de una excepción. Un conflicto
 * es una entrada ajena homónima que el servicio PRESERVÓ, y eso no es un fallo
 * del doctor sino la protección funcionando: se reporta como fallo de la acción
 * porque el recurso no quedó reparado, con la razón a la vista.
 */
function mcpOutcome(
  result: { applied?: unknown[]; conflicts?: unknown[]; errors?: unknown[] } | { error: string },
  what: string,
): DoctorActionOutcome {
  if ("error" in result) return { status: "failed", detail: `${what}: ${result.error}` };
  const conflicts = result.conflicts?.length ?? 0;
  const errors = result.errors?.length ?? 0;
  if (conflicts > 0) {
    return {
      status: "blocked",
      detail: `${what}: hay una entrada homónima ajena y se preservó`,
    };
  }
  if (errors > 0) return { status: "failed", detail: `${what}: ${errors} error(es) del host` };
  const applied = result.applied?.length ?? 0;
  return applied > 0
    ? { status: "applied", detail: `${what}: aplicado` }
    : { status: "failed", detail: `${what}: el servicio no escribió nada` };
}

/**
 * La migración habla otro idioma: sus pasos son `items` con su propia acción.
 *
 * Y su `apply` es explícito — sin él la corrida es una vista previa. El doctor
 * ya trae la aprobación del digest, así que acá aplica; el `globalApproval` de
 * este servicio es un booleano y no la etiqueta que usa `setup`, otro caso donde
 * dos servicios hermanos no comparten firma y el adaptador es el único lugar que
 * lo sabe.
 */
function migrateOutcome(action: DoctorBatchAction, ctx: CliContext): DoctorActionOutcome {
  const host = (action.args.host ?? "") as McpHost;
  const instance = action.args.instance ?? "";
  const connections = readMcpConnections(ctx.paths, ctx.env).filter(
    (connection) => connection.name === instance,
  );
  const result =
    action.args.scope === "global"
      ? runMcpMigration(ctx.env, {
          scope: "global",
          hosts: [host],
          connections,
          apply: true,
          globalApproval: true,
        })
      : runMcpMigration(ctx.env, {
          scope: "workspace",
          workspace: ctx.paths.workspaceDir(),
          hosts: [host],
          connections,
          apply: true,
        });
  if ("error" in result) return { status: "failed", detail: `migrar: ${String(result.error)}` };
  const blocked = result.items.filter((item) => item.action === "blocked");
  if (blocked.length > 0) {
    return { status: "blocked", detail: "migrar: el servicio declaró el paso bloqueado" };
  }
  const failed = result.items.filter((item) => item.action === "failed");
  if (failed.length > 0)
    return { status: "failed", detail: "migrar: el servicio reportó un fallo" };
  const moved = result.items.filter(
    (item) => item.action === "install" || item.action === "replace-known-legacy",
  );
  return moved.length > 0
    ? { status: "applied", detail: "migrar: aplicado" }
    : { status: "failed", detail: "migrar: no había nada que mover" };
}

function multirootOutcome(result: unknown): DoctorActionOutcome {
  const error =
    result !== null && typeof result === "object" && "error" in result
      ? String((result as { error: unknown }).error)
      : null;
  return error === null
    ? { status: "applied", detail: "visibilidad multiroot: aplicada" }
    : { status: "failed", detail: `visibilidad multiroot: ${error}` };
}
