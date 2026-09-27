import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { git, worktreeFixture } from "../helpers/worktree-fixture.js";

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

it("enlaza dependencias iguales, ignora el symlink y no toca la fuente al liberar", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  mkdirSync(join(f.repo, "node_modules", "package"), { recursive: true });
  writeFileSync(join(f.repo, "node_modules", "package", "index.js"), "module.exports = 42;");
  writeFileSync(join(f.repo, "node_modules", "sentinel"), "survive");
  const unit = await f.run("ensure");
  expect(unit).toMatchObject({
    dependencies: { status: "linked", message: expect.stringContaining("npm ci vaciaría") },
  });
  if (!("path" in unit)) throw new Error("no unit");
  expect(readFileSync(join(unit.path, "node_modules", "package", "index.js"), "utf8")).toContain(
    "42",
  );
  expect(
    execFileSync("node", ["-e", "process.stdout.write(require.resolve('package'))"], {
      cwd: unit.path,
      encoding: "utf8",
    }),
  ).toBe(realpathSync(join(f.repo, "node_modules", "package", "index.js")));
  expect(git(unit.path, "status", "--porcelain")).toBe("");
  expect(git(unit.path, "check-ignore", "node_modules")).toBe("node_modules");
  rmSync(join(unit.path, "node_modules"));
  expect(await f.run("ensure")).toMatchObject({ dependencies: { status: "linked" } });
  expect(await f.run("release")).toMatchObject({ released: true });
  expect(readFileSync(join(f.repo, "node_modules", "sentinel"), "utf8")).toBe("survive");
});

it("reclaim libera el enlace de una sesión cerrada y deja intactas las dependencias fuente", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, "node_modules", "sentinel"), "survive");
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  f.close();
  expect(await f.run("reclaim")).toMatchObject({
    reclaimed: [expect.objectContaining({ path: unit.path })],
  });
  expect(existsSync(unit.path)).toBe(false);
  expect(readFileSync(join(f.repo, "node_modules", "sentinel"), "utf8")).toBe("survive");
});

it("con lockfile distinto no enlaza ni sustituye nada y explica cómo instalar", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, "node_modules", "sentinel"), "survive");
  writeFileSync(join(f.repo, "package-lock.json"), '{"lockfileVersion":4}\n');
  const unit = await f.run("ensure");
  expect(unit).toMatchObject({
    dependencies: { status: "not_linked", message: expect.stringContaining("npm ci") },
  });
  if (!("path" in unit)) throw new Error("no unit");
  expect(existsSync(join(unit.path, "node_modules"))).toBe(false);
  expect(readFileSync(join(f.repo, "node_modules", "sentinel"), "utf8")).toBe("survive");
});

it("una unidad sucia conserva su enlace; al integrar limpia no toca el centinela", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, "node_modules", "sentinel"), "survive");
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  writeFileSync(join(unit.path, "work.txt"), "pending");
  expect(await f.run("release")).toMatchObject({ error: "unit_not_clean" });
  expect(existsSync(join(unit.path, "node_modules", "sentinel"))).toBe(true);
  git(unit.path, "add", "work.txt");
  git(unit.path, "commit", "-m", "done");
  expect(await f.run("integrate")).toMatchObject({ integrated: true, released: true });
  expect(readFileSync(join(f.repo, "node_modules", "sentinel"), "utf8")).toBe("survive");
});
