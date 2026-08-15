import { describe, expect, it } from "vitest";
import { NodeProcess } from "../../src/adapters/node-process.js";

const proc = new NodeProcess();

/**
 * A child that writes the two bytes of "é" in separate writes, so the parent
 * necessarily receives them in two distinct chunks — the same split a pipe
 * makes on its own every 64 KB.
 */
const splitChar = (stream: "stdout" | "stderr") =>
  `process.${stream}.write(Buffer.from([0xc3]));` +
  `setTimeout(() => process.${stream}.write(Buffer.from([0xa9])), 100);`;

describe("NodeProcess — decodificación de la salida", () => {
  it("recompone un carácter multibyte partido entre dos chunks de stdout", async () => {
    const res = await proc.run(process.execPath, ["--no-warnings", "-e", splitChar("stdout")]);
    expect(res.stdout).toBe("é");
  });

  it("recompone un carácter multibyte partido entre dos chunks de stderr", async () => {
    const res = await proc.run(process.execPath, ["--no-warnings", "-e", splitChar("stderr")]);
    expect(res.stderr).toBe("é");
  });

  it("runBinary entrega los bytes exactos, incluidos los que no son utf-8", async () => {
    const bytes = [0x00, 0xff, 0xfe, 0x80, 0x41];
    const res = await proc.runBinary(process.execPath, [
      "--no-warnings",
      "-e",
      `process.stdout.write(Buffer.from([${bytes.join(",")}]));`,
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toEqual(Buffer.from(bytes));
  });
});
