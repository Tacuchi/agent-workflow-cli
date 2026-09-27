import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import {
  applyFixGit,
  prepareFixGit,
  validateFixGit,
} from "../../src/application/fix-git-service.js";

const gitAdapter = new GitCliAdapter(new NodeProcess());
const fs = new NodeFileSystem();
let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

function commit(file: string, content: string) {
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-q", "-m", `write ${file}`);
  return git("rev-parse", "HEAD");
}

function begin() {
  repo = mkdtempSync(join(tmpdir(), "aw-fixgit-real-"));
  git("init", "-q", "-b", "main");
  commit("a.txt", "base\n");
  commit("b.txt", "base\n");
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("fix-git en un merge real", () => {
  it("29 conflictos, incluido un lock grande: aplica dos subconjuntos dentro del camino sancionado", async () => {
    begin();
    const files = Array.from({ length: 28 }, (_, i) => `part-${String(i).padStart(2, "0")}.txt`);
    for (const file of files) writeFileSync(join(repo, file), "base\n");
    writeFileSync(join(repo, "package-lock.json"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "fixtures");
    git("checkout", "-q", "-b", "feature");
    for (const file of files) writeFileSync(join(repo, file), "theirs\n");
    writeFileSync(join(repo, "package-lock.json"), `${"t".repeat(1_100_000)}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "theirs");
    git("checkout", "-q", "main");
    for (const file of files) writeFileSync(join(repo, file), "ours\n");
    writeFileSync(join(repo, "package-lock.json"), `${"o".repeat(1_100_000)}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "ours");
    expect(() => git("merge", "feature")).toThrow();
    const first = await prepareFixGit(gitAdapter, repo, null);
    if (!first.ok) throw new Error(first.failure.message);
    expect(first.value.context.conflicts).toHaveLength(29);
    expect(first.value.request.metrics.request_bytes).toBeLessThan(100_000);
    const firstResponse = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: first.value.request.input_digest,
        state: "proposed",
        resolutions: [...files.slice(0, 14), "package-lock.json"].map((path) => ({
          path,
          choice: "theirs",
        })),
      }),
      first.value,
    );
    if (!firstResponse.ok) throw new Error(firstResponse.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, first.value, firstResponse.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(applied.value.remaining).toHaveLength(14);
    const second = await prepareFixGit(gitAdapter, repo, null);
    if (!second.ok) throw new Error(second.failure.message);
    const secondResponse = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: second.value.request.input_digest,
        state: "proposed",
        artifacts: files.slice(14).map((path) => ({ path, content: "both\n" })),
      }),
      second.value,
    );
    if (!secondResponse.ok) throw new Error(secondResponse.failure.message);
    const finished = await applyFixGit(fs, gitAdapter, second.value, secondResponse.value);
    if (!finished.ok) throw new Error(finished.failure.message);
    expect(finished.value.remaining).toEqual([]);
    expect(git("cat-file", "-s", ":package-lock.json")).toBe("1100001");
  }, 30_000);
  it("conserva el blob binario de ours sin fingir que es texto", async () => {
    begin();
    commit("image.bin", "base\0");
    git("checkout", "-q", "-b", "feature");
    commit("image.bin", "theirs\0");
    git("checkout", "-q", "main");
    commit("image.bin", "ours\0");
    expect(() => git("merge", "feature")).toThrow();
    const prepared = await prepareFixGit(gitAdapter, repo, null);
    if (!prepared.ok) throw new Error(prepared.failure.message);
    expect(prepared.value.context.conflicts[0]?.binary).toBe(true);
    const invalid = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: prepared.value.request.input_digest,
        state: "proposed",
        artifacts: [{ path: "image.bin", content: "texto" }],
      }),
      prepared.value,
    );
    expect(invalid).toMatchObject({ ok: false, failure: { code: "FIX_GIT_BINARY" } });
    const valid = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: prepared.value.request.input_digest,
        state: "proposed",
        resolutions: [{ path: "image.bin", choice: "ours" }],
      }),
      prepared.value,
    );
    if (!valid.ok) throw new Error(valid.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, prepared.value, valid.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(readFileSync(join(repo, "image.bin"))).toEqual(Buffer.from("ours\0"));
  });

  it("acepta contenido de 2 MiB para un lock grande, pero rechaza el que supera su tope por archivo", async () => {
    begin();
    commit("package-lock.json", "base\n");
    git("checkout", "-q", "-b", "feature");
    commit("package-lock.json", `${"t".repeat(1_100_000)}\n`);
    git("checkout", "-q", "main");
    commit("package-lock.json", `${"o".repeat(1_100_000)}\n`);
    expect(() => git("merge", "feature")).toThrow();
    const prepared = await prepareFixGit(gitAdapter, repo, null);
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const max = prepared.value.context.conflicts[0]?.max_bytes ?? 0;
    expect(max).toBeGreaterThan(2_000_000);
    const response = (content: string) =>
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: prepared.value.request.input_digest,
        state: "proposed",
        artifacts: [{ path: "package-lock.json", content }],
      });
    const tooLarge = validateFixGit(response("z".repeat(max + 1)), prepared.value);
    expect(tooLarge).toMatchObject({
      ok: false,
      failure: {
        message: expect.stringContaining(String(max)),
        action: expect.stringContaining("ours|theirs"),
      },
    });
    const valid = validateFixGit(response("z".repeat(2_000_000)), prepared.value);
    if (!valid.ok) throw new Error(valid.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, prepared.value, valid.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(git("cat-file", "-s", ":package-lock.json")).toBe("2000000");
  });

  it("core.autocrlf y .gitattributes gobiernan árbol y blob, sin duplicar CR", async () => {
    begin();
    git("config", "core.autocrlf", "true");
    commit(".gitattributes", "lf.txt text eol=lf\nraw.txt -text\n");
    commit("lf.txt", "base\n");
    commit("auto.txt", "base\n");
    commit("raw.txt", "base\r\n");
    git("checkout", "-q", "-b", "feature");
    commit("lf.txt", "theirs\n");
    commit("auto.txt", "theirs\n");
    commit("raw.txt", "theirs\r\n");
    git("checkout", "-q", "main");
    commit("lf.txt", "ours\n");
    commit("auto.txt", "ours\n");
    commit("raw.txt", "ours\r\n");
    expect(() => git("merge", "feature")).toThrow();
    const prepared = await prepareFixGit(gitAdapter, repo, null);
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const answer = JSON.stringify({
      version: 1,
      operation: "fix-git",
      input_digest: prepared.value.request.input_digest,
      state: "proposed",
      artifacts: [
        { path: "lf.txt", content: "new\r\r\n" },
        { path: "auto.txt", content: "new\r\n" },
        { path: "raw.txt", content: "new\r\r\n" },
      ],
    });
    const valid = validateFixGit(answer, prepared.value);
    if (!valid.ok) throw new Error(valid.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, prepared.value, valid.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(readFileSync(join(repo, "lf.txt"), "utf8")).toBe("new\n");
    expect(git("show", ":lf.txt")).toBe("new");
    expect(readFileSync(join(repo, "auto.txt"), "utf8")).toBe("new\r\n");
    expect(execFileSync("git", ["show", ":auto.txt"], { cwd: repo }).toString()).toBe("new\n");
    expect(readFileSync(join(repo, "raw.txt"), "utf8")).toBe("new\r\n");
    expect(execFileSync("git", ["show", ":raw.txt"], { cwd: repo }).toString()).toBe("new\r\n");
  });
  it("acepta un archivo auto-mergeado limpio aunque git ya lo haya stageado", async () => {
    begin();
    const lines = Array.from({ length: 20 }, (_, i) => `línea ${i}\n`);
    commit("merged.txt", lines.join(""));
    git("checkout", "-q", "-b", "feature");
    commit("a.txt", "theirs\n");
    commit("merged.txt", ["FEATURE\n", ...lines.slice(1)].join(""));
    git("checkout", "-q", "main");
    commit("a.txt", "ours\n");
    commit("merged.txt", [...lines.slice(0, -1), "MAIN\n"].join(""));
    expect(() => git("merge", "feature")).toThrow();
    expect(git("ls-files", "-u", "--", "merged.txt")).toBe("");
    expect(git("diff", "--cached", "--name-only")).toContain("merged.txt");
    const prepared = await prepareFixGit(gitAdapter, repo, null, undefined, {
      adapt: ["merged.txt"],
    });
    if (!prepared.ok) throw new Error(prepared.failure.message);
    expect(prepared.value.request.allowed_destinations).toContain("merged.txt");
  });

  it("adapta un archivo limpio al terminar los conflictos y conserva su alcance sellado", async () => {
    begin();
    commit("adapted.txt", "import old\n");
    git("checkout", "-q", "-b", "feature");
    commit("a.txt", "their-a\n");
    git("checkout", "-q", "main");
    commit("a.txt", "our-a\n");
    expect(() => git("merge", "feature")).toThrow();
    const conflict = await prepareFixGit(gitAdapter, repo, null);
    if (!conflict.ok) throw new Error(conflict.failure.message);
    const resolution = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: conflict.value.request.input_digest,
        state: "proposed",
        resolutions: [{ path: "a.txt", choice: "ours" }],
      }),
      conflict.value,
    );
    if (!resolution.ok) throw new Error(resolution.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, conflict.value, resolution.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(applied.value.remaining).toEqual([]);
    const adapted = await prepareFixGit(gitAdapter, repo, null, undefined, {
      adapt: ["adapted.txt"],
    });
    if (!adapted.ok) throw new Error(adapted.failure.message);
    expect(adapted.value.request.scope).toEqual({ adapt: ["adapted.txt"] });
    const bad = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: adapted.value.request.input_digest,
        state: "proposed",
        artifacts: [{ path: "adapted.txt", content: "import new\n" }],
      }),
      adapted.value,
    );
    expect(bad).toMatchObject({ ok: false, failure: { code: "FIX_GIT_SCOPE_CHANGED" } });
    const good = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: adapted.value.request.input_digest,
        scope: { adapt: ["adapted.txt"] },
        state: "proposed",
        artifacts: [{ path: "adapted.txt", content: "import new\n" }],
      }),
      adapted.value,
    );
    if (!good.ok) throw new Error(good.failure.message);
    const done = await applyFixGit(fs, gitAdapter, adapted.value, good.value);
    if (!done.ok) throw new Error(done.failure.message);
    expect(git("show", ":adapted.txt")).toBe("import new");
    expect(git("rev-parse", "--verify", "MERGE_HEAD")).toBeTruthy();
  });

  it("resuelve una baja DU con delete sin revivirla", async () => {
    begin();
    git("checkout", "-q", "-b", "feature");
    git("rm", "-q", "a.txt");
    git("commit", "-q", "-m", "delete a");
    git("checkout", "-q", "main");
    commit("a.txt", "modified\n");
    expect(() => git("merge", "feature")).toThrow();
    const prepared = await prepareFixGit(gitAdapter, repo, null);
    if (!prepared.ok) throw new Error(prepared.failure.message);
    expect(prepared.value.context.conflicts[0]?.kind).toBe("UD");
    const validated = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: prepared.value.request.input_digest,
        state: "proposed",
        resolutions: [{ path: "a.txt", choice: "delete" }],
      }),
      prepared.value,
    );
    if (!validated.ok) throw new Error(validated.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, prepared.value, validated.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(applied.value.remaining).toEqual([]);
    expect(git("ls-files", "--", "a.txt")).toBe("");
    expect(await fs.exists(join(repo, "a.txt"))).toBe(false);
  });

  it("resuelve DU cuando ours no existe y rechaza la etapa ausente", async () => {
    begin();
    git("checkout", "-q", "-b", "feature");
    commit("a.txt", "their-new\n");
    git("checkout", "-q", "main");
    git("rm", "-q", "a.txt");
    git("commit", "-q", "-m", "ours deletes");
    expect(() => git("merge", "feature")).toThrow();
    const prepared = await prepareFixGit(gitAdapter, repo, null);
    if (!prepared.ok) throw new Error(prepared.failure.message);
    expect(prepared.value.context.conflicts[0]?.kind).toBe("DU");
    const candidate = (choice: string) =>
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: prepared.value.request.input_digest,
        state: "proposed",
        resolutions: [{ path: "a.txt", choice }],
      });
    const absent = validateFixGit(candidate("ours"), prepared.value);
    expect(absent).toMatchObject({
      ok: false,
      failure: { message: expect.stringContaining("delete") },
    });
    const deletion = validateFixGit(candidate("delete"), prepared.value);
    if (!deletion.ok) throw new Error(deletion.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, prepared.value, deletion.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(git("ls-files", "--", "a.txt")).toBe("");
  });
  it("delete nunca borra recursivamente un directorio que apareció tras prepare", async () => {
    begin();
    git("checkout", "-q", "-b", "feature");
    git("rm", "-q", "a.txt");
    git("commit", "-q", "-m", "delete a");
    git("checkout", "-q", "main");
    commit("a.txt", "modified\n");
    expect(() => git("merge", "feature")).toThrow();
    const prepared = await prepareFixGit(gitAdapter, repo, null);
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const valid = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: prepared.value.request.input_digest,
        state: "proposed",
        resolutions: [{ path: "a.txt", choice: "delete" }],
      }),
      prepared.value,
    );
    if (!valid.ok) throw new Error(valid.failure.message);
    rmSync(join(repo, "a.txt"));
    mkdirSync(join(repo, "a.txt"));
    writeFileSync(join(repo, "a.txt", "untracked.txt"), "ajeno\n");
    const applied = await applyFixGit(fs, gitAdapter, prepared.value, valid.value);
    expect(applied).toMatchObject({ ok: false, failure: { code: "FIX_GIT_PATH_CHANGED" } });
    expect(existsSync(join(repo, "a.txt", "untracked.txt"))).toBe(true);
    expect(git("ls-files", "-u", "--", "a.txt")).not.toBe("");
  });
  it("acepta sólo resoluciones, aplica parcialmente y después completa sin git add", async () => {
    begin();
    git("checkout", "-q", "-b", "feature");
    commit("a.txt", "their-a\n");
    commit("b.txt", "their-b\n");
    git("checkout", "-q", "main");
    commit("a.txt", "our-a\n");
    commit("b.txt", "our-b\n");
    expect(() => git("merge", "feature")).toThrow();
    const first = await prepareFixGit(gitAdapter, repo, null);
    if (!first.ok) throw new Error(first.failure.message);
    const response = JSON.stringify({
      version: 1,
      operation: "fix-git",
      input_digest: first.value.request.input_digest,
      state: "proposed",
      resolutions: [{ path: "a.txt", choice: "theirs" }],
    });
    const validated = validateFixGit(response, first.value);
    if (!validated.ok) throw new Error(validated.failure.message);
    const applied = await applyFixGit(fs, gitAdapter, first.value, validated.value);
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(applied.value.remaining).toEqual(["b.txt"]);
    expect(git("show", ":a.txt")).toBe("their-a");
    const second = await prepareFixGit(gitAdapter, repo, null);
    if (!second.ok) throw new Error(second.failure.message);
    const finish = validateFixGit(
      JSON.stringify({
        version: 1,
        operation: "fix-git",
        input_digest: second.value.request.input_digest,
        state: "proposed",
        artifacts: [{ path: "b.txt", content: "our-b\ntheir-b\n" }],
      }),
      second.value,
    );
    if (!finish.ok) throw new Error(finish.failure.message);
    const done = await applyFixGit(fs, gitAdapter, second.value, finish.value);
    if (!done.ok) throw new Error(done.failure.message);
    expect(done.value.remaining).toEqual([]);
    expect(git("show", ":b.txt")).toBe("our-b\ntheir-b");
  });
  it("no transporta blobs por defecto y --show repetible trae las tres versiones de cada archivo", async () => {
    begin();
    git("checkout", "-q", "-b", "feature");
    commit("a.txt", "their-a\n");
    commit("b.txt", "their-b\n");
    git("checkout", "-q", "main");
    commit("a.txt", "our-a\n");
    commit("b.txt", "our-b\n");
    expect(() => git("merge", "feature")).toThrow();
    const summary = await prepareFixGit(gitAdapter, repo, null);
    if (!summary.ok) throw new Error(summary.failure.message);
    expect(summary.value.context.conflicts.map((c) => c.kind)).toEqual(["UU", "UU"]);
    expect((await gitAdapter.conflictStages(repo, "a.txt")).ours.mode).toBe("100644");
    expect(summary.value.request.inventory).not.toHaveProperty("stages");
    expect(JSON.stringify(summary.value.request.inventory)).not.toContain("their-a");
    const shown = await prepareFixGit(gitAdapter, repo, null, undefined, {
      show: ["a.txt", "b.txt"],
    });
    if (!shown.ok) throw new Error(shown.failure.message);
    expect(
      (
        shown.value.request.inventory as {
          stages: Array<{ base: string; ours: string; theirs: string }>;
        }
      ).stages,
    ).toMatchObject([
      { base: "base\n", ours: "our-a\n", theirs: "their-a\n" },
      { base: "base\n", ours: "our-b\n", theirs: "their-b\n" },
    ]);
    expect(shown.value.request.input_digest).toBe(summary.value.request.input_digest);
  });

  it("avisa cuando dos bases de criss-cross obligan a git a construir una base virtual", async () => {
    begin();
    git("checkout", "-q", "-b", "left");
    const left = commit("left.txt", "left\n");
    git("checkout", "-q", "-b", "right", "main");
    commit("right.txt", "right\n");
    git("checkout", "-q", "left");
    git("merge", "-q", "--no-ff", "-m", "left takes right", "right");
    git("checkout", "-q", "right");
    git("merge", "-q", "--no-ff", "-m", "right takes old left", left);
    commit("a.txt", "right-new\n");
    git("checkout", "-q", "left");
    commit("a.txt", "left-new\n");
    expect(() => git("merge", "right")).toThrow();
    const result = await prepareFixGit(gitAdapter, repo, null);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.context.virtual_base?.bases).toHaveLength(2);
  });
});
