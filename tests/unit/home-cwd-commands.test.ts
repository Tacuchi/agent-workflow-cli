import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aw-home-cwd-"));
  mkdirSync(join(root, "home"));
  // The child resolves its cwd (macOS /var → /private/var); HOME must name the same path.
  home = realpathSync(join(root, "home"));
  // The user-level ~/.workflow carries a marker, as on a real machine.
  mkdirSync(join(home, ".workflow"));
  writeFileSync(join(home, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function runFromHome(args: string[], input = "") {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
    encoding: "utf8",
    input,
  });
}

describe("aw desde $HOME", { timeout: 60_000 }, () => {
  it.each(["checkpoint-write", "resume-summary", "auto-compact-on-close"])(
    "el hook %s sale con 0, sin sobre de error",
    (command) => {
      const payload = JSON.stringify({
        hook_event_name: "PreCompact",
        session_id: "probe",
        cwd: home,
      });
      const result = runFromHome([command], payload);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("HUB_INVALID");
    },
  );

  it.each([
    ["doctor", "--only", "kimi", "--skip-native", "--format", "json"],
    ["mcp", "setup", "--host", "kimi", "--global", "--dry-run"],
  ])("'%s' corre sin exigir workspace", (...args) => {
    const result = runFromHome(args);
    expect(result.stdout + result.stderr).not.toContain("HUB_INVALID");
  });

  it("un comando del workspace sigue rechazado", () => {
    const result = runFromHome(["mcp", "setup", "--host", "kimi", "--dry-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("HUB_INVALID");
  });
});
