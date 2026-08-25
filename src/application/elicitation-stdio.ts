/**
 * El servidor de elicitation, atado a una entrada y una salida reales.
 *
 * Separado del servidor por la misma razón por la que el lanzador de dbhub separa
 * banner de protocolo: **la salida estándar ES el canal JSON-RPC**, y una sola
 * línea de diagnóstico ahí corrompe la sesión de cualquier cliente MCP. Acá viven
 * el troceado por líneas y esa regla; la lógica no sabe de transporte y por eso se
 * puede manejar desde una prueba con un cliente falso.
 */

import { createElicitationServer } from "./elicitation-server.js";

export interface StdioDeps {
  input: NodeJS.ReadableStream;
  /** El canal de protocolo. */
  output: NodeJS.WritableStream;
  /** Diagnóstico. NUNCA la salida estándar. */
  diagnostics: NodeJS.WritableStream;
  now?: () => number;
}

/**
 * Corre hasta que la entrada se cierra, que es como un host termina a su servidor.
 *
 * Una línea que no parsea se reporta por diagnóstico y se descarta: cortar la
 * sesión entera por un mensaje suelto dejaría al host sin servidor por un byte.
 */
export function runElicitationStdio(deps: StdioDeps): Promise<void> {
  const server = createElicitationServer({
    send: (message) => deps.output.write(`${JSON.stringify(message)}\n`),
    now: deps.now ?? (() => Date.now()),
  });

  /** Un mensaje suelto: cortar la sesión por un byte dejaría al host sin servidor. */
  function feed(line: string): void {
    try {
      server.handle(JSON.parse(line));
    } catch (error) {
      deps.diagnostics.write(
        `aw mcp serve: línea ilegible descartada: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  let buffer = "";
  return new Promise((resolve) => {
    deps.input.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const complete = buffer.split("\n");
      // La última porción queda sin `\n`: es una línea a medio llegar, no un mensaje.
      buffer = complete.pop() ?? "";
      for (const line of complete) {
        const trimmed = line.trim();
        if (trimmed.length > 0) feed(trimmed);
      }
    });
    deps.input.on("end", () => resolve());
    deps.input.on("close", () => resolve());
  });
}
