import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const entry = resolve("dist/cli/main.js");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invoke(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "aw-retired-launch-"));
  roots.push(root);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, HOME: root, AW_NAMESPACE: "workflow" },
    encoding: "utf8",
  });
  return { root, result };
}

describe("CLI distribuible sin lanzamiento de fuentes", () => {
  it("el help no ofrece generate-launch y la invocación retirada no crea runtime", () => {
    const { result: help } = invoke(["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).not.toContain("generate-launch");
    const { root, result } = invoke(["generate-launch", "--format", "json"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown|desconocido|no reconocido/i);
    expect(readdirSync(root)).toEqual([]);
  });
});
