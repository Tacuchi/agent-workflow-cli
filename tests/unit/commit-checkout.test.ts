// Spec 067, AC-01 a AC-03 y AC-08 (F1): un commit se propone y realiza en el
// worktree elegido con --checkout, sin reasignar la ruta declarada de la
// fuente; un checkout borrado o ajeno se rechaza con su causa. Repo git
// temporal y el binario construido.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

describe("propose-commit y commit en el checkout elegido", () => {
  let hub: DocFlowHub;
  let app: string;
  let feature: string;
  let declaredBlock: string;
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  const commitArgs = (checkout?: string) => [
    "--source",
    "app",
    ...(checkout === undefined ? [] : ["--checkout", checkout]),
    "--message",
    "feat: aplica el cupón",
    "--path",
    "cupon.ts",
  ];
  const codeOf = (json: Record<string, unknown>) => (json.error as { code: string }).code;

  beforeEach(() => {
    hub = docFlowHub();
    app = join(hub.root, "..", "app");
    mkdirSync(app);
    gitIn(app, "init", "-q", "-b", "main");
    gitIn(app, "config", "user.email", "t@example.invalid");
    gitIn(app, "config", "user.name", "t");
    writeFileSync(join(app, "cupon.ts"), "export const descuento = 0;\n");
    gitIn(app, "add", ".");
    gitIn(app, "commit", "-q", "-m", "base");
    feature = join(hub.root, "..", "wt-feature");
    gitIn(app, "worktree", "add", "-q", "-b", "feature/ejemplo", feature);
    declaredBlock = readFileSync(join(hub.root, "CLAUDE.md"), "utf8");
  });
  afterEach(() => hub.dispose());

  it("un cambio presente sólo en un worktree manual se propone y commitea allí", () => {
    writeFileSync(join(feature, "cupon.ts"), "export const descuento = 10;\n");
    const mainHead = gitIn(app, "rev-parse", "HEAD");

    // El checkout declarado está limpio: sin --checkout no hay nada que proponer.
    expect(codeOf(hub.aw(["flow", "propose-commit", ...commitArgs()]).json)).toBe(
      "COMMIT_PATH_UNCHANGED",
    );

    const proposed = hub.aw(["flow", "propose-commit", ...commitArgs(feature)]);
    expect(proposed.status, JSON.stringify(proposed.json)).toBe(0);
    const proposal = dataOf(proposed.json);
    expect(proposal).toMatchObject({
      source: "app",
      repo: app,
      checkout: realpathSync(feature),
      branch: "feature/ejemplo",
      paths: [expect.objectContaining({ path: "cupon.ts", git_path: "cupon.ts" })],
    });

    const committed = hub.aw([
      "flow",
      "commit",
      ...commitArgs(feature),
      "--approval",
      proposal.approval as string,
    ]);
    expect(committed.status, JSON.stringify(committed.json)).toBe(0);
    expect(gitIn(feature, "log", "-1", "--format=%s")).toBe("feat: aplica el cupón");
    expect(gitIn(app, "rev-parse", "HEAD")).toBe(mainHead);
    // La fuente conserva su ruta configurada.
    expect(readFileSync(join(hub.root, "CLAUDE.md"), "utf8")).toBe(declaredBlock);
    expect(hub.changed()).toEqual([]);
  });

  it("sin --checkout la propuesta usa la ruta declarada, como en 31.0.2", () => {
    writeFileSync(join(app, "cupon.ts"), "export const descuento = 5;\n");
    const proposal = dataOf(hub.aw(["flow", "propose-commit", ...commitArgs()]).json);
    expect(proposal).toMatchObject({
      repo: app,
      checkout: app,
      head: gitIn(app, "rev-parse", "HEAD"),
      message: "feat: aplica el cupón",
      branch: "main",
      paths: [expect.objectContaining({ path: "cupon.ts" })],
    });
    const committed = hub.aw([
      "flow",
      "commit",
      ...commitArgs(),
      "--approval",
      proposal.approval as string,
    ]);
    expect(committed.status, JSON.stringify(committed.json)).toBe(0);
    expect(gitIn(app, "log", "-1", "--format=%s")).toBe("feat: aplica el cupón");
  });

  it("aprobar en un checkout no vale para otro con los mismos bytes y el mismo HEAD", () => {
    const other = join(hub.root, "..", "wt-otra");
    gitIn(app, "worktree", "add", "-q", "-b", "feature/otra", other);
    writeFileSync(join(feature, "cupon.ts"), "export const descuento = 10;\n");
    writeFileSync(join(other, "cupon.ts"), "export const descuento = 10;\n");
    const proposal = dataOf(hub.aw(["flow", "propose-commit", ...commitArgs(feature)]).json);

    const stale = hub.aw([
      "flow",
      "commit",
      ...commitArgs(other),
      "--approval",
      proposal.approval as string,
    ]);
    expect(codeOf(stale.json)).toBe("COMMIT_PROPOSAL_STALE");
    expect(gitIn(other, "log", "-1", "--format=%s")).toBe("base");
  });

  it("un checkout borrado o un clon aparte se rechazan con su causa, sin mover ningún HEAD", () => {
    writeFileSync(join(feature, "cupon.ts"), "export const descuento = 10;\n");
    const proposal = dataOf(hub.aw(["flow", "propose-commit", ...commitArgs(feature)]).json);
    const heads = () => [
      gitIn(app, "rev-parse", "HEAD"),
      gitIn(app, "rev-parse", "feature/ejemplo"),
    ];
    const before = heads();

    rmSync(feature, { recursive: true, force: true });
    expect(codeOf(hub.aw(["flow", "propose-commit", ...commitArgs(feature)]).json)).toBe(
      "CHECKOUT_MISSING",
    );
    const gone = hub.aw([
      "flow",
      "commit",
      ...commitArgs(feature),
      "--approval",
      proposal.approval as string,
    ]);
    expect(codeOf(gone.json)).toBe("CHECKOUT_MISSING");
    expect(heads()).toEqual(before);

    const clone = join(hub.root, "..", "clon");
    execFileSync("git", ["clone", "-q", app, clone], { stdio: "pipe" });
    writeFileSync(join(clone, "cupon.ts"), "export const descuento = 20;\n");
    const cloneHead = gitIn(clone, "rev-parse", "HEAD");
    expect(codeOf(hub.aw(["flow", "propose-commit", ...commitArgs(clone)]).json)).toBe(
      "CHECKOUT_NOT_OF_SOURCE",
    );
    const foreign = hub.aw([
      "flow",
      "commit",
      ...commitArgs(clone),
      "--approval",
      proposal.approval as string,
    ]);
    expect(codeOf(foreign.json)).toBe("CHECKOUT_NOT_OF_SOURCE");
    expect(gitIn(clone, "rev-parse", "HEAD")).toBe(cloneHead);
    expect(heads()).toEqual(before);

    // El hub se resuelve por su raíz: --checkout no aplica.
    const hubChoice = hub.aw([
      "flow",
      "propose-commit",
      "--source",
      "hub",
      "--checkout",
      clone,
      "--message",
      "docs: x",
      "--path",
      "docs/plans/001-plan-x.md",
    ]);
    expect(codeOf(hubChoice.json)).toBe("ARGS_INVALID");
  });
});
