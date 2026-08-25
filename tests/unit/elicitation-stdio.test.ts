import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TOOL_NAME } from "../../src/application/elicitation-server.js";
import { runElicitationStdio } from "../../src/application/elicitation-stdio.js";
import { CHOICE_KEY } from "../../src/domain/elicitation.js";

/** Lee las líneas que salieron por el canal de protocolo. */
function lines(chunks: string[]): Record<string, unknown>[] {
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("el servidor sobre una entrada y una salida reales", () => {
  it("atraviesa el saludo, la solicitud y la elección, y termina cuando la entrada cierra", async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const err: string[] = [];
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    output.on("data", (c) => out.push(c.toString()));
    diagnostics.on("data", (c) => err.push(c.toString()));

    const done = runElicitationStdio({ input, output, diagnostics, now: () => 5000 });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: TOOL_NAME,
          arguments: {
            questions: [
              {
                header: "Commit",
                question: "¿Aprobás?",
                options: [{ label: "Aprobar", consequence: "un commit por fuente" }],
              },
            ],
          },
        },
      })}\n`,
    );
    await new Promise((r) => setImmediate(r));
    const elicit = lines(out).find((m) => m.method === "elicitation/create");
    expect(elicit).toBeDefined();
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: elicit?.id,
        result: { action: "accept", content: { [CHOICE_KEY]: "Aprobar" } },
      })}\n`,
    );
    input.end();
    await done;

    const call = lines(out).find((m) => m.id === 1);
    const text = (call?.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ outcome: "chosen" });
    // El diagnóstico jamás sale por el canal de protocolo: una sola línea suelta
    // ahí corrompe la sesión de cualquier cliente MCP.
    expect(err.join("")).toBe("");
  });

  it("un mensaje que llega PARTIDO en dos trozos se atiende igual", async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    output.on("data", (c) => out.push(c.toString()));

    const done = runElicitationStdio({ input, output, diagnostics, now: () => 0 });
    const mensaje = `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} })}\n`;
    const corte = Math.floor(mensaje.length / 2);
    // Un host escribe por pipe: un mensaje grande NO llega de una sola pieza. Si el
    // resto sin `\n` se descartara en vez de guardarse, se perderían mensajes enteros
    // y en silencio — el modo de fallo más caro de diagnosticar que tiene un stdio.
    input.write(mensaje.slice(0, corte));
    await new Promise((r) => setImmediate(r));
    expect(lines(out)).toHaveLength(0);
    input.write(mensaje.slice(corte));
    input.end();
    await done;

    expect(lines(out).find((m) => m.id === 3)).toBeDefined();
  });

  it("una línea ilegible se descarta por diagnóstico y NO corta la sesión", async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const err: string[] = [];
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    output.on("data", (c) => out.push(c.toString()));
    diagnostics.on("data", (c) => err.push(c.toString()));

    const done = runElicitationStdio({ input, output, diagnostics, now: () => 0 });
    input.write("{ esto no es json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} })}\n`);
    input.end();
    await done;

    // Cortar la sesión entera por un byte dejaría al host sin servidor.
    expect(err.join("")).toContain("línea ilegible descartada");
    expect(lines(out).find((m) => m.id === 9)).toBeDefined();
  });
});
