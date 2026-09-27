import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { git, worktreeFixture } from "../helpers/worktree-fixture.js";

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

it("termina un remove partido y recoge lo ignorado sin perder las dependencias de la fuente", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, "node_modules", "sentinel"), "survive");
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  git(f.repo, "worktree", "remove", unit.path);
  mkdirSync(join(unit.path, "target"), { recursive: true });
  writeFileSync(join(unit.path, "target", "build.txt"), "ignored");
  const result = await f.run("release");
  expect(result).toMatchObject({ released: true, residue_completed: true });
  expect(existsSync(unit.path)).toBe(false);
  expect(readFileSync(join(f.repo, "node_modules", "sentinel"), "utf8")).toBe("survive");
});

it("reclaim conserva una carpeta huérfana con un archivo propio y recoge la recuperable", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  git(f.repo, "worktree", "remove", unit.path);
  mkdirSync(join(unit.path, "target"), { recursive: true });
  writeFileSync(join(unit.path, "target", "compiled"), "ignored");
  writeFileSync(join(unit.path, "own.txt"), "unique");
  f.close();
  const retained = await f.run("reclaim");
  expect(retained).toMatchObject({
    retained: [
      expect.objectContaining({
        reason: "archivos_no_recuperables",
        detail: expect.stringContaining("own.txt"),
      }),
    ],
  });
  expect(readFileSync(join(unit.path, "own.txt"), "utf8")).toBe("unique");
  rmSync(join(unit.path, "own.txt"));
  expect(await f.run("reclaim")).toMatchObject({
    reclaimed: [expect.objectContaining({ path: unit.path })],
  });
  expect(existsSync(unit.path)).toBe(false);
});

it("nunca sigue un enlace colocado en la raíz de un remove partido", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  git(f.repo, "worktree", "remove", unit.path);
  symlinkSync(f.repo, unit.path, "dir");
  expect(await f.run("release")).toMatchObject({ error: "remove_blocked" });
  expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("base\n");
});

it("un archivo rastreado cambiado dentro de una carpeta ignorada no se borra", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  mkdirSync(join(f.repo, "target"));
  writeFileSync(join(f.repo, "target", "tracked"), "original\n");
  git(f.repo, "add", "-f", "target/tracked");
  git(f.repo, "commit", "-m", "tracked ignored path");
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  git(f.repo, "worktree", "remove", unit.path);
  mkdirSync(join(unit.path, "target"), { recursive: true });
  writeFileSync(join(unit.path, "target", "tracked"), "unique\n");
  expect(await f.run("release")).toMatchObject({
    error: "remove_blocked",
    message: expect.stringContaining("target/tracked"),
  });
  expect(readFileSync(join(unit.path, "target", "tracked"), "utf8")).toBe("unique\n");
});

it("elimina sólo la rama aw/* contenida en la base, aun con checkout en otra rama", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  writeFileSync(join(unit.path, "work.txt"), "committed");
  git(unit.path, "add", "work.txt");
  git(unit.path, "commit", "-m", "unit work");
  git(f.repo, "checkout", "-b", "elsewhere");
  const result = await f.run("integrate");
  expect(result).toMatchObject({ integrated: true, released: true, into: "main" });
  expect(git(f.repo, "branch", "--list", "aw/*")).toBe("");
  expect(git(f.repo, "branch", "--show-current")).toBe("elsewhere");
});

it("retiene la rama no contenida y la carpeta bloqueada sin borrar nada a la fuerza", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  writeFileSync(join(unit.path, "own.txt"), "unique");
  git(unit.path, "add", "own.txt");
  git(unit.path, "commit", "-m", "unmerged");
  f.deps.git = new (class extends GitCliAdapter {
    override async worktreeRemove(): Promise<void> {
      throw new Error("EPERM file blocked");
    }
  })(new NodeProcess());
  const blocked = await f.run("release");
  expect(blocked).toMatchObject({
    error: "remove_blocked",
    message: expect.stringContaining(unit.path),
  });
  expect(existsSync(unit.path)).toBe(true);
  expect(git(f.repo, "branch", "--list", "aw/*")).toContain("aw/");
  f.deps.git = new GitCliAdapter(new NodeProcess());
  f.close();
  const released = await f.run("release");
  expect(released).toMatchObject({
    released: true,
    branch_kept: expect.stringContaining("no contenidos"),
  });
  expect(git(f.repo, "branch", "--list", "aw/*")).toContain("aw/");
});

it("completa el remove partido durante esta llamada, si sólo queda residuo ignorado", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  f.deps.git = new (class extends GitCliAdapter {
    override async worktreeRemove(repo: string, path: string): Promise<void> {
      await super.worktreeRemove(repo, path);
      mkdirSync(join(path, "target"), { recursive: true });
      writeFileSync(join(path, "target", "compiled"), "ignored");
      throw new Error("EPERM: la ruta quedó a medias");
    }
  })(new NodeProcess());
  expect(await f.run("release")).toMatchObject({ released: true, residue_completed: true });
  expect(existsSync(unit.path)).toBe(false);
});

it("integra y libera con la sesión cerrada sin reabrirla", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  writeFileSync(join(unit.path, "done.txt"), "finished");
  git(unit.path, "add", "done.txt");
  git(unit.path, "commit", "-m", "finished");
  f.close();
  expect(await f.run("integrate")).toMatchObject({ integrated: true, released: true });
  expect(existsSync(join(f.session, ".closed"))).toBe(true);
});

it("si la punta aw/* cambia tras probar la contención, el CAS conserva la rama", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  writeFileSync(join(f.repo, "main-change.txt"), "nuevo\n");
  git(f.repo, "add", "main-change.txt");
  git(f.repo, "commit", "-m", "main avanzó");
  const newer = git(f.repo, "rev-parse", "main");
  f.deps.git = new (class extends GitCliAdapter {
    override async deleteRef(repo: string, ref: string, expectedOld?: string) {
      git(repo, "update-ref", ref, newer);
      return super.deleteRef(repo, ref, expectedOld);
    }
  })(new NodeProcess());
  const result = await f.run("release");
  expect(result).toMatchObject({
    released: true,
    branch_kept: expect.stringContaining("no se pudo borrar"),
  });
  expect(git(f.repo, "rev-parse", unit.branch)).toBe(newer);
});
