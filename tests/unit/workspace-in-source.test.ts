import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

it("persist apply desde el checkout resuelve el único hub incluso con marcador en HOME", () => {
  root = mkdtempSync(join(tmpdir(), "aw-source-cwd-"));
  const home = join(root, "home");
  const hub = join(root, "hub");
  const source = join(root, "source");
  for (const dir of [home, hub, source]) mkdirSync(dir);
  mkdirSync(join(home, ".workflow"));
  writeFileSync(join(home, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
  writeFileSync(join(hub, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  writeFileSync(
    join(hub, "AGENTS.md"),
    `<!-- WORKFLOW-PROJECT-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ${source} | main |\n<!-- WORKFLOW-PROJECT-END -->`,
  );
  spawnSync("git", ["init", "-q", source]);
  const run = (cwd: string, args: string[], input?: string) => {
    const output = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd,
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
      encoding: "utf8",
      input,
    });
    return {
      status: output.status,
      body: JSON.parse(output.stdout) as Record<string, unknown>,
      error: output.stderr,
    };
  };
  expect(run(hub, ["status"]).status).toBe(0); // records the hub in HOME, without writing in source
  const prepared = run(hub, ["persist", "prepare"]);
  expect(prepared.status).toBe(0);
  const request = prepared.body.request as { input_digest: string };
  const answer = JSON.stringify({
    version: 1,
    operation: "persist",
    input_digest: request.input_digest,
    state: "proposed",
    decisions: { category: "research", slug: "desde-fuente", mode: "new" },
    artifacts: [
      { path: "docs/research/001-research-desde-fuente.md", content: "# Prueba\n\nreal\n" },
    ],
  });
  const validated = run(hub, ["persist", "validate"], answer);
  expect(validated.status).toBe(0);
  const applied = run(
    source,
    ["persist", "apply", "--approval", validated.body.approval_digest as string],
    answer,
  );
  expect(applied.status).toBe(0);
  expect(readdirSync(join(hub, "docs", "research"))).toContain("001-research-desde-fuente.md");
  expect(readdirSync(source)).not.toContain(".workflow");
  expect(readdirSync(source)).not.toContain(".gitignore");
});

it("un repo sin hub con marcador en HOME no funda runtime ni edita .gitignore", () => {
  root = mkdtempSync(join(tmpdir(), "aw-unclaimed-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".workflow"), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  spawnSync("git", ["init", "-q", repo]);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "session-create",
      "--type",
      "quick",
      "--name",
      "sin-hub",
      "--objetivo",
      "probar",
      "--json",
    ],
    {
      cwd: repo,
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
      encoding: "utf8",
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("WORKSPACE_UNRESOLVED");
  expect(readdirSync(repo)).not.toContain(".workflow");
  expect(readdirSync(repo)).not.toContain(".gitignore");
});

it("context-budget mide el bundle desde un checkout sin hub ni --workspace", () => {
  root = mkdtempSync(join(tmpdir(), "aw-budget-no-hub-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "context-budget",
      "--root",
      join(checkout, "skills", "w"),
      "--baseline",
      join(checkout, "tests", "fixtures", "context-baseline.json"),
      "--json",
    ],
    { cwd: repo, env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" }, encoding: "utf8" },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.verdict).toBe("ok");
  expect(body.offenders).toEqual([]);
  expect(readdirSync(repo)).not.toContain(".workflow");
});
