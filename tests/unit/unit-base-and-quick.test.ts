// Spec 067, AC-05 a AC-07 (F3): la unidad de PLAN parte de la base elegida con
// --from, QUICK tiene su propia unidad sin plan y ninguna rama creada por
// `aw flow unit` adquiere seguimiento, tampoco desde una referencia remota.
// Repo git temporal con un remoto local y el binario construido.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

interface Ensured {
  created: boolean;
  base: string | null;
  unit: { alias: string; branch: string; path: string; plan?: string; quick?: string };
}

describe("unidades de PLAN y QUICK desde la base elegida, sin seguimiento", () => {
  let hub: DocFlowHub;
  let app: string;
  let declaredBlock: string;
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  const unit = (...args: string[]) => hub.aw(["flow", "unit", "--source", "app", ...args]);
  const ensured = (...args: string[]) => {
    const result = unit(...args);
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    return dataOf(result.json) as unknown as Ensured;
  };
  const upstream = (branch: string) =>
    spawnSync("git", ["config", "--get", `branch.${branch}.remote`], { cwd: app }).status;
  const codeOf = (json: Record<string, unknown>) => (json.error as { code: string }).code;

  beforeEach(() => {
    hub = docFlowHub();
    app = join(hub.root, "..", "app");
    const origin = join(hub.root, "..", "origin.git");
    mkdirSync(app);
    gitIn(app, "init", "-q", "-b", "main");
    gitIn(app, "config", "user.email", "t@example.invalid");
    gitIn(app, "config", "user.name", "t");
    // Explícito: así git configuraría seguimiento si la unidad no lo impidiera.
    gitIn(app, "config", "branch.autoSetupMerge", "true");
    writeFileSync(join(app, "cupon.ts"), "export const descuento = 0;\n");
    gitIn(app, "add", ".");
    gitIn(app, "commit", "-q", "-m", "base");
    gitIn(app, "checkout", "-q", "-b", "feature/ejemplo");
    writeFileSync(join(app, "feature.ts"), "export const feature = true;\n");
    gitIn(app, "add", ".");
    gitIn(app, "commit", "-q", "-m", "feature");
    gitIn(app, "checkout", "-q", "main");
    execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
    gitIn(app, "remote", "add", "origin", origin);
    gitIn(app, "push", "-q", "origin", "main", "feature/ejemplo");
    gitIn(app, "fetch", "-q", "origin");
    declaredBlock = readFileSync(join(hub.root, "CLAUDE.md"), "utf8");
  });
  afterEach(() => hub.dispose());

  it("la unidad de PLAN parte de la feature elegida y sin flags nuevos sigue igual", () => {
    const fromFeature = ensured("--plan", "007", "--batch", "B1", "--from", "feature/ejemplo");
    expect(fromFeature.created).toBe(true);
    expect(fromFeature.base).toBe("feature/ejemplo");
    expect(fromFeature.unit.branch).toMatch(/^aw\/[^/]+\/plan-007-b1$/);
    expect(existsSync(join(fromFeature.unit.path, "feature.ts"))).toBe(true);
    expect(upstream(fromFeature.unit.branch)).not.toBe(0);

    const plain = ensured("--plan", "007", "--batch", "B2");
    expect(plain.base).toBe("main");
    expect(plain.unit.branch).toMatch(/^aw\/[^/]+\/plan-007-b2$/);
    expect(plain.unit.path).toMatch(/[/\\]app[/\\]plan-007-b2$/);
    expect(existsSync(join(plain.unit.path, "feature.ts"))).toBe(false);

    expect(readFileSync(join(hub.root, "CLAUDE.md"), "utf8")).toBe(declaredBlock);
  });

  it("una unidad desde una referencia remota no tiene upstream", () => {
    const remote = ensured("--plan", "007", "--batch", "B1", "--from", "origin/feature/ejemplo");
    expect(remote.created).toBe(true);
    expect(existsSync(join(remote.unit.path, "feature.ts"))).toBe(true);
    expect(upstream(remote.unit.branch)).not.toBe(0);
  });

  it("QUICK crea su unidad sin plan, la reencuentra y commitea en ella con --checkout", () => {
    const first = ensured("--quick", "corrige-cupon", "--from", "origin/feature/ejemplo");
    expect(first.created).toBe(true);
    expect(first.unit).toMatchObject({ quick: "corrige-cupon" });
    expect(first.unit.plan).toBeUndefined();
    expect(first.unit.branch).toMatch(/^aw\/[^/]+\/quick-corrige-cupon$/);
    expect(first.unit.path).toMatch(/[/\\]app[/\\]quick-corrige-cupon$/);
    expect(upstream(first.unit.branch)).not.toBe(0);

    const again = ensured("--quick", "corrige-cupon");
    expect(again).toMatchObject({ created: false, base: null });
    expect(again.unit.branch).toBe(first.unit.branch);

    writeFileSync(join(first.unit.path, "cupon.ts"), "export const descuento = 10;\n");
    const args = [
      "--source",
      "app",
      "--checkout",
      first.unit.path,
      "--message",
      "fix: corrige el cupón",
      "--path",
      "cupon.ts",
    ];
    const proposal = dataOf(hub.aw(["flow", "propose-commit", ...args]).json);
    expect(proposal.branch).toBe(first.unit.branch);
    const committed = hub.aw([
      "flow",
      "commit",
      ...args,
      "--approval",
      proposal.approval as string,
    ]);
    expect(committed.status, JSON.stringify(committed.json)).toBe(0);
    expect(gitIn(first.unit.path, "log", "-1", "--format=%s")).toBe("fix: corrige el cupón");
    expect(gitIn(app, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(hub.root, "CLAUDE.md"), "utf8")).toBe(declaredBlock);
  });

  it("una base inexistente o una forma mezclada se rechazan sin crear nada", () => {
    const trees = () => gitIn(app, "worktree", "list").split("\n").length;
    const before = trees();
    expect(codeOf(unit("--plan", "007", "--batch", "B1", "--from", "no-existe").json)).toBe(
      "UNIT_BASE_MISSING",
    );
    expect(codeOf(unit("--quick", "x", "--plan", "007", "--batch", "B1").json)).toBe(
      "ARGS_INVALID",
    );
    expect(codeOf(unit("--quick", "No_Kebab").json)).toBe("ARGS_INVALID");
    expect(trees()).toBe(before);
  });
});
