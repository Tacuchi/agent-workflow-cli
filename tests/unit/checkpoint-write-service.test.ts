import { describe, expect, it } from "vitest";
import {
  runCheckpointWrite,
  writeRefugeCheckpoint,
} from "../../src/application/checkpoint-write-service.js";
import { isPristineCheckpoint } from "../../src/application/checkpoint/markdown.js";
import { PathsService } from "../../src/application/paths-service.js";
import { hashContextId } from "../../src/application/session-binding-service.js";
import type { DirEntry } from "../../src/ports/file-system.js";
import type { GitPort, LocalChange, NumstatCounts } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

// Rebuilds the old FakeFs(files, dirs) shape on the shared MemFs: seed files and
// explicit dir listings; `.writes` covers the write-overlay assertions.
function makeFs(
  files: Map<string, string> = new Map(),
  dirs: Map<string, DirEntry[]> = new Map(),
): MemFs {
  const fs = new MemFs();
  for (const [p, content] of files) fs.file(p, content);
  for (const [dir, entries] of dirs) {
    fs.dir(dir);
    for (const e of entries) {
      if (e.type === "dir") fs.dir(e.path);
      else fs.file(e.path, files.get(e.path) ?? "");
    }
  }
  return fs;
}

const localChange = (path: string, untracked = false): LocalChange => ({
  path,
  from: null,
  code: untracked ? "??" : "M.",
  staged: !untracked,
  unstaged: false,
  untracked,
  head_mode: untracked ? null : "100644",
  worktree_mode: "100644",
});

/**
 * Seeded on purpose, and it records where it was asked.
 *
 * A fake missing `localChanges` still let every one of these suites pass: the
 * collection threw `is not a function`, the whole inventory degraded to "unit
 * not observed", and no assert noticed — so the only path that reaches
 * `extractSessionState` in the whole test suite was the failure branch. A
 * default that returns real changes is what makes these tests exercise the
 * feature they are supposed to cover.
 */
class FakeGit implements GitPort {
  /** Every repoPath git was asked about, so a test can prove WHERE it looked. */
  readonly asked: string[] = [];

  constructor(
    private readonly changes: Record<string, LocalChange[]> = {
      "/cwd": [localChange("src/foo.ts"), localChange("nuevo.md", true)],
    },
    private readonly prefix: string | null = "",
  ) {}

  async isGitRepo() {
    return true;
  }
  async currentBranch() {
    return "main";
  }
  async isDirty() {
    return false;
  }
  async changedFiles() {
    return [];
  }
  async repoPrefix(repo: string): Promise<string | null> {
    this.asked.push(`repoPrefix:${repo}`);
    return this.prefix;
  }

  async localChanges(repo: string): Promise<LocalChange[]> {
    this.asked.push(`localChanges:${repo}`);
    const found = this.changes[repo];
    if (found === undefined) throw new Error(`git status failed in ${repo}`);
    return found;
  }

  async head(): Promise<string | null> {
    return "abc1234def5678";
  }

  async numstatFor(
    _repo: string,
    tracked: string[],
    untracked: string[],
  ): Promise<Record<string, NumstatCounts>> {
    const counts: Record<string, NumstatCounts> = {};
    for (const path of tracked) counts[path] = { added: "3", removed: "1" };
    for (const path of untracked) counts[path] = { added: "7", removed: "0" };
    return counts;
  }
  async checkout(): Promise<void> {}
  async pull(): Promise<void> {}
  async merge(): Promise<{ ok: boolean; conflicted: string[] }> {
    return { ok: true, conflicted: [] };
  }
  async push(): Promise<void> {}
  async isMerging(): Promise<boolean> {
    return false;
  }
  async conflictedFiles(): Promise<string[]> {
    return [];
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");

function workflowProjectBlock(opts: {
  proyecto: string;
  sessions: { folder: string; phase: string; branches: string[] }[];
}): string {
  const sessLines = opts.sessions.length
    ? opts.sessions
        .map((s) => `  - ${s.folder} · fase: ${s.phase} · ramas: ${s.branches.join(", ")}`)
        .join("\n")
    : "  _ninguna_";
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

${opts.proyecto}

Mode: project

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| core | /repo | certificacion |

## Stack

_Stack sin detectar._

## Status

- Sesiones activas:
${sessLines}
- Última actividad: 2026-01-01 00:00
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
}

describe("runCheckpointWrite", () => {
  it("skips when no active sessions in WORKFLOW-PROJECT.Status", async () => {
    const fs = makeFs(
      new Map([["/cwd/CLAUDE.md", workflowProjectBlock({ proyecto: "p", sessions: [] })]]),
      new Map([["/cwd/.workflow/sessions", []]]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result && result.skipped) {
      expect(result.reason).toContain("no hay sesiones activas");
    }
  });

  it("writes CHECKPOINT.md for the only active session (no --code) post-flag-day WORKFLOW markers", async () => {
    const sessionFolder = "session010-dev-test-coverage";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const fs = makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [{ folder: sessionFolder, phase: "execution", branches: ["core:feat/x"] }],
          }),
        ],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\n## Requerimiento\nfoo\n"],
        [`${sessionPath}/TASKS.md`, "- [x] T1\n- [ ] T2\n- [ ] T3\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    if (!("checkpoint_path" in result) || "skipped" in result) {
      throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    }
    expect(result.session).toBe(sessionFolder);
    expect(result.checkpoint_path).toBe(`${sessionPath}/CHECKPOINT.md`);
    expect(result.tasks_open).toBe(2);
    expect(result.tasks_closed).toBe(1);
    expect(fs.writes.has(`${sessionPath}/CHECKPOINT.md`)).toBe(true);
  });

  it("skips with helpful reason when ≥2 active sessions and no --code", async () => {
    const fs = makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [
              { folder: "session001-dev-foo", phase: "planning", branches: [] },
              { folder: "session002-dev-bar", phase: "planning", branches: [] },
            ],
          }),
        ],
      ]),
      new Map([
        [
          "/cwd/.workflow/sessions",
          [
            {
              name: "session001-dev-foo",
              path: "/cwd/.workflow/sessions/session001-dev-foo",
              type: "dir",
            },
            {
              name: "session002-dev-bar",
              path: "/cwd/.workflow/sessions/session002-dev-bar",
              type: "dir",
            },
          ],
        ],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    // The compaction goes ahead, Workline writes no session line and declares
    // degraded continuity with `primary_session: null` — the active list is
    // shown as candidates, never as an identity.
    if (!("continuity" in result)) {
      throw new Error(`expected a degraded result, got: ${JSON.stringify(result)}`);
    }
    expect(result.continuity).toBe("degraded");
    expect(result.primary_session).toBeNull();
    expect(result.reason).toContain("2 sesiones activas");
    expect(result.active_sessions).toEqual(["session001-dev-foo", "session002-dev-bar"]);
    expect(result.candidates.map((c) => c.folder)).toEqual([
      "session001-dev-foo",
      "session002-dev-bar",
    ]);
    expect(result.action).toContain("--code");
    // The only write is the refuge; with no conversation id it is named
    // `desconocida` instead of by the conversation's digest, and its path is
    // reported relative to the workspace root.
    const writes = [...fs.writes.keys()];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(`/cwd/${result.refuge_path}`);
    expect(result.refuge_path).toBe(".workflow/sessions/.refuge/desconocida.md");
  });

  it("--code resolves to specific session and writes CHECKPOINT.md", async () => {
    const sessionFolder = "session042-dev-target";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const fs = makeFs(
      new Map([
        ["/cwd/CLAUDE.md", workflowProjectBlock({ proyecto: "p", sessions: [] })],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\nfoo\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        code: "042",
      },
    );
    if (!("checkpoint_path" in result) || "skipped" in result) {
      throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    }
    expect(result.session).toBe(sessionFolder);
  });

  it("--code returns null folder when no matching session exists (falls through to skip)", async () => {
    const fs = makeFs(
      new Map([["/cwd/CLAUDE.md", workflowProjectBlock({ proyecto: "p", sessions: [] })]]),
      new Map([["/cwd/.workflow/sessions", []]]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        code: "999",
      },
    );
    expect("skipped" in result && result.skipped).toBe(true);
  });

  it("reads WORKFLOW-PROJECT markers in CLAUDE.md", async () => {
    const sessionFolder = "session001-dev-markers";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const projectBlock = `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

current

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| core | /repo | certificacion |

## Stack

_Stack sin detectar._

## Status

- Sesiones activas:
  - ${sessionFolder} · fase: planning · ramas: core:feat/x
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
    const fs = makeFs(
      new Map([
        ["/cwd/CLAUDE.md", projectBlock],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\nfoo\n"],
        [`${sessionPath}/TASKS.md`, "- [ ] T1\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    if (!("checkpoint_path" in result) || "skipped" in result) {
      throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    }
    expect(result.session).toBe(sessionFolder);
  });

  it("idempotency — re-write produces same content (no placeholders)", async () => {
    const sessionFolder = "session001-dev-idem";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const fs = makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [{ folder: sessionFolder, phase: "planning", branches: [] }],
          }),
        ],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\nfoo\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const r1 = await runCheckpointWrite(fs, new FakeEnv("/home/u", "/cwd"), new FakeGit(), paths);
    if (!("checkpoint_path" in r1) || "skipped" in r1) throw new Error("first call should write");
    const content1 = fs.writes.get(`${sessionPath}/CHECKPOINT.md`) ?? "";

    // Second call over the CLI's own untouched output: still free to regenerate,
    // because the file is byte-for-byte the template it wrote. The case this
    // test used to admit it did not cover — a PARTIALLY filled checkpoint, which
    // is the one that lost work — lives in `checkpoint-sentinel.test.ts`.
    const r2 = await runCheckpointWrite(fs, new FakeEnv("/home/u", "/cwd"), new FakeGit(), paths);
    if (!("checkpoint_path" in r2)) throw new Error(JSON.stringify(r2));
    expect(r2.preserved).toBeUndefined();
    expect(content1.length).toBeGreaterThan(50);
    expect(content1).toContain(sessionFolder);
  });
});

// ── the write pipeline's happy path, which had no test at all (spec 038) ─────

describe("el inventario que llega al CHECKPOINT.md escrito", () => {
  const folder = "session900-inventario";
  const sessionPath = `/cwd/.workflow/sessions/${folder}`;

  function seeded(): MemFs {
    return makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [{ folder, phase: "execution", branches: ["core:feat/x"] }],
          }),
        ],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ path: sessionPath, name: folder, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
  }

  async function write(git: FakeGit) {
    const fs = seeded();
    const result = await runCheckpointWrite(fs, new FakeEnv("/home/u", "/cwd"), git, paths);
    return { result, body: await fs.readText(`${sessionPath}/CHECKPOINT.md`) };
  }

  it("escribe las rutas realmente recolectadas, con su límite y su referencia", async () => {
    const { body } = await write(new FakeGit());

    // Each of these fails if the collection degrades to "unit not observed",
    // which is exactly what a fake without `localChanges` used to produce
    // while every assertion in this file stayed green.
    expect(body).toContain("_Scope: workspace at `/cwd` (vs abc1234)");
    expect(body).toContain("- src/foo.ts (+3 -1) — _[AI: purpose in 1 line]_");
    expect(body).toContain("- nuevo.md (+7 -0) — _[AI: purpose in 1 line]_");
    expect(body).not.toContain("Not observed");
    expect(body).not.toContain("No uncommitted changes");
  });

  it("cuenta el alcance en el JSON de salida, no cero", async () => {
    const { result } = await write(new FakeGit());
    expect("files_touched_count" in result && result.files_touched_count).toBe(2);
  });

  it("le pregunta a git por la RAÍZ del workspace y por nada más", async () => {
    const git = new FakeGit();
    await write(git);
    // The seam the defect lived in: the boundary must be the workspace root,
    // never whatever directory the process happened to start in.
    expect(git.asked).toContain("repoPrefix:/cwd");
    expect(git.asked).toContain("localChanges:/cwd");
    expect(git.asked.every((call) => call.endsWith(":/cwd"))).toBe(true);
  });

  it("una recolección que falla se declara, y NO se escribe como árbol limpio", async () => {
    // No entry for `/cwd`, so the seeded fake throws the way real git would.
    const { result, body } = await write(new FakeGit({}));

    expect(body).toContain("- **Not observed — workspace** at `/cwd`: git status failed in /cwd");
    expect(body).toContain("_No unit in scope could be read");
    expect(body).not.toContain("No uncommitted changes");
    expect("files_touched_count" in result && result.files_touched_count).toBe(0);
  });

  it("acota al workspace cuando está anidado en un repositorio mayor", async () => {
    // Prefix says: this boundary sits at `projects/ws/` inside its repository,
    // so git's repo-root-relative answers must be filtered and re-spelled.
    const git = new FakeGit(
      {
        "/cwd": [
          localChange("projects/ws/mio.ts"),
          localChange("projects/other/ajeno.ts"),
          localChange("projects/ws2/vecino.ts"),
        ],
      },
      "projects/ws/",
    );
    const { body, result } = await write(git);

    expect(body).toContain("- mio.ts (+3 -1)");
    expect(body).not.toContain("ajeno");
    // `projects/ws2/` shares a textual prefix with `projects/ws/` and must not
    // be swallowed by it — the trailing slash is what keeps them apart.
    expect(body).not.toContain("vecino");
    expect("files_touched_count" in result && result.files_touched_count).toBe(1);
  });
});

// ── el refugio: lo que se guarda cuando ninguna sesión resuelve, y su adopción ─
//
// PreCompact dejó de poder bloquear (bloquear era irrecuperable desde adentro),
// así que el estado de una conversación sin sesión resuelta no puede quedar en
// la nada: va a `.workflow/sessions/.refuge/` y se adopta cuando la sesión sí
// resuelve. Estas pruebas cubren las dos mitades y el caso que no debe pasar.

const sessionsDir = "/cwd/.workflow/sessions";
const refugeDir = `${sessionsDir}/.refuge`;
const conv = "conv-precompact";

/** Sesiones activas y nada más: la identidad no es lo que se prueba acá. */
function seedActive(...folders: string[]): MemFs {
  const fs = new MemFs({ lenient: true });
  for (const folder of folders) {
    fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n`);
    fs.file(`${sessionsDir}/${folder}/TASKS.md`, "- [x] T1\n- [ ] T2\n");
  }
  return fs;
}

/** Un refugio ya parqueado, escrito por el mismo camino que lo escribe en prod. */
function park(fs: MemFs, contextId?: string): Promise<string> {
  return writeRefugeCheckpoint(fs, paths, {
    reason: "hay 2 sesiones activas y la conversación no tiene una asociación",
    action: "indicá cuál con --code <NNN>",
    candidates: [{ folder: "044-b-plan-exec", code: "044", state: "active" }],
    ...(contextId !== undefined ? { contextId } : {}),
  });
}

describe("el refugio se escribe sólo cuando alguien podría adoptarlo", () => {
  it("ambigüedad con candidatas: refugio con motivo, candidatas, salida y conversación en digest", async () => {
    const fs = seedActive("020-a-quick", "044-b-plan-exec");
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        contextId: conv,
      },
    );
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.refuge_path).toBe(`.workflow/sessions/.refuge/${hashContextId(conv)}.md`);

    const body = await fs.readText(`${refugeDir}/${hashContextId(conv)}.md`);
    expect(body).toContain("# CHECKPOINT de refugio");
    expect(body).toContain("hook de ciclo de vida (PreCompact o SessionEnd)");
    expect(body).toContain("- Motivo: hay 2 sesiones activas");
    expect(body).toContain("- Candidatas: 020-a-quick (active) · 044-b-plan-exec (active)");
    expect(body).toContain("- Acción: indicá cuál con --code");
    expect(body).toMatch(/- Fecha: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // La misma regla que el registro de bindings: el id crudo no toca el disco.
    expect(body).toContain(`- Conversación: sha256:${hashContextId(conv)}`);
    expect(body).not.toContain(conv);
  });

  it("cero candidatas: aviso y nada más — un refugio sin adoptante posible no existe", async () => {
    const fs = new MemFs({ lenient: true });
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        contextId: conv,
      },
    );
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.reason).toContain("no hay sesiones activas");
    expect(result.refuge_path).toBeNull();
    expect(await fs.exists(refugeDir)).toBe(false);
    expect(fs.writes.size).toBe(0);
  });

  it("compactar dos veces la misma conversación deja UN refugio, no una pila", async () => {
    const fs = seedActive("020-a-quick", "044-b-plan-exec");
    const env = new FakeEnv("/home/u", "/cwd");
    const first = await runCheckpointWrite(fs, env, new FakeGit(), paths, { contextId: conv });
    const second = await runCheckpointWrite(fs, env, new FakeGit(), paths, { contextId: conv });
    if (!("continuity" in first) || !("continuity" in second)) throw new Error("expected degraded");
    expect(second.refuge_path).toBe(first.refuge_path);
    expect(await fs.list(refugeDir)).toHaveLength(1);
  });

  // Misma regla sin identidad de conversación: el nombre con sello de tiempo
  // hacía crecer `.refuge/` sin techo, un archivo por compactación, en un
  // directorio que nada barre.
  it("compactar dos veces SIN conversación también deja UN refugio, con el último motivo", async () => {
    const fs = seedActive("020-a-quick", "044-b-plan-exec");
    const env = new FakeEnv("/home/u", "/cwd");
    const first = await runCheckpointWrite(fs, env, new FakeGit(), paths, {});
    const second = await runCheckpointWrite(fs, env, new FakeGit(), paths, {});
    if (!("continuity" in first) || !("continuity" in second)) throw new Error("expected degraded");
    expect(first.refuge_path).toBe(".workflow/sessions/.refuge/desconocida.md");
    expect(second.refuge_path).toBe(first.refuge_path);
    expect(await fs.list(refugeDir)).toHaveLength(1);
    expect(await fs.readText(`${refugeDir}/desconocida.md`)).toContain(
      "- Conversación: desconocida",
    );
  });
});

/**
 * La otra corrida gana la escritura del CHECKPOINT: las dos leyeron el mismo
 * contenido previo y en disco queda lo de la última. El doble lo hace
 * determinista — pisa la escritura de la adopción con el texto ajeno.
 */
class LostRaceFs extends MemFs {
  constructor(private readonly ajeno: string) {
    super({ lenient: true });
  }
  override async writeText(p: string, content: string): Promise<void> {
    if (p.endsWith("CHECKPOINT.md") && content.includes("## Refugio adoptado")) {
      return super.writeText(p, this.ajeno);
    }
    return super.writeText(p, content);
  }
}

/** Un refugio que no se deja borrar: permisos, o ya lo borró la otra corrida. */
class UnremovableRefugeFs extends MemFs {
  override async remove(p: string): Promise<void> {
    if (p.includes("/.refuge/")) throw new Error("EACCES: no se puede borrar el refugio");
    return super.remove(p);
  }
}

/** El CHECKPOINT no se puede escribir: la adopción es la única que lo intenta acá. */
class UnwritableCheckpointFs extends MemFs {
  override async writeText(p: string, content: string): Promise<void> {
    if (p.endsWith("CHECKPOINT.md")) throw new Error("ENOSPC: no se puede escribir CHECKPOINT.md");
    return super.writeText(p, content);
  }
}

describe("la adopción del refugio", () => {
  const folder = "044-b-plan-exec";
  const cpPath = `${sessionsDir}/${folder}/CHECKPOINT.md`;

  /** La sesión activa sobre un doble que ya viene elegido. */
  function seedOn<T extends MemFs>(fs: T): T {
    fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n`);
    fs.file(`${sessionsDir}/${folder}/TASKS.md`, "- [x] T1\n- [ ] T2\n");
    return fs;
  }

  it("la conversación que lo dejó se lo lleva al CHECKPOINT, y el refugio desaparece", async () => {
    const fs = seedActive(folder);
    const parked = await park(fs, conv);

    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        contextId: conv,
      },
    );
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.refuge_adopted).toEqual([parked]);

    const cp = await fs.readText(cpPath);
    expect(cp).toContain("## Refugio adoptado (");
    expect(cp).toContain("- Motivo: hay 2 sesiones activas");
    // Última sección del cuerpo —después de `## Refs`— y ADENTRO del sello, que
    // se recalcula: sumar sin dejar de ser salida propia del CLI. Apendear
    // detrás del sello convertía la plantilla en «contenido a preservar» y
    // congelaba el CHECKPOINT para el resto de la vida de la sesión.
    expect(cp.indexOf("## Refugio adoptado")).toBeGreaterThan(cp.indexOf("## Refs"));
    expect(cp.indexOf("## Refugio adoptado")).toBeLessThan(cp.indexOf("template sha256="));
    expect(isPristineCheckpoint(cp)).toBe(true);
    // Y el título del refugio no se cuela como segundo H1 del checkpoint.
    expect(cp).not.toContain("# CHECKPOINT de refugio");
    expect(await fs.exists(`${refugeDir}/${hashContextId(conv)}.md`)).toBe(false);
  });

  // El agujero que dejaba el append detrás del sello: la invocación SIGUIENTE
  // —el `/compact` que viene, o el SessionEnd— veía «contenido» donde sólo
  // había texto que el propio CLI había puesto, y preservaba para siempre.
  it("el PreCompact que sigue a una adopción vuelve a escribir el CHECKPOINT", async () => {
    const fs = seedActive(folder);
    const env = new FakeEnv("/home/u", "/cwd");
    await park(fs, conv);
    const adopcion = await runCheckpointWrite(fs, env, new FakeGit(), paths, {
      code: "044",
      contextId: conv,
    });
    if (!("checkpoint_path" in adopcion)) throw new Error(JSON.stringify(adopcion));
    expect(adopcion.refuge_adopted).toHaveLength(1);

    // Tercera corrida, la que ninguna prueba cubría.
    const despues = await runCheckpointWrite(fs, env, new FakeGit(), paths, { contextId: conv });
    if (!("checkpoint_path" in despues)) throw new Error(JSON.stringify(despues));
    expect(despues.preserved).toBeUndefined();
    expect(despues.skipped).toBeUndefined();
    expect(despues.lines_written).toBeGreaterThan(0);
    // Y regenerar no se lleva lo adoptado: el refugio ya no está en disco, así
    // que perder la sección sería perder el estado parqueado para siempre.
    const cp = await fs.readText(cpPath);
    expect(cp).toContain("## Refugio adoptado (");
    expect(cp).toContain("- Motivo: hay 2 sesiones activas");
    expect(isPristineCheckpoint(cp)).toBe(true);
    // Una sola sección: arrastrarla no la duplica en cada regeneración.
    expect(cp.match(/## Refugio adoptado \(/g)).toHaveLength(1);
  });

  it("--force después de una adopción regenera sin perder la sección adoptada", async () => {
    const fs = seedActive(folder);
    const env = new FakeEnv("/home/u", "/cwd");
    await park(fs, conv);
    await runCheckpointWrite(fs, env, new FakeGit(), paths, { code: "044", contextId: conv });

    const forzado = await runCheckpointWrite(fs, env, new FakeGit(), paths, {
      code: "044",
      contextId: conv,
      force: true,
    });
    if (!("checkpoint_path" in forzado)) throw new Error(JSON.stringify(forzado));
    expect(forzado.preserved).toBeUndefined();
    const cp = await fs.readText(cpPath);
    expect(cp).toContain("## Refugio adoptado (");
    expect(cp).toContain("- Motivo: hay 2 sesiones activas");
  });

  it("un CHECKPOINT con contenido se conserva ENTERO y la sección se suma al final", async () => {
    const fs = seedActive(folder);
    const env = new FakeEnv("/home/u", "/cwd");
    await runCheckpointWrite(fs, env, new FakeGit(), paths, {});
    const prosa = "Cerré el guard y lo verifiqué con un relleno parcial.";
    const filled = (await fs.readText(cpPath)).replace(
      "_[AI: 1-3 sentences on the last concrete progress. Review recent diffs and the latest entry in DECISIONS.md.]_",
      prosa,
    );
    await fs.writeText(cpPath, filled);
    const parked = await park(fs, conv);

    const result = await runCheckpointWrite(fs, env, new FakeGit(), paths, { contextId: conv });
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBe(true);
    expect(result.refuge_adopted).toEqual([parked]);

    const cp = await fs.readText(cpPath);
    // Byte a byte lo escrito, y la adopción detrás: preservar protege de
    // REGENERAR, no de sumar.
    expect(cp.startsWith(filled)).toBe(true);
    expect(cp).toContain(prosa);
    expect(cp.slice(filled.length)).toContain("## Refugio adoptado (");
  });

  it("el refugio de otra conversación queda intacto y sin adoptar", async () => {
    const fs = seedActive(folder);
    const ajeno = await park(fs, "conv-de-otro");

    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        contextId: conv,
      },
    );
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.refuge_adopted).toBeUndefined();
    expect(await fs.readText(cpPath)).not.toContain("Refugio adoptado");
    expect(await fs.exists(`/cwd/${ajeno}`)).toBe(true);
  });

  it("un refugio sin conversación lo adopta sólo quien nombra la sesión con --code", async () => {
    const fs = seedActive(folder);
    const env = new FakeEnv("/home/u", "/cwd");
    const anonimo = await park(fs);

    // Sin --code no hay nada que lo vincule a esta conversación: se queda.
    const sinCode = await runCheckpointWrite(fs, env, new FakeGit(), paths, { contextId: conv });
    if (!("checkpoint_path" in sinCode)) throw new Error(JSON.stringify(sinCode));
    expect(sinCode.refuge_adopted).toBeUndefined();
    expect(await fs.exists(`/cwd/${anonimo}`)).toBe(true);

    // Con --code, la persona ES la identidad que faltaba.
    const conCode = await runCheckpointWrite(fs, env, new FakeGit(), paths, {
      code: "044",
      contextId: conv,
    });
    if (!("checkpoint_path" in conCode)) throw new Error(JSON.stringify(conCode));
    expect(conCode.refuge_adopted).toEqual([anonimo]);
    expect(await fs.readText(cpPath)).toContain("## Refugio adoptado (");
    expect(await fs.exists(`/cwd/${anonimo}`)).toBe(false);
  });

  // La carrera: dos hooks del mismo checkout (un PreCompact y un SessionEnd)
  // leen el mismo CHECKPOINT y la última escritura gana. Borrar el refugio por
  // la fe de su propia escritura hacía desaparecer el estado parqueado de los
  // DOS lugares donde existía, sin error y con exit 0.
  it("si otra corrida gana la escritura del CHECKPOINT, el refugio NO se borra", async () => {
    const fs = seedOn(new LostRaceFs("# CHECKPOINT — lo escribió la otra corrida\n"));
    const parked = await park(fs, conv);

    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      { contextId: conv },
    );
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    // Ni adoptado ni perdido: el bloque no quedó en el archivo, así que el
    // refugio sigue en disco para que lo plieguen la próxima vez.
    expect(result.refuge_adopted).toBeUndefined();
    expect(await fs.exists(`/cwd/${parked}`)).toBe(true);
    expect(await fs.readText(`/cwd/${parked}`)).toContain("- Motivo: hay 2 sesiones activas");
  });

  // Adoptar es dejar el bloque en el CHECKPOINT; borrar el archivo es limpieza.
  // Si la limpieza falla, la corrida siguiente lo encuentra otra vez y no puede
  // volver a pegar el mismo texto.
  it("un refugio que no se pudo borrar no se adopta dos veces", async () => {
    const fs = seedOn(new UnremovableRefugeFs({ lenient: true }));
    const env = new FakeEnv("/home/u", "/cwd");
    const parked = await park(fs, conv);

    const primera = await runCheckpointWrite(fs, env, new FakeGit(), paths, {
      code: "044",
      contextId: conv,
    });
    if (!("checkpoint_path" in primera)) throw new Error(JSON.stringify(primera));
    expect(primera.refuge_adopted).toEqual([parked]);
    // El borrado falló, así que el archivo sigue ahí.
    expect(await fs.exists(`/cwd/${parked}`)).toBe(true);

    const segunda = await runCheckpointWrite(fs, env, new FakeGit(), paths, {
      code: "044",
      contextId: conv,
    });
    if (!("checkpoint_path" in segunda)) throw new Error(JSON.stringify(segunda));
    expect(segunda.refuge_adopted).toBeUndefined();
    const cp = await fs.readText(cpPath);
    expect(cp.match(/## Refugio adoptado \(/g)).toHaveLength(1);
  });

  // Las tres llamadas a la adopción quedan FUERA de todo try/catch, así que un
  // fallo de fs acá salía hasta el proceso: exit 1, o sea el host RETIENE su
  // compactación. Es el fallo irrecuperable que estas superficies dejaron de
  // poder provocar.
  it("una escritura fallida durante la adopción no tumba el hook ni se lleva el refugio", async () => {
    const fs = seedOn(new UnwritableCheckpointFs({ lenient: true }));
    // Con prosa adentro el CHECKPOINT se preserva: la única escritura que se
    // intenta sobre él es la de la adopción.
    fs.file(cpPath, "# CHECKPOINT — 044\n\nProsa de alguien.\n");
    const parked = await park(fs, conv);

    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      { contextId: conv },
    );
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBe(true);
    expect(result.refuge_adopted).toBeUndefined();
    expect(await fs.exists(`/cwd/${parked}`)).toBe(true);
  });
});
