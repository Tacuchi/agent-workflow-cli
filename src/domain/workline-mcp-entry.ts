/**
 * La entrada con la que un host ofrece el servidor propio de Workline.
 *
 * Se construye acá y no en cada sitio que la necesita porque la instalación, la
 * retirada y la observación tienen que hablar de LA MISMA entrada: si el nombre o
 * el comando difirieran entre ellas, instalar dejaría una que retirar no encuentra
 * y observar informaría sobre otra.
 *
 * El comando es el propio binario del CLI, con el envoltorio de Windows que
 * `buildMcpEntry` ya resolvió para el lanzador de dbhub: allá el bin global es un
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
 * El host viaja en los argumentos porque el servidor no puede detectarlo desde
 * adentro: lo lanza el host por entrada y salida estándar, sin variable que lo
 * identifique. Y sin saber en cuál corre no podría nombrar la política que le
 * anula el selector ni la forma de arrancar que lo recupera.
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
