import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  readSkillsRegistry,
  readSkillsShLockSources,
  skillsRegistryPath,
  writeSkillsRegistry,
} from "../../src/application/self/skills-registry.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

function buildCtx(home: string): CliContext {
  return { fs: new NodeFileSystem(), env: new FakeEnv(home) } as unknown as CliContext;
}

describe("skills-registry (T3.2)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-skills-registry-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("registro ausente lee vacío sin warning", async () => {
    const read = await readSkillsRegistry(buildCtx(home));
    expect(read.registry).toEqual({ skills: {} });
    expect(read.warning).toBeUndefined();
  });

  it("write + read hacen round-trip del shape completo", async () => {
    const ctx = buildCtx(home);
    await writeSkillsRegistry(ctx, {
      skills: {
        pdf: {
          source: "anthropics/skills",
          ref: "main",
          mode: "symlink",
          installedAt: "2026-07-03T10:00:00.000Z",
        },
        "mi-skill": { source: "/abs/path" },
      },
    });
    const read = await readSkillsRegistry(ctx);
    expect(read.registry.skills.pdf).toEqual({
      source: "anthropics/skills",
      ref: "main",
      mode: "symlink",
      installedAt: "2026-07-03T10:00:00.000Z",
    });
    expect(read.registry.skills["mi-skill"]).toEqual({ source: "/abs/path" });
  });

  it("JSON roto: warning, registro vacío y el archivo queda intacto (patrón lock)", async () => {
    const ctx = buildCtx(home);
    const path = skillsRegistryPath(home);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(path, "{corrupt", "utf8");

    const read = await readSkillsRegistry(ctx);

    expect(read.warning).toContain("No se pudo parsear");
    expect(read.registry).toEqual({ skills: {} });
    expect(await readFile(path, "utf8")).toBe("{corrupt");
  });

  it("entradas malformadas (sin source, mode inválido) se descartan sin romper", async () => {
    const ctx = buildCtx(home);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      skillsRegistryPath(home),
      JSON.stringify({
        skills: {
          ok: { source: "a/b", mode: "hardlink", installedAt: 42 },
          broken: { ref: "main" },
          worse: "string",
        },
      }),
      "utf8",
    );

    const read = await readSkillsRegistry(ctx);

    expect(read.registry.skills.ok).toEqual({ source: "a/b" });
    expect(read.registry.skills.broken).toBeUndefined();
    expect(read.registry.skills.worse).toBeUndefined();
  });

  it("nombres inseguros como segmento de path se descartan (nunca llegan a un rm)", async () => {
    const ctx = buildCtx(home);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      skillsRegistryPath(home),
      JSON.stringify({
        skills: {
          "..": { source: "a/b" },
          ".": { source: "a/b" },
          "evil/../../x": { source: "a/b" },
          "": { source: "a/b" },
          ".oculta": { source: "a/b" },
          "buena-skill": { source: "a/b" },
        },
      }),
      "utf8",
    );

    const read = await readSkillsRegistry(ctx);

    expect(Object.keys(read.registry.skills)).toEqual(["buena-skill"]);
  });

  it("readSkillsShLockSources: fuentes del lock; inseguros/sin-fuente filtrados; ausente o roto = vacío", async () => {
    const ctx = buildCtx(home);
    expect(await readSkillsShLockSources(ctx)).toEqual({});

    await mkdir(join(home, ".agents"), { recursive: true });
    const lockPath = join(home, ".agents", ".skill-lock.json");
    await writeFile(
      lockPath,
      JSON.stringify({
        skills: {
          "mermaid-diagrams": { source: "softaworks/agent-toolkit" },
          "../fuera": { source: "evil/evil" },
          "sin-fuente": { installedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
      "utf8",
    );
    expect(await readSkillsShLockSources(ctx)).toEqual({
      "mermaid-diagrams": "softaworks/agent-toolkit",
    });

    await writeFile(lockPath, "{roto", "utf8");
    expect(await readSkillsShLockSources(ctx)).toEqual({});
  });

  // ===== Spec 043 — identidad y selección en el registro =====

  it("round-trip de los campos de identidad y selección, sin cambiar claves", async () => {
    const ctx = buildCtx(home);
    const entry = {
      source: "trailofbits/skills",
      ref: "main",
      mode: "symlink" as const,
      installedAt: "2026-09-09T10:00:00.000Z",
      path: "plugins/sharp-edges/skills/sharp-edges",
      skillName: "sharp-edges",
      resolvedRef: "d3323cefbcf645678b8dc481de204b02ad3d02dc",
      payloadDigest: "a".repeat(64),
    };
    await writeSkillsRegistry(ctx, { skills: { "sharp-edges": entry } });

    const read = await readSkillsRegistry(ctx);
    expect(read.registry.skills["sharp-edges"]).toEqual(entry);
    // El archivo escrito conserva exactamente esas claves.
    const raw = JSON.parse(await readFile(skillsRegistryPath(home), "utf8"));
    expect(Object.keys(raw.skills["sharp-edges"]).sort()).toEqual([
      "installedAt",
      "mode",
      "path",
      "payloadDigest",
      "ref",
      "resolvedRef",
      "skillName",
      "source",
    ]);
  });

  it("una entrada legacy se lee tal cual: leerla no la migra ni le inventa campos", async () => {
    const ctx = buildCtx(home);
    await mkdir(join(home, ".agents"), { recursive: true });
    const legacy = JSON.stringify({
      skills: {
        ponytail: { source: "DietrichGebert/ponytail", installedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    await writeFile(skillsRegistryPath(home), legacy, "utf8");

    const read = await readSkillsRegistry(ctx);
    expect(read.registry.skills.ponytail).toEqual({
      source: "DietrichGebert/ponytail",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(read.warning).toBeUndefined();
    // Y el archivo no se reescribió por haberlo leído.
    expect(await readFile(skillsRegistryPath(home), "utf8")).toBe(legacy);
  });

  it("un campo nuevo con tipo equivocado se descarta sin perder el resto de la entrada", async () => {
    const ctx = buildCtx(home);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      skillsRegistryPath(home),
      JSON.stringify({
        skills: {
          evaluation: {
            source: "muratcankoylan/agent-skills-for-context-engineering",
            path: 7,
            payloadDigest: null,
            skillName: "evaluation",
          },
        },
      }),
      "utf8",
    );

    const read = await readSkillsRegistry(ctx);
    expect(read.registry.skills.evaluation).toEqual({
      source: "muratcankoylan/agent-skills-for-context-engineering",
      skillName: "evaluation",
    });
  });
});
