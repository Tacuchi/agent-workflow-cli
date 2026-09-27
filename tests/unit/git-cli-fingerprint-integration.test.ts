import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";

/**
 * Real git and a real pipe. What is asserted is that the fingerprint hashes the
 * bytes git emitted, and that no single entry of a working tree can take the
 * whole checkout down — neither answerable with a fake process.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const DIFF_ARGS = ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"];
const STATUS_ARGS = ["status", "--porcelain=v2", "-z"];

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf-8", env: GIT_ENV }).trim();

const emitted = (repo: string, args: string[]): Buffer =>
  execFileSync("git", args, { cwd: repo, env: GIT_ENV, maxBuffer: 1 << 30 });

/** 15 bytes: an ODD unit, so no repetition of it aligns with the 64 KB boundary. */
const MULTIBYTE_UNIT = "áéíóúñ…";
/** ~4.5 MB — some 70 chunks, every boundary a chance to split a character in half. */
const DIRTY_CONTENT = `${MULTIBYTE_UNIT.repeat(300_000)}\n`;

const repos: string[] = [];

function repoWith(content: string): string {
  const repo = mkdtempSync(join(tmpdir(), "aw-fingerprint-"));
  repos.push(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "doc.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "base");
  writeFileSync(join(repo, "doc.md"), content);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("lectura de git sobre un árbol sucio grande y multibyte", () => {
  it("NodeProcess.run devuelve exactamente los bytes que git emitió", async () => {
    const repo = repoWith(DIRTY_CONTENT);
    const bytes = emitted(repo, DIFF_ARGS);
    const read = await new NodeProcess().run("git", DIFF_ARGS, { cwd: repo, env: GIT_ENV });

    expect(Buffer.byteLength(read.stdout, "utf8")).toBe(bytes.length);
    expect(createHash("sha256").update(read.stdout, "utf8").digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  }, 30_000);

  it("checkoutFingerprint hashea esos bytes, y dos veces da lo mismo", async () => {
    const repo = repoWith(DIRTY_CONTENT);
    // Sin archivos sin trackear, la huella es exactamente parche + status.
    const oracle = createHash("sha256")
      .update("patch\0", "utf8")
      .update(emitted(repo, DIFF_ARGS))
      .update("status\0", "utf8")
      .update(emitted(repo, STATUS_ARGS))
      .digest("hex");

    const adapter = new GitCliAdapter(new NodeProcess());
    expect(await adapter.checkoutFingerprint(repo)).toBe(`sha256:${oracle}`);
    expect(await adapter.checkoutFingerprint(repo)).toBe(`sha256:${oracle}`);
  }, 30_000);
});

describe("checkoutFingerprint — un untracked que git no puede hashear", () => {
  it("deja huella igual, en vez de tirar el checkout entero", async () => {
    const repo = repoWith("sucio\n");
    // `ls-files --others` lo lista y `hash-object` sale 128: sin esto, el throw
    // borraba la fuente del conjunto elegible y la prueba salía INVALID.
    symlinkSync("/nonexistent-target", join(repo, "roto.lnk"));

    const adapter = new GitCliAdapter(new NodeProcess());
    const first = await adapter.checkoutFingerprint(repo);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await adapter.checkoutFingerprint(repo)).toBe(first);
  });

  it("sigue distinguiendo el árbol cuando el enlace pasa a ser hasheable", async () => {
    const repo = repoWith("sucio\n");
    symlinkSync("/nonexistent-target", join(repo, "roto.lnk"));
    const adapter = new GitCliAdapter(new NodeProcess());
    const broken = await adapter.checkoutFingerprint(repo);

    rmSync(join(repo, "roto.lnk"));
    writeFileSync(join(repo, "roto.lnk"), "ahora es un archivo\n");
    expect(await adapter.checkoutFingerprint(repo)).not.toBe(broken);
  });
});

describe("scopedFingerprint — el contenido bajo una raíz, sin HEAD ni vecinos", () => {
  function hub(): { repo: string; root: string } {
    const repo = mkdtempSync(join(tmpdir(), "aw-scoped-"));
    repos.push(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    execFileSync("mkdir", ["-p", join(repo, "ws", ".sesiones"), join(repo, "vecino")]);
    writeFileSync(join(repo, "ws", "doc.md"), "base\n");
    writeFileSync(join(repo, "vecino", "doc.md"), "vecino\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "base");
    return { repo, root: join(repo, "ws") };
  }
  const adapter = new GitCliAdapter(new NodeProcess());
  const scoped = (root: string) => adapter.scopedFingerprint(root, [".sesiones"]);

  it("ni un vecino, ni un commit que no cambia bytes bajo la raíz, ni la carpeta excluida la mueven", async () => {
    const { repo, root } = hub();
    const base = await scoped(root);
    writeFileSync(join(repo, "vecino", "doc.md"), "otro trabajo\n");
    git(repo, "commit", "--quiet", "-am", "vecino");
    writeFileSync(join(root, ".sesiones", "CHECKPOINT.md"), "no ignorada por .gitignore\n");
    expect(await scoped(root)).toBe(base);
  });

  it("un cambio bajo la raíz la mueve, y commitearlo no la vuelve a mover", async () => {
    const { repo, root } = hub();
    const base = await scoped(root);
    writeFileSync(join(root, "doc.md"), "cambio propio\n");
    const changed = await scoped(root);
    expect(changed).not.toBe(base);
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "propio");
    expect(await scoped(root)).toBe(changed);
    writeFileSync(join(root, "nuevo.md"), "sin rastrear\n");
    expect(await scoped(root)).not.toBe(changed);
  });

  it("borrar un archivo rastreado la mueve, y una entrada que git no puede hashear no la tumba", async () => {
    const { root } = hub();
    const base = await scoped(root);
    rmSync(join(root, "doc.md"));
    const deleted = await scoped(root);
    expect(deleted).not.toBe(base);
    // Un symlink colgante hace fallar `--stdin-paths`: el respaldo por archivo
    // la registra como no hasheable y la huella sigue siendo reproducible.
    symlinkSync(join(root, "no-existe"), join(root, "colgante"));
    const dangling = await scoped(root);
    expect(dangling).not.toBe(deleted);
    expect(await scoped(root)).toBe(dangling);
  });
});
