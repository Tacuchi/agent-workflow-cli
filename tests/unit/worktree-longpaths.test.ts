import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { git, worktreeFixture } from "../helpers/worktree-fixture.js";

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

it("en Windows configura core.longpaths sólo en git local antes de abrir la unidad", async () => {
  const fixture = worktreeFixture();
  dispose.push(fixture.dispose);
  fixture.deps.platform = "win32";
  const before = readFileSync(`${fixture.repo}/README.md`, "utf8");
  const unit = await fixture.run("ensure");
  expect(unit).toMatchObject({ created: true, longpaths_enabled: true });
  expect(git(fixture.repo, "config", "--local", "--get", "core.longpaths")).toBe("true");
  expect(readFileSync(`${fixture.repo}/README.md`, "utf8")).toBe(before);
  expect(git(fixture.repo, "status", "--porcelain")).toBe("");
  expect(await fixture.run("ensure")).toMatchObject({ longpaths_enabled: false });
});

it("no escribe la configuración de la fuente fuera de Windows", async () => {
  const fixture = worktreeFixture();
  dispose.push(fixture.dispose);
  expect(await fixture.run("ensure")).toMatchObject({ longpaths_enabled: false });
  expect(git(fixture.repo, "config", "--local", "--get-regexp", "user\\.")).toContain("user.name");
  expect(await fixture.deps.git.readConfig?.(fixture.repo, "core.longpaths")).toBeNull();
});
