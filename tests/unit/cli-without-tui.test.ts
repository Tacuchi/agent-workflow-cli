import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = resolve("dist/cli/main.js");
const LOADER = resolve("tests/helpers/deny-tui-loader.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aw-no-tui-"));
  roots.push(root);
  const session = join(root, ".workflow/sessions/001-sin-tui-quick");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(root, ".workflow/workline.json"), '{"workline":1,"namespace":"workflow"}\n');
  writeFileSync(
    join(session, "SESSION.md"),
    "# SESSION — sin-tui-quick\n\n## Objective\nVerificar QUICK sin UI\n\n## Origin\nFixture local\n",
  );
  return root;
}

function command(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-loader", LOADER, ENTRY, ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AW_NAMESPACE: "workflow" },
    },
  );
}

describe("CLI sin módulos TUI cargables", () => {
  it("lee status y avanza QUICK con una sesión temporal", () => {
    const root = fixture();
    const status = command(root, ["status", "--format", "json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toHaveProperty("counts");

    const flow = command(root, [
      "flow",
      "--host",
      "oz",
      "advance",
      "--session",
      "001",
      "--flow",
      "quick",
      "--adopt",
    ]);
    expect(flow.stderr).not.toContain("TUI_IMPORT_FORBIDDEN");
    expect(flow.status, flow.stderr || flow.stdout).toBe(0);
    expect(JSON.parse(flow.stdout)).toMatchObject({ flow: "quick", outcome: "needs_input" });
  });
});
