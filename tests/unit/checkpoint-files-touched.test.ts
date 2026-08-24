import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import {
  CONTEXTUAL_LIMIT,
  type TouchedFile,
  collectFilesTouched,
  totalInScope,
} from "../../src/application/checkpoint/files-touched.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import type { GitPort, LocalChange, NumstatCounts } from "../../src/ports/git.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Real git and a real nested workspace, because the defect this closes is not
 * expressible with a fake: the scope came from whatever repository git derived
 * from the process's directory, and only an actual hub with an actual sibling
 * project can show that a checkpoint listed somebody else's work.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf-8", env: GIT_ENV }).trim();

const hubs: string[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) rmSync(hub, { recursive: true, force: true });
});

const PLAN = "docs/plans/037-plan.md";

/** A workspace nested in a hub, with a noisy sibling project alongside it. */
function nestedHub(): { workspace: string; sessionPath: string; hub: string } {
  const hub = mkdtempSync(join(tmpdir(), "aw-hub-"));
  hubs.push(hub);
  const workspace = join(hub, "projects", "ws");
  const sibling = join(hub, "projects", "other");
  mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(sibling, { recursive: true });

  git(hub, "init", "--quiet", "--initial-branch=main");
  // Faithful to a real workspace: session artifacts are ignored, so they can
  // never appear in the inventory. That is exactly why the paths a session
  // claims have to come from its custody record and not from its own folder.
  writeFileSync(join(workspace, ".gitignore"), ".workflow/sessions/\n");
  writeFileSync(join(workspace, "src", "tracked.ts"), "export const a = 1;\n");
  // The sibling's files are committed FIRST so their later edits are ordinary
  // uncommitted changes — exactly the 718 foreign entries of the incident.
  for (let i = 0; i < 25; i += 1) {
    writeFileSync(join(sibling, `file${i}.ts`), "base\n");
  }
  git(hub, "add", "-A");
  git(hub, "commit", "--quiet", "-m", "base");

  // Now: the session's own work, plus a lot of noise that is not its own.
  writeFileSync(join(workspace, "src", "tracked.ts"), "export const a = 2;\nexport const b = 3;\n");
  writeFileSync(join(workspace, PLAN), "# Plan 037\nline\nline\n");
  for (let i = 0; i < 25; i += 1) {
    writeFileSync(join(sibling, `file${i}.ts`), `changed by somebody else ${i}\n`);
  }

  const sessionPath = join(workspace, ".workflow", "sessions", "149-demo-plan-exec");
  mkdirSync(sessionPath, { recursive: true });
  return { workspace, sessionPath, hub };
}

function writeCustody(
  sessionPath: string,
  extra: { artifacts?: string[]; sources?: Array<Record<string, unknown>> } = {},
): void {
  writeFileSync(
    join(sessionPath, ".custody.json"),
    JSON.stringify({
      version: 1,
      subject: { kind: "session", key: "149-demo-plan-exec" },
      subject_path: sessionPath,
      parents: [],
      created: "2026-08-23",
      artifacts: (extra.artifacts ?? []).map((path) => ({
        path,
        role: "output",
        before: { existed: false, digest: null, bytes: null, content: null },
      })),
      sources: extra.sources ?? [],
      effects: [],
      digest: "x",
    }),
  );
}

const realGit = (): GitPort => new GitCliAdapter(new NodeProcess()) as unknown as GitPort;
const realFs = (): FileSystemPort => new NodeFileSystem() as unknown as FileSystemPort;

const paths = (entries: TouchedFile[]): string[] => entries.map((e) => e.path);

describe("inventario acotado al workspace, sobre git real (spec 038 · F1)", () => {
  it("AC-01/AC-02: incluye el archivo no trackeado de la sesión y excluye al proyecto hermano", async () => {
    const { workspace, sessionPath } = nestedHub();
    writeCustody(sessionPath, { artifacts: [PLAN] });

    const touched = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);

    // The file the session just created — invisible to `git diff HEAD` because
    // it has no entry there at all, and the very thing the incident was about.
    expect(paths(touched.linked)).toEqual([PLAN]);
    expect(touched.linked[0]?.untracked).toBe(true);
    // The tracked edit inside the boundary is there too, as context.
    expect(paths(touched.contextual)).toContain("src/tracked.ts");
    // And not one path from the sibling project, whatever it did.
    const everything = [...paths(touched.linked), ...paths(touched.contextual)].join("\n");
    expect(everything).not.toContain("other");
    expect(everything).not.toContain("..");
    // The session's own folder is ignored by git, so it never inflates the count.
    expect(everything).not.toContain(".workflow");
    expect(totalInScope(touched)).toBe(2);
  });

  it("AC-03/AC-04: declara el límite y la referencia, que es el commit vigente del árbol", async () => {
    const { workspace, sessionPath, hub } = nestedHub();
    writeCustody(sessionPath, { artifacts: [PLAN] });

    const touched = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);

    expect(touched.observed).toHaveLength(1);
    expect(touched.observed[0]?.alias).toBe("workspace");
    expect(touched.observed[0]?.boundary).toBe(workspace);
    expect(touched.observed[0]?.reference).toBe(git(hub, "rev-parse", "HEAD"));
    expect(touched.unobserved).toEqual([]);
  });

  it("T3.4: cuenta las líneas del no trackeado, que `git diff HEAD` no sabe contar", async () => {
    const { workspace, sessionPath } = nestedHub();
    writeCustody(sessionPath, { artifacts: [PLAN] });

    const touched = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);

    // `--no-index` exits 1 to report differences; read as failure, this is null.
    expect(touched.linked[0]?.added).toBe("3");
    expect(touched.linked[0]?.removed).toBe("0");
    const tracked = touched.contextual.find((e) => e.path === "src/tracked.ts");
    expect(tracked?.added).toBe("2");
    expect(tracked?.removed).toBe("1");
  });

  it("T3.4: una ruta con acentos conserva sus cifras, que git entrecomilla sin `-z`", async () => {
    const { workspace, sessionPath } = nestedHub();
    // Without `-z`, git answers `"a\303\261o \303\261.txt"` for a path asked
    // about as `año ñ.txt`, the lookup misses, and the file silently loses its
    // counts. `localChanges` reads with `-z`, so both sides must agree.
    writeFileSync(join(workspace, "src", "año ñ.ts"), "uno\ndos\n");
    git(workspace, "add", "--", "src/año ñ.ts");
    git(workspace, "commit", "--quiet", "-m", "acentos");
    writeFileSync(join(workspace, "src", "año ñ.ts"), "uno\ndos\ntres\n");
    writeCustody(sessionPath, { artifacts: [PLAN] });

    const touched = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);

    const acentuado = touched.contextual.find((e) => e.path === "src/año ñ.ts");
    expect(acentuado).toBeDefined();
    expect(acentuado?.added).toBe("1");
    expect(acentuado?.removed).toBe("0");
  });

  it("AC-07: dos lecturas del mismo árbol dan el mismo conjunto y el mismo orden", async () => {
    const { workspace, sessionPath } = nestedHub();
    writeCustody(sessionPath, { artifacts: [PLAN] });

    const a = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);
    const b = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);
    expect(b).toEqual(a);
  });

  it("una sesión sin custodia degrada al workspace y no vincula nada", async () => {
    const { workspace, sessionPath } = nestedHub();
    // No .custody.json at all: the legacy case.
    const touched = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);

    expect(touched.linked).toEqual([]);
    expect(paths(touched.contextual)).toEqual([PLAN, "src/tracked.ts"]);
    expect(touched.unobserved).toEqual([]);
  });

  it("AC-06: una unidad fuente declarada que no se puede observar se nombra, y el parcial se publica", async () => {
    const { workspace, sessionPath } = nestedHub();
    writeCustody(sessionPath, {
      artifacts: [PLAN],
      sources: [
        {
          alias: "agent-workflow-cli",
          path: join(workspace, "no-existe"),
          branch: "main",
          baseline_head: null,
          unit_branch: null,
          unit_path: null,
          dirty_digest: "x",
          dirty_paths: [],
        },
      ],
    });

    const touched = await collectFilesTouched(realFs(), realGit(), workspace, sessionPath);

    expect(touched.unobserved).toHaveLength(1);
    expect(touched.unobserved[0]?.alias).toBe("agent-workflow-cli");
    expect(touched.unobserved[0]?.reason).not.toBe("");
    // The workspace's own inventory survives the other unit's failure.
    expect(paths(touched.linked)).toEqual([PLAN]);
    expect(touched.observed.map((u) => u.alias)).toEqual(["workspace"]);
  });
});

// ── the policy itself, where a fake is the honest tool ───────────────────────

function fakeGit(changes: Record<string, LocalChange[]>): GitPort {
  return {
    async repoPrefix(): Promise<string | null> {
      return "";
    },
    async localChanges(repo: string): Promise<LocalChange[]> {
      const found = changes[repo];
      if (found === undefined) throw new Error(`git status failed in ${repo}`);
      return found;
    },
    async head(): Promise<string | null> {
      return "abc1234def";
    },
    async numstatFor(): Promise<Record<string, NumstatCounts>> {
      return {};
    },
  } as unknown as GitPort;
}

const change = (path: string, untracked = false): LocalChange => ({
  path,
  from: null,
  code: untracked ? "??" : "M.",
  staged: !untracked,
  unstaged: false,
  untracked,
  head_mode: untracked ? null : "100644",
  worktree_mode: "100644",
});

describe("orden y recorte del inventario (spec 038 · F2/F3)", () => {
  const sessionPath = "/ws/.workflow/sessions/149-demo";

  function fsWith(custody: object | null): FileSystemPort {
    return {
      async exists(path: string): Promise<boolean> {
        return custody !== null && path.endsWith(".custody.json");
      },
      async readText(): Promise<string> {
        return JSON.stringify(custody);
      },
    } as unknown as FileSystemPort;
  }

  const custodyFor = (artifacts: string[], sources: Array<Record<string, unknown>> = []) => ({
    version: 1,
    subject: { kind: "session", key: "149-demo" },
    subject_path: sessionPath,
    parents: [],
    created: "2026-08-23",
    artifacts: artifacts.map((path) => ({
      path,
      role: "output",
      before: { existed: false, digest: null, bytes: null, content: null },
    })),
    sources,
    effects: [],
    digest: "x",
  });

  it("AC-05: el tope acota sólo lo contextual y nunca desplaza una ruta vinculada", async () => {
    const noise = Array.from({ length: 50 }, (_, i) =>
      change(`src/file${String(i).padStart(2, "0")}.ts`),
    );
    const touched = await collectFilesTouched(
      fsWith(custodyFor(["mine.md"])),
      fakeGit({ "/ws": [...noise, change("mine.md", true)] }),
      "/ws",
      sessionPath,
    );

    expect(paths(touched.linked)).toEqual(["mine.md"]);
    expect(touched.contextual).toHaveLength(CONTEXTUAL_LIMIT);
    expect(touched.omitted).toEqual([{ unit: "workspace", count: 50 - CONTEXTUAL_LIMIT }]);
    // The whole scope is reported, not merely what fitted on screen.
    expect(totalInScope(touched)).toBe(51);
  });

  it("AC-01: las rutas de una unidad declarada entran, con su alias y detrás del workspace", async () => {
    const touched = await collectFilesTouched(
      fsWith(
        custodyFor(
          ["mine.md"],
          [
            {
              alias: "agent-workflow-cli",
              path: "/src/cli",
              branch: "main",
              baseline_head: null,
              unit_branch: "aw/149",
              unit_path: "/units/cli",
              dirty_digest: "x",
              dirty_paths: [],
            },
          ],
        ),
      ),
      fakeGit({ "/ws": [change("z.md")], "/units/cli": [change("src/a.ts")] }),
      "/ws",
      sessionPath,
    );

    // The isolation unit is what gets read, not the shared source checkout.
    expect(touched.observed.map((u) => u.boundary)).toEqual(["/ws", "/units/cli"]);
    expect(touched.contextual.map((e) => `${e.unit}:${e.path}`)).toEqual([
      "workspace:z.md",
      "agent-workflow-cli:src/a.ts",
    ]);
    // A source unit's path is never mistaken for a claimed workspace artifact.
    expect(touched.linked).toEqual([]);
  });

  it("AC-07: el orden es total, así que el orden en que git responda no lo cambia", async () => {
    const forward = await collectFilesTouched(
      fsWith(null),
      fakeGit({ "/ws": [change("b.ts"), change("a.ts"), change("c.ts")] }),
      "/ws",
      sessionPath,
    );
    const backward = await collectFilesTouched(
      fsWith(null),
      fakeGit({ "/ws": [change("c.ts"), change("b.ts"), change("a.ts")] }),
      "/ws",
      sessionPath,
    );
    expect(paths(forward.contextual)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(paths(backward.contextual)).toEqual(paths(forward.contextual));
  });

  it("AC-06: si el workspace mismo no se puede observar, se declara y no se finge limpio", async () => {
    const touched = await collectFilesTouched(fsWith(null), fakeGit({}), "/ws", sessionPath);

    expect(touched.observed).toEqual([]);
    expect(touched.unobserved).toHaveLength(1);
    expect(touched.unobserved[0]?.reason).toContain("git status failed in /ws");
    expect(totalInScope(touched)).toBe(0);
  });
});

// ── lo que la revisión de cierre encontró, fijado para que no vuelva ─────────

describe("hallazgos de la revisión de cierre (spec 038)", () => {
  const sessionPath = "/ws/.workflow/sessions/149-demo";

  function fsWith(raw: string | null): FileSystemPort {
    return {
      async exists(path: string): Promise<boolean> {
        return raw !== null && path.endsWith(".custody.json");
      },
      async readText(): Promise<string> {
        return raw ?? "";
      },
    } as unknown as FileSystemPort;
  }

  const custody = (extra: Record<string, unknown>) =>
    JSON.stringify({
      version: 1,
      subject: { kind: "session", key: "149-demo" },
      subject_path: sessionPath,
      parents: [],
      created: "2026-08-23",
      artifacts: [],
      sources: [],
      effects: [],
      digest: "x",
      ...extra,
    });

  it("una unidad sin unit_path NI path se declara inobservable, jamás corre en el cwd del proceso", async () => {
    // Reachable in practice: `isCustodyShape` only checks that `sources` is an
    // array, so a hand-edited or truncated custody reaches here unverified. The
    // old code passed `undefined` as the repo path, git then ran in the
    // PROCESS's directory, and another repository's files were published as
    // this unit's — the exact defect spec 038 exists to close.
    const touched = await collectFilesTouched(
      fsWith(custody({ sources: [{ alias: "cli", branch: "main" }] })),
      fakeGit({ "/ws": [change("a.md")] }),
      "/ws",
      sessionPath,
    );

    expect(touched.unobserved).toEqual([
      { alias: "cli", boundary: "(sin ruta)", reason: "la custodia no declara unit_path ni path" },
    ]);
    expect(touched.observed.map((u) => u.alias)).toEqual(["workspace"]);
    expect(paths(touched.contextual)).toEqual(["a.md"]);
  });

  it("una custodia ilegible se declara: nunca se confunde con no tener custodia", async () => {
    const touched = await collectFilesTouched(
      fsWith("{esto no es json"),
      fakeGit({ "/ws": [change("a.md")] }),
      "/ws",
      sessionPath,
    );

    expect(touched.unobserved).toHaveLength(1);
    expect(touched.unobserved[0]?.alias).toBe("custodia");
    expect(touched.unobserved[0]?.reason).toContain("no es JSON válido");
    // The workspace still gets read: one unreadable record is not a blackout.
    expect(paths(touched.contextual)).toEqual(["a.md"]);
  });

  it("el tope se reparte entre unidades: ninguna se queda en cero por el volumen de otra", async () => {
    // A plan-exec session does its real work in the isolation unit while the
    // workspace only churns docs. Slicing a workspace-first sort gave the whole
    // cap to the docs and printed ZERO files from the unit, all while the scope
    // line went on announcing that unit as observed.
    const docs = Array.from({ length: 25 }, (_, i) =>
      change(`docs/n${String(i).padStart(2, "0")}.md`),
    );
    const code = Array.from({ length: 25 }, (_, i) =>
      change(`src/real${String(i).padStart(2, "0")}.ts`),
    );
    const touched = await collectFilesTouched(
      fsWith(
        custody({
          sources: [
            {
              alias: "cli",
              path: "/src/cli",
              branch: "main",
              baseline_head: null,
              unit_branch: "aw/149",
              unit_path: "/units/cli",
              dirty_digest: "x",
              dirty_paths: [],
            },
          ],
        }),
      ),
      fakeGit({ "/ws": docs, "/units/cli": code }),
      "/ws",
      sessionPath,
    );

    const shownUnits = new Set(touched.contextual.map((e) => e.unit));
    expect(shownUnits).toEqual(new Set(["workspace", "cli"]));
    expect(touched.contextual).toHaveLength(CONTEXTUAL_LIMIT);
    // Half each, and the omission is attributed per unit rather than lumped.
    expect(touched.omitted).toEqual([
      { unit: "workspace", count: 15 },
      { unit: "cli", count: 15 },
    ]);
    expect(totalInScope(touched)).toBe(50);
  });

  it("una unidad fuente no puede llamarse `workspace`: se declara en vez de leer el repo equivocado", async () => {
    const touched = await collectFilesTouched(
      fsWith(
        custody({
          sources: [
            {
              alias: "workspace",
              path: "/otro",
              branch: "main",
              baseline_head: null,
              unit_branch: null,
              unit_path: null,
              dirty_digest: "x",
              dirty_paths: [],
            },
          ],
        }),
      ),
      fakeGit({ "/ws": [change("a.md")], "/otro": [change("b.md")] }),
      "/ws",
      sessionPath,
    );

    expect(touched.unobserved).toHaveLength(1);
    expect(touched.unobserved[0]?.reason).toContain("no puede llamarse workspace");
    expect(paths(touched.contextual)).toEqual(["a.md"]);
  });
});
