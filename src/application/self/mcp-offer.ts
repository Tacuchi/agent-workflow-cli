/**
 * Ofrecer y retirar el servidor propio en los hosts donde se instalan superficies.
 *
 * Por qué la instalación lo deja ofrecido en vez de exigir un comando aparte: ya
 * escribe hooks y envoltorios en esos mismos hosts, así que esto no estrena una
 * clase de efecto — y una vía que hay que activar a mano es una vía que la mayoría
 * no tiene. Lo que sí obliga esa decisión es la simetría: la retirada tiene que
 * quitarlo, y ni una ni otra pueden rozar un servidor que la persona ya tenía.
 *
 * Se ofrece SÓLO donde el catálogo declara la vía disponible con evidencia
 * fechada. Escribirla en un host donde nadie la observó dejaría una entrada que
 * apunta a un selector que quizá no existe, y el estampado de ese host tampoco la
 * nombra: serían dos superficies diciendo cosas distintas.
 */

import { harnessByInstallTarget } from "../../domain/harnesses.js";
import type { InstallTarget } from "../../domain/harnesses.js";
import type { McpHost, McpWriteResult } from "../../domain/mcp-entry.js";
import { WORKLINE_MCP_ENTRY_NAME, worklineMcpEntry } from "../../domain/workline-mcp-entry.js";
import { removeMcpEntry, writeMcpEntry } from "../mcp-host-writer.js";

export interface McpOfferInput {
  targets: readonly InstallTarget[];
  /** Dónde vive la configuración del host. */
  scopeDir: string;
  dryRun?: boolean;
  platform?: string;
}

export interface McpOfferOutcome {
  host: McpHost;
  /** `offered` / `withdrawn` cuando cambió; `unchanged` cuando ya estaba así. */
  state: "offered" | "withdrawn" | "unchanged" | "dry-run" | "conflict" | "failed";
  /** Por qué falló, cuando falló. Nunca se traga el error. */
  error?: string;
}

/** Los hosts de esos destinos que declaran la vía, sin repetir ninguno. */
function hostsWithVia(targets: readonly InstallTarget[]): McpHost[] {
  const hosts = new Set<McpHost>();
  for (const target of targets) {
    const spec = harnessByInstallTarget(target);
    if (spec === null || spec.mcpHostId === null) continue;
    if (!spec.structuredChoice.mcpElicitation.available) continue;
    hosts.add(spec.mcpHostId);
  }
  return [...hosts];
}

/**
 * Deja el servidor ofrecido donde corresponde.
 *
 * No es fatal: un host cuya configuración no se pudo escribir se REPORTA y la
 * instalación sigue. Abortarla entera por una entrada MCP dejaría a la persona sin
 * las superficies que sí pedía, y la vía es una mejora sobre un mecanismo que en
 * el peor caso degrada a markdown, no un requisito para trabajar.
 */
export function offerWorklineServer(input: McpOfferInput): McpOfferOutcome[] {
  return hostsWithVia(input.targets).map((host) => {
    const entry = worklineMcpEntry(host, input.platform);
    try {
      const result = writeMcpEntry(
        host,
        entry,
        { scopeDir: input.scopeDir, kind: "global" },
        { dryRun: input.dryRun === true },
      );
      return { host, state: describe(result, "offered") };
    } catch (error) {
      return { host, state: "failed" as const, error: message(error) };
    }
  });
}

/**
 * Quita exactamente la entrada propia.
 *
 * Recorre TODOS los hosts de los destinos, no sólo los que hoy declaran la vía: si
 * la disponibilidad de un host se retirara del catálogo después de una instalación,
 * mirar sólo los vigentes dejaría su entrada abandonada para siempre.
 */
export function withdrawWorklineServer(input: McpOfferInput): McpOfferOutcome[] {
  const hosts = new Set<McpHost>();
  for (const target of input.targets) {
    const host = harnessByInstallTarget(target)?.mcpHostId ?? null;
    if (host !== null) hosts.add(host);
  }
  return [...hosts].map((host) => {
    const entry = worklineMcpEntry(host, input.platform);
    try {
      const result = removeMcpEntry(
        host,
        entry,
        { scopeDir: input.scopeDir, kind: "global" },
        { dryRun: input.dryRun === true },
      );
      return { host, state: describe(result, "withdrawn") };
    } catch (error) {
      return { host, state: "failed" as const, error: message(error) };
    }
  });
}

export { WORKLINE_MCP_ENTRY_NAME };

/**
 * Qué hizo la escritura, dicho en el vocabulario de esta operación.
 *
 * Un `skipped-idempotent` es una entrada que ya estaba como se quería: informarlo como cambio
 * haría que una reinstalación pareciera haber tocado la configuración de la
 * persona cuando no tocó nada.
 */
function describe(
  result: McpWriteResult,
  changedState: "offered" | "withdrawn",
): McpOfferOutcome["state"] {
  if (result.action === "skipped-idempotent") return "unchanged";
  if (result.action === "dry-run") return "dry-run";
  if (result.action === "conflict") return "conflict";
  return changedState;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
