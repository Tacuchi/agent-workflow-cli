import { describe, expect, it } from "vitest";
import { runGraduate } from "../../src/application/dev-graduate-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeEnv implements EnvPort {
  constructor(private readonly _cwd: string = "/cwd") {}
  get(): string | undefined {
    return undefined;
  }
  homeDir(): string {
    return "/home/u";
  }
  cwd(): string {
    return this._cwd;
  }
}

/**
 * Minimal in-memory FS used by the graduate-service tests. Mirrors the style of
 * the FakeFs used elsewhere (release-data-service.test.ts, code-scan-service.test.ts)
 * but adds writeText/mkdirp persistence and dir/file synthesis on writeText so
 * that nextNumberInDir/copyTree work end-to-end.
 */
class FakeFs implements FileSystemPort {
  files: Map<string, string>;
  dirs: Map<string, DirEntry[]>;
  constructor(
    initialFiles: Record<string, string> = {},
    initialDirs: Record<string, DirEntry[]> = {},
  ) {
    this.files = new Map(Object.entries(initialFiles));
    this.dirs = new Map(Object.entries(initialDirs));
  }
  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, content: string): Promise<void> {
    this.files.set(p, content);
    // Add the file to its parent dir listing if absent.
    const parent = parentOf(p);
    const name = baseOf(p);
    const list = this.dirs.get(parent) ?? [];
    if (!list.some((e) => e.name === name)) {
      list.push({ name, path: p, type: "file" });
      this.dirs.set(parent, list);
    }
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(p: string): Promise<void> {
    if (this.dirs.has(p)) return;
    this.dirs.set(p, []);
    // Walk up and ensure parents are also recorded with the new dir as entry.
    const parent = parentOf(p);
    const name = baseOf(p);
    if (parent && parent !== p) {
      const parentList = this.dirs.get(parent) ?? [];
      if (!parentList.some((e) => e.name === name)) {
        parentList.push({ name, path: p, type: "dir" });
        this.dirs.set(parent, parentList);
      }
    }
  }
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p)) {
      return {
        mtime: new Date("2026-01-01"),
        size: (this.files.get(p) ?? "").length,
        type: "file",
      };
    }
    if (this.dirs.has(p)) {
      return { mtime: new Date("2026-01-01"), size: 0, type: "dir" };
    }
    throw new Error(`ENOENT: ${p}`);
  }
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}
function baseOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

const ns = normalizeNamespace("workflow");
const SESSIONS_DIR = "/cwd/.workflow/sessions";
const SESSION_FOLDER = "session042-dev-target";
const SESSION_PATH = `${SESSIONS_DIR}/${SESSION_FOLDER}`;

function pathsForCwd(cwd: string): PathsService {
  return new PathsService(ns, "/home/u", cwd);
}

function statusMd(state: "active" | "closed" = "active", phase = "execution"): string {
  return `# Status\n\n- State: ${state}\n- Phase: ${phase}\n`;
}

function baseSessionFs(
  extraFiles: Record<string, string> = {},
  extraDirs: Record<string, DirEntry[]> = {},
): FakeFs {
  return new FakeFs(
    {
      [`${SESSION_PATH}/STATUS.md`]: statusMd(),
      [`${SESSION_PATH}/OBJETIVO.md`]: "# Objetivo\n",
      ...extraFiles,
    },
    {
      [SESSIONS_DIR]: [{ name: SESSION_FOLDER, path: SESSION_PATH, type: "dir" }],
      [SESSION_PATH]: [
        { name: "STATUS.md", path: `${SESSION_PATH}/STATUS.md`, type: "file" },
        { name: "OBJETIVO.md", path: `${SESSION_PATH}/OBJETIVO.md`, type: "file" },
      ],
      ...extraDirs,
    },
  );
}

describe("runGraduate — input validation", () => {
  it("rejects unknown kind", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "unknown",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/--kind debe ser uno de:/);
  });

  it("rejects when --session missing", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "decision",
      slug: "x",
      decId: "DEC-001",
    });
    expect("error" in result && result.error).toMatch(/--session/);
  });

  it("rejects when --slug missing", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "042",
    });
    expect("error" in result && result.error).toMatch(/--slug/);
  });

  it("rejects when session not found", async () => {
    const fs = new FakeFs({}, { [SESSIONS_DIR]: [] });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "999",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/Sesión no encontrada/);
  });
});

describe("runGraduate — kind=decision", () => {
  it("happy path: extracts DEC-NNN block, writes to docs/decisiones/, leaves pointer", async () => {
    const decContent =
      "# Decisiones\n\n## DEC-001 — algo\n\nrazonamiento\n\n## DEC-002 — otro\n\notro razonamiento\n";
    const fs = baseSessionFs({
      [`${SESSION_PATH}/DECISIONES.md`]: decContent,
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "decision",
      session: "042",
      slug: "algo-importante",
      decId: "DEC-001",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.kind).toBe("decision");
    expect(result.next_number).toBe("001");
    expect(result.target).toBe("/cwd/docs/decisiones/001-algo-importante.md");
    const written = fs.files.get("/cwd/docs/decisiones/001-algo-importante.md") ?? "";
    expect(written).toContain("DEC-001");
    expect(written).toContain("razonamiento");
    // Pointer left behind
    const newDec = fs.files.get(`${SESSION_PATH}/DECISIONES.md`) ?? "";
    expect(newDec).toContain("→ docs/decisiones/001-algo-importante.md");
    // DEC-002 is preserved
    expect(newDec).toContain("DEC-002");
  });

  it("error when DEC-NNN block missing", async () => {
    const decContent = "# Decisiones\n\n## DEC-001 — algo\n\nrazonamiento\n";
    const fs = baseSessionFs({
      [`${SESSION_PATH}/DECISIONES.md`]: decContent,
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "decision",
      session: "042",
      slug: "x",
      decId: "DEC-099",
    });
    expect("error" in result && result.error).toMatch(/DEC-099 no encontrado/);
  });

  it("error when --id missing", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/DECISIONES.md`]: "# Decisiones\n",
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "decision",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/--id \(DEC-NNN\)/);
  });

  it("error when DECISIONES.md missing", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "decision",
      session: "042",
      slug: "x",
      decId: "DEC-001",
    });
    expect("error" in result && result.error).toMatch(/DECISIONES.md no existe/);
  });
});

describe("runGraduate — kind=manual", () => {
  it("happy path with default source MANUAL.md", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/MANUAL.md`]: "# Manual\n\nGuía de configuración.\n",
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "042",
      slug: "guia-config",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.kind).toBe("manual");
    expect(result.target).toBe("/cwd/docs/manuales/001-guia-config.md");
    expect(fs.files.get("/cwd/docs/manuales/001-guia-config.md")).toContain(
      "Guía de configuración",
    );
  });

  it("happy path with custom --source path", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/docs/MT-mi-manual.md`]: "# MT\nContenido custom.\n",
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "042",
      slug: "mi-manual",
      source: "docs/MT-mi-manual.md",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.target).toBe("/cwd/docs/manuales/001-mi-manual.md");
    expect(fs.files.get("/cwd/docs/manuales/001-mi-manual.md")).toContain("Contenido custom");
  });

  it("error when source file does not exist", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/MANUAL\.md/);
  });

  it("auto-numbers when prior manuals exist", async () => {
    const fs = baseSessionFs(
      {
        [`${SESSION_PATH}/MANUAL.md`]: "# nuevo\n",
        "/cwd/docs/manuales/001-anterior.md": "# anterior\n",
        "/cwd/docs/manuales/002-otro.md": "# otro\n",
      },
      {
        "/cwd/docs/manuales": [
          { name: "001-anterior.md", path: "/cwd/docs/manuales/001-anterior.md", type: "file" },
          { name: "002-otro.md", path: "/cwd/docs/manuales/002-otro.md", type: "file" },
        ],
      },
    );
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "042",
      slug: "tercero",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.next_number).toBe("003");
  });
});

describe("runGraduate — kind=script", () => {
  it("happy path with scripts/ + queries/", async () => {
    const fs = baseSessionFs(
      {
        [`${SESSION_PATH}/scripts/01-table.sql`]: "CREATE TABLE x;\n",
        [`${SESSION_PATH}/scripts/02-data.sql`]: "INSERT INTO x VALUES (1);\n",
        [`${SESSION_PATH}/queries/conteo.sql`]: "SELECT COUNT(*) FROM x;\n",
      },
      {
        [`${SESSION_PATH}/scripts`]: [
          { name: "01-table.sql", path: `${SESSION_PATH}/scripts/01-table.sql`, type: "file" },
          { name: "02-data.sql", path: `${SESSION_PATH}/scripts/02-data.sql`, type: "file" },
        ],
        [`${SESSION_PATH}/queries`]: [
          { name: "conteo.sql", path: `${SESSION_PATH}/queries/conteo.sql`, type: "file" },
        ],
      },
    );
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "script",
      session: "042",
      slug: "feature-x",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.kind).toBe("script");
    expect(result.target).toBe("/cwd/docs/scripts/001-session042-feature-x");
    expect(result.files_copied).toBe(3);
    expect(fs.files.get("/cwd/docs/scripts/001-session042-feature-x/scripts/01-table.sql")).toBe(
      "CREATE TABLE x;\n",
    );
    expect(fs.files.get("/cwd/docs/scripts/001-session042-feature-x/queries/conteo.sql")).toBe(
      "SELECT COUNT(*) FROM x;\n",
    );
  });

  it("happy path with only scripts/ (no queries/)", async () => {
    const fs = baseSessionFs(
      {
        [`${SESSION_PATH}/scripts/01-table.sql`]: "CREATE TABLE x;\n",
      },
      {
        [`${SESSION_PATH}/scripts`]: [
          { name: "01-table.sql", path: `${SESSION_PATH}/scripts/01-table.sql`, type: "file" },
        ],
      },
    );
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "script",
      session: "042",
      slug: "feature-y",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.files_copied).toBe(1);
    expect(fs.files.has("/cwd/docs/scripts/001-session042-feature-y/scripts/01-table.sql")).toBe(
      true,
    );
  });

  it("error when neither scripts/ nor queries/ exist", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "script",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/scripts.*queries/);
  });

  it("auto-numbers script bundles based on existing dirs", async () => {
    const fs = baseSessionFs(
      {
        [`${SESSION_PATH}/scripts/x.sql`]: "select 1;\n",
      },
      {
        [`${SESSION_PATH}/scripts`]: [
          { name: "x.sql", path: `${SESSION_PATH}/scripts/x.sql`, type: "file" },
        ],
        "/cwd/docs/scripts": [
          {
            name: "001-session001-prev",
            path: "/cwd/docs/scripts/001-session001-prev",
            type: "dir",
          },
          {
            name: "002-session010-otro",
            path: "/cwd/docs/scripts/002-session010-otro",
            type: "dir",
          },
        ],
      },
    );
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "script",
      session: "042",
      slug: "nuevo",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.next_number).toBe("003");
    expect(result.target).toBe("/cwd/docs/scripts/003-session042-nuevo");
  });
});

describe("runGraduate — kind=especificacion", () => {
  it("happy path with default ENTREGA.md", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/ENTREGA.md`]: "# Spec\nContenido del entregable.\n",
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "especificacion",
      session: "042",
      slug: "ux-componente",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.kind).toBe("especificacion");
    expect(result.target).toBe("/cwd/docs/especificaciones/001-ux-componente/ENTREGA.md");
    expect(fs.files.get(result.target)).toContain("Contenido del entregable");
  });

  it("happy path with custom --source filename", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/SPEC.md`]: "# spec custom\n",
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "especificacion",
      session: "042",
      slug: "alt",
      source: "SPEC.md",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.target).toBe("/cwd/docs/especificaciones/001-alt/SPEC.md");
  });

  it("error when ENTREGA.md missing", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "especificacion",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/ENTREGA\.md/);
  });
});

describe("runGraduate — kind=conclusion", () => {
  it("happy path with CONCLUSIONES.md", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/CONCLUSIONES.md`]: "# Conclusiones\nResumen final.\n",
    });
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "conclusion",
      session: "042",
      slug: "cierre",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.kind).toBe("conclusion");
    expect(result.target).toBe("/cwd/docs/conclusiones/001-cierre.md");
    expect(fs.files.get(result.target)).toContain("Resumen final");
  });

  it("error when CONCLUSIONES.md missing", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "conclusion",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/CONCLUSIONES\.md no existe/);
  });
});

describe("runGraduate — kind=release", () => {
  it("rejects with hint to use the release command", async () => {
    const fs = baseSessionFs();
    const result = await runGraduate(fs, new FakeEnv(), pathsForCwd("/cwd"), {
      kind: "release",
      session: "042",
      slug: "x",
    });
    expect("error" in result && result.error).toMatch(/comando `release`/);
  });
});

describe("runGraduate — workspace mode resolution (DEC-002)", () => {
  it("project mode: destino en <cwd>/docs/...", async () => {
    const fs = baseSessionFs({
      [`${SESSION_PATH}/MANUAL.md`]: "# manual\n",
    });
    const result = await runGraduate(fs, new FakeEnv("/cwd"), pathsForCwd("/cwd"), {
      kind: "manual",
      session: "042",
      slug: "p",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.target.startsWith("/cwd/docs/manuales/")).toBe(true);
  });

  it("hub mode: destino en <hub-root>/docs/... (workspace root es env.cwd())", async () => {
    // Hub workspace at /hub. Sessions live under /hub/.workflow/sessions/.
    const hubSessionsDir = "/hub/.workflow/sessions";
    const hubSessionPath = `${hubSessionsDir}/${SESSION_FOLDER}`;
    const fs = new FakeFs(
      {
        [`${hubSessionPath}/STATUS.md`]: statusMd(),
        [`${hubSessionPath}/OBJETIVO.md`]: "# Objetivo\n",
        [`${hubSessionPath}/MANUAL.md`]: "# hub manual\n",
      },
      {
        [hubSessionsDir]: [{ name: SESSION_FOLDER, path: hubSessionPath, type: "dir" }],
        [hubSessionPath]: [
          { name: "STATUS.md", path: `${hubSessionPath}/STATUS.md`, type: "file" },
          { name: "OBJETIVO.md", path: `${hubSessionPath}/OBJETIVO.md`, type: "file" },
          { name: "MANUAL.md", path: `${hubSessionPath}/MANUAL.md`, type: "file" },
        ],
      },
    );
    const env = new FakeEnv("/hub");
    const paths = pathsForCwd("/hub");
    const result = await runGraduate(fs, env, paths, {
      kind: "manual",
      session: "042",
      slug: "guia",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.target).toBe("/hub/docs/manuales/001-guia.md");
    expect(fs.files.get(result.target)).toContain("hub manual");
  });

  it("hub mode + cwd dentro de fuente: walk-up resuelve hub-root (DEC-002)", async () => {
    // Hub at /hub with .workflow marker. User did `cd /hub/sources/agent-workflow-cli/src`
    // before running graduate. Destination must still land in /hub/docs/, not the fuente.
    const hubSessionsDir = "/hub/.workflow/sessions";
    const hubSessionPath = `${hubSessionsDir}/${SESSION_FOLDER}`;
    const fs = new FakeFs(
      {
        [`${hubSessionPath}/STATUS.md`]: statusMd(),
        [`${hubSessionPath}/OBJETIVO.md`]: "# Objetivo\n",
        [`${hubSessionPath}/MANUAL.md`]: "# walk-up manual\n",
      },
      {
        // Marker dir at the hub root makes walk-up succeed.
        "/hub/.workflow": [{ name: "sessions", path: hubSessionsDir, type: "dir" }],
        [hubSessionsDir]: [{ name: SESSION_FOLDER, path: hubSessionPath, type: "dir" }],
        [hubSessionPath]: [
          { name: "STATUS.md", path: `${hubSessionPath}/STATUS.md`, type: "file" },
          { name: "OBJETIVO.md", path: `${hubSessionPath}/OBJETIVO.md`, type: "file" },
          { name: "MANUAL.md", path: `${hubSessionPath}/MANUAL.md`, type: "file" },
        ],
      },
    );
    const cwdInsideFuente = "/hub/sources/agent-workflow-cli/src";
    const env = new FakeEnv(cwdInsideFuente);
    // PathsService still cwd-aware for unrelated lookups; resolveWorkspaceRoot
    // does the walk-up against fs/env.
    const paths = pathsForCwd(cwdInsideFuente);
    const result = await runGraduate(fs, env, paths, {
      kind: "manual",
      session: "042",
      slug: "guia",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.target).toBe("/hub/docs/manuales/001-guia.md");
    expect(fs.files.get(result.target)).toContain("walk-up manual");
  });
});
