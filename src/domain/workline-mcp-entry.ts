/**
 * La entrada histórica con la que un host ofrecía el servidor de elicitation.
 *
 * Se conserva para reconocer esa forma con exactitud. La instalación de skills no
 * vuelve a escribirla: un descriptor MCP global requiere una acción explícita.
 *
 * El comando es el propio binario del CLI, con el envoltorio de Windows que
 * `buildMcpEntry` ya resolvió para el servidor de base de datos: allá el bin global es un
 * `.cmd`, y un host que lo lanza sin shell falla con ENOENT. Repetir el criterio
 * es reusar una decisión ya probada, no copiar código.
 */

import type { McpEntry } from "./mcp-entry.js";

/**
 * El nombre de la entrada.
 *
 * Distinto de cualquier conexión que la persona registre —esas se nombran por su
 * instancia— para que la retirada pueda quitar exactamente la nuestra sin rozar
 * las ajenas.
 */
export const WORKLINE_MCP_ENTRY_NAME = "agent-workflow";

/**
 * El host viajaba en los argumentos porque el servidor no podía detectarlo desde
 * adentro. Esta forma existe sólo como firma de una configuración legacy.
 */
export function worklineMcpEntry(host: string, platform: string = process.platform): McpEntry {
  const isWin = platform === "win32";
  const serve = ["mcp", "serve", "--host", host];
  return {
    name: WORKLINE_MCP_ENTRY_NAME,
    command: isWin ? "cmd" : "agent-workflow",
    args: isWin ? ["/c", "agent-workflow", ...serve] : serve,
    env: {},
  };
}
