import { describe, expect, it } from "vitest";
import {
  type FixGitPrepared,
  applyFixGit,
  commitFixGit,
  prepareFixGit,
  validateFixGit,
} from "../../src/application/fix-git-service.js";
import type { ConflictStage, ConflictStages, GitPort } from "../../src/ports/git.js";
import { MemFs } from "../helpers/mem-fs.js";

const REPO = "/repo";

function stage(content: string | null, hash: string | null = "a".repeat(40)): ConflictStage {
  return { hash, content, bytes: content === null ? 0 : Buffer.byteLength(content, "utf8") };
}

interface FakeOptions {
  merging?: boolean;
  isRepo?: boolean;
  conflicts?: string[];
  stages?: Record<string, ConflictStages>;
  stageThrowsOn?: string;
}

/**
 * Only the operations `fix-git` actually reaches. Everything else throws: the
 * point of the port extension was to NOT open a generic git surface, and a
 * fake that answers anything would hide a regression on that.
 */
class FakeGit implements Partial<GitPort> {
  readonly staged: string[] = [];
  readonly commits: string[] = [];
  conflicts: string[];

  constructor(private readonly options: FakeOptions = {}) {
    this.conflicts = options.conflicts ?? [];
  }

  async isGitRepo(): Promise<boolean> {
    return this.options.isRepo !== false;
  }
  async isMerging(): Promise<boolean> {
    return this.options.merging !== false;
  }
  async conflictedFiles(): Promise<string[]> {
    return [...this.conflicts];
  }
  async mergeOrigin(): Promise<string | undefined> {
    return "feature/x";
  }
  async currentBranch(): Promise<string | undefined> {
    return "main";
  }
  async conflictStages(_repo: string, path: string): Promise<ConflictStages> {
    const found = this.options.stages?.[path];
    if (found === undefined) throw new Error(`fixture sin stages para ${path}`);
    return found;
  }
  async stagePath(_repo: string, path: string): Promise<void> {
    if (this.options.stageThrowsOn === path) throw new Error("index.lock");
    this.staged.push(path);
    this.conflicts = this.conflicts.filter((c) => c !== path);
  }
  async commit(_repo: string, message: string): Promise<void> {
    this.commits.push(message);
  }
}

function textConflict(path: string, suffix = ""): ConflictStages {
  return {
    path,
    base: stage(`base${suffix}\n`, `1${"0".repeat(39)}`),
    ours: stage(`ours${suffix}\n`, `2${"0".repeat(39)}`),
    theirs: stage(`theirs${suffix}\n`, `3${"0".repeat(39)}`),
    binary: false,
  };
}

function git(paths: string[], overrides: Partial<FakeOptions> = {}): FakeGit {
  const stages: Record<string, ConflictStages> = {};
  for (const path of paths) stages[path] = textConflict(path);
  return new FakeGit({ conflicts: paths, stages, ...overrides });
}

function asPort(fake: FakeGit): GitPort {
  return fake as unknown as GitPort;
}

async function prepare(fake: FakeGit): Promise<FixGitPrepared> {
  const result = await prepareFixGit(asPort(fake), REPO, "cli");
  if (!result.ok) throw new Error(`expected prepare to succeed: ${result.failure.message}`);
  return result.value;
}

function answer(prepared: FixGitPrepared, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    operation: "fix-git",
    input_digest: prepared.request.input_digest,
    state: "proposed",
    artifacts: prepared.context.conflicts.map((c) => ({
      path: c.path,
      content: `resuelto ${c.path}\n`,
    })),
    ...over,
  });
}

// ── prepare ──────────────────────────────────────────────────────────────────

describe("prepareFixGit — read-only, and it refuses when there is nothing to do", () => {
  it("expone las tres versiones y sus hashes por archivo", async () => {
    const prepared = await prepare(git(["src/a.ts", "src/b.ts"]));
    expect(prepared.context.conflicts.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(prepared.context.conflicts[0]).toMatchObject({
      base_hash: `1${"0".repeat(39)}`,
      ours_hash: `2${"0".repeat(39)}`,
      theirs_hash: `3${"0".repeat(39)}`,
      binary: false,
    });
    expect(prepared.request.allowed_destinations).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("no stagea ni commitea nada", async () => {
    const fake = git(["src/a.ts"]);
    await prepare(fake);
    expect(fake.staged).toEqual([]);
    expect(fake.commits).toEqual([]);
  });

  it("rechaza un repo que no está en medio de un merge", async () => {
    const result = await prepareFixGit(asPort(git([], { merging: false })), REPO, null);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("NOT_MERGING");
  });

  it("rechaza un merge sin conflictos vigentes", async () => {
    const result = await prepareFixGit(asPort(git([])), REPO, null);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("NO_CONFLICTS");
  });

  it("rechaza un directorio que no es repo", async () => {
    const result = await prepareFixGit(asPort(git([], { isRepo: false })), REPO, null);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("NOT_A_REPO");
  });
});

// ── validate ─────────────────────────────────────────────────────────────────

describe("validateFixGit — the conflict set is the whole write boundary", () => {
  it("acepta una resolución completa e inequívoca", async () => {
    const prepared = await prepare(git(["src/a.ts", "src/b.ts"]));
    const result = validateFixGit(answer(prepared), prepared);
    if (!result.ok) throw new Error(`expected it to validate: ${result.failure.message}`);
    expect(result.value.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rechaza una resolución parcial", async () => {
    const prepared = await prepare(git(["src/a.ts", "src/b.ts"]));
    const result = validateFixGit(
      answer(prepared, { artifacts: [{ path: "src/a.ts", content: "solo uno\n" }] }),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("FIX_GIT_INCOMPLETE");
    expect(result.failure.message).toContain("src/b.ts");
  });

  it("rechaza un path que no está en conflicto", async () => {
    const prepared = await prepare(git(["src/a.ts"]));
    const result = validateFixGit(
      answer(prepared, {
        artifacts: [
          { path: "src/a.ts", content: "ok\n" },
          { path: "src/otro.ts", content: "de contrabando\n" },
        ],
      }),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_PATH_REJECTED");
    expect(result.failure.message).toContain("src/otro.ts");
  });

  const markers = ["<<<<<<< HEAD\na\n", "hola\n=======\nchau\n", ">>>>>>> feature/x\n"];

  it.each(markers)("rechaza contenido que conserva marcadores (%j)", async (content) => {
    const prepared = await prepare(git(["src/a.ts"]));
    const result = validateFixGit(
      answer(prepared, { artifacts: [{ path: "src/a.ts", content }] }),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("FIX_GIT_MARKERS_LEFT");
  });

  it("devuelve la ambigüedad como elección, no como escritura", async () => {
    const prepared = await prepare(git(["src/a.ts"]));
    const result = validateFixGit(
      answer(prepared, { state: "ambiguous", reason: "las dos ramas cambian la misma regla" }),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_AMBIGUOUS");
    expect(result.failure.message).toContain("misma regla");
  });

  it("nunca resuelve un binario automáticamente", async () => {
    const binary: ConflictStages = {
      path: "assets/logo.png",
      base: stage(null, `1${"0".repeat(39)}`),
      ours: stage(null, `2${"0".repeat(39)}`),
      theirs: stage(null, `3${"0".repeat(39)}`),
      binary: true,
    };
    const fake = new FakeGit({
      conflicts: ["assets/logo.png"],
      stages: { "assets/logo.png": binary },
    });
    const prepared = await prepare(fake);
    const result = validateFixGit(
      answer(prepared, { artifacts: [{ path: "assets/logo.png", content: "texto\n" }] }),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("FIX_GIT_BINARY");
  });
});

// ── apply ────────────────────────────────────────────────────────────────────

describe("applyFixGit — writes and stages only what is still in conflict", () => {
  it("escribe, stagea y deja el merge sin conflictos restantes", async () => {
    const fs = new MemFs();
    const fake = git(["src/a.ts", "src/b.ts"]);
    const prepared = await prepare(fake);
    const validated = validateFixGit(answer(prepared), prepared);
    if (!validated.ok) throw new Error("expected it to validate");

    const result = await applyFixGit(fs, asPort(fake), prepared, validated.value);
    if (!result.ok) throw new Error(`expected it to apply: ${result.failure.message}`);
    expect(result.value.staged).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.value.remaining).toEqual([]);
    expect(await fs.readText("/repo/src/a.ts")).toBe("resuelto src/a.ts\n");
    expect(fake.commits).toEqual([]);
  });

  // The conflict another process already settled is not ours to overwrite.
  it("rechaza cuando el set de conflictos cambió desde el prepare", async () => {
    const fs = new MemFs();
    const fake = git(["src/a.ts", "src/b.ts"]);
    const prepared = await prepare(fake);
    const validated = validateFixGit(answer(prepared), prepared);
    if (!validated.ok) throw new Error("expected it to validate");

    fake.conflicts = ["src/a.ts"]; // someone resolved b.ts meanwhile

    const result = await applyFixGit(fs, asPort(fake), prepared, validated.value);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_STALE");
    expect(fake.staged).toEqual([]);
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("un git add fallido deja el resto identificable en vez de mentir", async () => {
    const fs = new MemFs();
    const fake = git(["src/a.ts", "src/b.ts"], { stageThrowsOn: "src/b.ts" });
    const prepared = await prepare(fake);
    const validated = validateFixGit(answer(prepared), prepared);
    if (!validated.ok) throw new Error("expected it to validate");

    const result = await applyFixGit(fs, asPort(fake), prepared, validated.value);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("FIX_GIT_STAGE_FAILED");
    expect(result.failure.action).toContain("git status");
    expect(fake.staged).toEqual(["src/a.ts"]);
  });
});

// ── commit ───────────────────────────────────────────────────────────────────

describe("commitFixGit — a separate action that refuses to close a broken merge", () => {
  it("cierra el merge cuando no quedan conflictos", async () => {
    const fake = git([]);
    const result = await commitFixGit(asPort(fake), REPO, "merge: resolver conflictos");
    if (!result.ok) throw new Error(`expected it to commit: ${result.failure.message}`);
    expect(fake.commits).toEqual(["merge: resolver conflictos"]);
  });

  it("se niega mientras queden archivos sin resolver", async () => {
    const fake = git(["src/a.ts"]);
    const result = await commitFixGit(asPort(fake), REPO, "merge");
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("FIX_GIT_UNMERGED");
    expect(fake.commits).toEqual([]);
  });
});
