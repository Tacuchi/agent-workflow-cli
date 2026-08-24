import { describe, expect, it } from "vitest";
import { runCheckpointWrite } from "../../src/application/checkpoint-write-service.js";
import { PathsService } from "../../src/application/paths-service.js";
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
    // Non-pausable host (no --can-pause): the compaction goes ahead, Workline
    // writes nothing and declares degraded continuity with `primary_session: null`
    // — the active list is shown as candidates, never as an identity.
    if (!("skipped" in result) || !result.skipped) {
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
    expect(fs.writes.size).toBe(0);
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
