import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupFile, purgeStaleBackups } from "../../src/application/multiroot/paths.js";

describe("backupFile — keep-latest (poda antes de copiar)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bak-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baks(name: string): string[] {
    return readdirSync(dir).filter((f) => f.startsWith(`${name}.bak.`));
  }

  it("escrituras sucesivas dejan UN solo .bak (el más reciente)", () => {
    const file = join(dir, "settings.local.json");
    writeFileSync(file, "v1");
    // Simula backups viejos acumulados por versiones previas del CLI.
    writeFileSync(`${file}.bak.1700000000`, "v0");
    writeFileSync(`${file}.bak.1700000001`, "v0b");

    const first = backupFile(file);
    expect(first).not.toBeNull();
    expect(baks("settings.local.json")).toHaveLength(1);

    writeFileSync(file, "v2");
    const second = backupFile(file);
    expect(second).not.toBeNull();
    const remaining = baks("settings.local.json");
    expect(remaining).toHaveLength(1);
    // El .bak sobreviviente respalda el contenido previo a la última escritura.
    expect(readFileSync(join(dir, remaining[0] as string), "utf-8")).toBe("v2");
  });

  it("archivo inexistente: no crea backup ni falla", () => {
    expect(backupFile(join(dir, "no-existe.toml"))).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("purgeStaleBackups borra solo los .bak.<epoch> del archivo, no vecinos", () => {
    const file = join(dir, "config.toml");
    writeFileSync(file, "x");
    writeFileSync(`${file}.bak.1700000000`, "old");
    writeFileSync(join(dir, "otro.toml.bak.1700000000"), "ajeno");
    writeFileSync(join(dir, "config.toml.backup"), "no-matchea");
    purgeStaleBackups(file);
    expect(existsSync(`${file}.bak.1700000000`)).toBe(false);
    expect(existsSync(join(dir, "otro.toml.bak.1700000000"))).toBe(true);
    expect(existsSync(join(dir, "config.toml.backup"))).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});
