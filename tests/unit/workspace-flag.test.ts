import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

it("--hub nombra la raíz exacta desde otro cwd y rechaza una subcarpeta", () => {
  root = mkdtempSync(join(tmpdir(), "aw-flag-"));
  const home = join(root, "home");
  const outside = join(root, "outside");
  const hub = join(root, "hub");
  mkdirSync(home);
  mkdirSync(outside);
  mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
  mkdirSync(join(hub, "docs"));
  writeFileSync(join(hub, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  const run = (workspace: string) =>
    spawnSync(process.execPath, [cli, "status", "--hub", workspace, "--json"], {
      cwd: outside,
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
      encoding: "utf8",
    });
  const valid = run(hub);
  expect(valid.status).toBe(0);
  expect(valid.stdout).toContain("sessions");
  const invalid = run(join(hub, "docs"));
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout + invalid.stderr).toContain("WORKSPACE_INVALID");
  const userHome = run(home);
  expect(userHome.status).not.toBe(0);
  expect(userHome.stdout + userHome.stderr).toContain("WORKSPACE_INVALID");
  const legacy = join(root, "legacy");
  mkdirSync(join(legacy, ".workflow", "sessions"), { recursive: true });
  writeFileSync(join(legacy, ".workflow", "HISTORY.md"), "# Historia\n");
  expect(run(legacy).status).toBe(0);
  const fresh = join(root, "nuevo");
  mkdirSync(fresh);
  expect(run(fresh).status).toBe(0);
}, 30_000);
