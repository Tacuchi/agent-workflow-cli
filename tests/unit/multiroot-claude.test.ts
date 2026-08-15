import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachClaude,
  claudeSettingsPath,
  detachClaude,
} from "../../src/application/multiroot/claude.js";

interface AttachShape {
  file: string;
  backup: string | null;
  added: string[];
  already_present: string[];
  written: boolean;
}
interface DetachShape {
  file: string;
  backup: string | null;
  removed: string[];
  not_present: string[];
  written: boolean;
}
interface FailShape {
  file: string;
  error: string;
  detail?: string;
  skipped: true;
}

describe("attachClaude / detachClaude — visibilidad multi-root de Claude Code", () => {
  let scopeDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "claude-multiroot-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  function settingsFile(): string {
    return join(scopeDir, ".claude", "settings.local.json");
  }
  function sharedFile(): string {
    return join(scopeDir, ".claude", "settings.json");
  }
  function read(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  }
  function additionalDirs(file: string): unknown {
    return (read(file).permissions as Record<string, unknown>).additionalDirectories;
  }

  // The paths are absolute and machine-specific: writing them into the shared,
  // committed settings.json would push one developer's layout onto everyone.
  it("escribe en settings.local.json y NUNCA en settings.json", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(sharedFile(), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));

    const result = attachClaude(["/tmp/uno"], scopeDir) as AttachShape;

    expect(result.file).toBe(settingsFile());
    expect(claudeSettingsPath(scopeDir)).toBe(settingsFile());
    expect(result.written).toBe(true);
    expect(additionalDirs(settingsFile())).toEqual(["/tmp/uno"]);
    // El archivo compartido queda byte a byte como estaba.
    expect(read(sharedFile())).toEqual({ permissions: { defaultMode: "acceptEdits" } });
  });

  it("crea .claude/ cuando no existe", () => {
    expect(existsSync(join(scopeDir, ".claude"))).toBe(false);
    attachClaude(["/tmp/uno"], scopeDir);
    expect(existsSync(settingsFile())).toBe(true);
  });

  it("preserva las claves ajenas del JSON existente", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        env: { FOO: "bar" },
        permissions: { allow: ["Bash(ls:*)"], additionalDirectories: ["/tmp/previo"] },
        hooks: { PreCompact: [] },
      }),
    );

    attachClaude(["/tmp/nuevo"], scopeDir);

    const data = read(settingsFile());
    expect(data.env).toEqual({ FOO: "bar" });
    expect(data.hooks).toEqual({ PreCompact: [] });
    const perms = data.permissions as Record<string, unknown>;
    expect(perms.allow).toEqual(["Bash(ls:*)"]);
    expect(perms.additionalDirectories).toEqual(["/tmp/previo", "/tmp/nuevo"]);
  });

  it("es idempotente: attach dos veces no duplica la ruta ni reescribe", () => {
    const first = attachClaude(["/tmp/uno"], scopeDir) as AttachShape;
    expect(first.added).toEqual(["/tmp/uno"]);
    expect(first.written).toBe(true);

    const second = attachClaude(["/tmp/uno"], scopeDir) as AttachShape;

    expect(second.added).toEqual([]);
    expect(second.already_present).toEqual(["/tmp/uno"]);
    // Nada que agregar ⇒ no se toca el archivo, así que tampoco hay backup.
    expect(second.written).toBe(false);
    expect(second.backup).toBeNull();
    expect(additionalDirs(settingsFile())).toEqual(["/tmp/uno"]);
  });

  // `normalizePath` decide la identidad: una barra final no es otra ruta.
  it("una ruta ya presente con barra final cuenta como presente", () => {
    attachClaude(["/tmp/uno"], scopeDir);
    const again = attachClaude(["/tmp/uno/"], scopeDir) as AttachShape;
    expect(again.already_present).toEqual(["/tmp/uno"]);
    expect(additionalDirs(settingsFile())).toEqual(["/tmp/uno"]);
  });

  it("detach saca sólo lo suyo y deja el resto intacto", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        env: { FOO: "bar" },
        permissions: { additionalDirectories: ["/tmp/uno", "/tmp/ajeno", "/tmp/dos"] },
      }),
    );

    const result = detachClaude(
      ["/tmp/uno", "/tmp/dos", "/tmp/nunca-estuvo"],
      scopeDir,
    ) as DetachShape;

    expect(result.removed).toEqual(["/tmp/uno", "/tmp/dos"]);
    expect(result.not_present).toEqual(["/tmp/nunca-estuvo"]);
    expect(result.written).toBe(true);
    expect(additionalDirs(settingsFile())).toEqual(["/tmp/ajeno"]);
    expect(read(settingsFile()).env).toEqual({ FOO: "bar" });
  });

  it("detach sin nada que sacar no escribe ni respalda", () => {
    attachClaude(["/tmp/uno"], scopeDir);
    const result = detachClaude(["/tmp/otro"], scopeDir) as DetachShape;
    expect(result.removed).toEqual([]);
    expect(result.not_present).toEqual(["/tmp/otro"]);
    expect(result.written).toBe(false);
    expect(result.backup).toBeNull();
  });

  it("detach sin archivo de settings no falla: informa que no estaban", () => {
    const result = detachClaude(["/tmp/uno"], scopeDir) as DetachShape;
    expect(result.file).toBe(settingsFile());
    expect(result.removed).toEqual([]);
    expect(result.not_present).toEqual(["/tmp/uno"]);
    expect(result.written).toBe(false);
    expect(existsSync(settingsFile())).toBe(false);
  });

  // Un settings.local.json a mano puede tener cualquier cosa: el contenido previo
  // se respalda ANTES de sobrescribir, o una edición manual se pierde sin rastro.
  it("respalda el contenido previo antes de sobrescribir (attach y detach)", () => {
    attachClaude(["/tmp/uno"], scopeDir);
    const before = readFileSync(settingsFile(), "utf-8");

    const second = attachClaude(["/tmp/dos"], scopeDir) as AttachShape;
    expect(second.backup).not.toBeNull();
    expect(readFileSync(second.backup as string, "utf-8")).toBe(before);

    const afterAttach = readFileSync(settingsFile(), "utf-8");
    const removal = detachClaude(["/tmp/dos"], scopeDir) as DetachShape;
    expect(removal.backup).not.toBeNull();
    expect(readFileSync(removal.backup as string, "utf-8")).toBe(afterAttach);

    // Keep-latest: los .bak no se acumulan.
    const baks = readdirSync(join(scopeDir, ".claude")).filter((f) =>
      f.startsWith("settings.local.json.bak."),
    );
    expect(baks).toHaveLength(1);
  });

  it("la primera escritura no inventa un backup de un archivo inexistente", () => {
    const first = attachClaude(["/tmp/uno"], scopeDir) as AttachShape;
    expect(first.backup).toBeNull();
    expect(readdirSync(join(scopeDir, ".claude")).filter((f) => f.includes(".bak."))).toHaveLength(
      0,
    );
  });

  // Fail-fast: un JSON roto se reporta, nunca se pisa con uno nuevo.
  it("JSON inválido: se salta e informa, sin tocar el archivo", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), "{ esto no es json");

    const attached = attachClaude(["/tmp/uno"], scopeDir) as FailShape;
    expect(attached.skipped).toBe(true);
    expect(attached.error).toBe("invalid_json");
    expect(attached.detail).toBeDefined();

    const detached = detachClaude(["/tmp/uno"], scopeDir) as FailShape;
    expect(detached.skipped).toBe(true);
    expect(detached.error).toBe("invalid_json");

    expect(readFileSync(settingsFile(), "utf-8")).toBe("{ esto no es json");
  });

  it("settings sin permissions.additionalDirectories: detach lo dice y no escribe", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ env: { FOO: "bar" } }));

    const result = detachClaude(["/tmp/uno"], scopeDir) as DetachShape;

    expect(result.removed).toEqual([]);
    expect(result.not_present).toEqual(["/tmp/uno"]);
    expect(result.written).toBe(false);
    expect(read(settingsFile())).toEqual({ env: { FOO: "bar" } });
  });
});
