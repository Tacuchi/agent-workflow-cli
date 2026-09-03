import { describe, expect, it } from "vitest";
import { NodeProcess } from "../../src/adapters/node-process.js";

const proc = new NodeProcess();

/**
 * `runInteractive`: el único método del puerto que NO captura nada.
 *
 * Existe para un solo llamador —el flujo de autenticación declarado del
 * doctor— y su contrato es lo que sostiene la custodia del secreto: la
 * terminal se hereda, así que lo que la persona escribe va del teclado al
 * programa sin pasar por este proceso, y el resultado no tiene dónde traerlo
 * de vuelta. Por eso lo que se fija acá es tanto lo que devuelve como lo que
 * NO devuelve.
 */
describe("NodeProcess — la corrida que hereda la terminal", () => {
  it("devuelve SÓLO el código de salida: no hay stdout ni stderr donde caiga un secreto", async () => {
    // El defecto que atrapa: agregar `stdout` al resultado «para poder
    // diagnosticar» pondría en un buffer nuestro exactamente lo que la persona
    // tipeó. La forma del resultado es la garantía, así que se compara la lista
    // de claves entera y no una por una.
    const result = await proc.runInteractive(process.execPath, ["--no-warnings", "-e", ""]);

    expect(Object.keys(result)).toEqual(["code"]);
    expect(result.code).toBe(0);
  });

  it("relaya el código del hijo tal cual", async () => {
    const result = await proc.runInteractive(process.execPath, [
      "--no-warnings",
      "-e",
      "process.exit(3);",
    ]);

    expect(result.code).toBe(3);
  });

  it("un binario que no existe RESUELVE con 127 en vez de lanzar", async () => {
    // El llamador traduce el código a un desenlace que una persona lee. Si esto
    // rechazara, un programa ausente y un flujo que la persona canceló darían
    // dos caminos distintos para la misma respuesta, y el `catch` que hiciera
    // falta terminaría siendo el único lugar que decide.
    const result = await proc.runInteractive("no-existe-este-binario-de-workline", []);

    expect(result.code).toBe(127);
  });

  it("sin terminal, `hasTty` dice que no: falla CERRADA", () => {
    // Corriendo bajo el runner no hay TTY en ninguno de los dos extremos, así
    // que esta es la respuesta real del adaptador en un entorno sin terminal —
    // que es el caso donde el flujo tiene que quedar bloqueado y no correr.
    expect(process.stdin.isTTY === true && process.stdout.isTTY === true).toBe(false);
    expect(proc.hasTty()).toBe(false);
  });

  it("hacen falta LOS DOS extremos: con uno solo sigue diciendo que no", () => {
    // El defecto que atrapa: un `||` en vez de un `&&` sobrevivía a toda la
    // suite, porque bajo el runner los dos extremos son falsos y las dos
    // expresiones dan lo mismo. Un hijo que pide una contraseña necesita stdin
    // para leerla Y stdout para mostrar el prompt: con un pipe en cualquiera de
    // los dos lados, el flujo se cuelga en un prompt invisible, que es peor que
    // negarse.
    const stdin = process.stdin.isTTY;
    const stdout = process.stdout.isTTY;
    try {
      (process.stdout as { isTTY?: boolean }).isTTY = true;
      (process.stdin as { isTTY?: boolean }).isTTY = false;
      expect(proc.hasTty()).toBe(false);

      (process.stdout as { isTTY?: boolean }).isTTY = false;
      (process.stdin as { isTTY?: boolean }).isTTY = true;
      expect(proc.hasTty()).toBe(false);

      // Y con los dos, sí.
      (process.stdout as { isTTY?: boolean }).isTTY = true;
      expect(proc.hasTty()).toBe(true);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = stdin;
      (process.stdout as { isTTY?: boolean }).isTTY = stdout;
    }
  });
});
