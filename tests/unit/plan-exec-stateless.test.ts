// Spec 066, AC-04 a AC-07 (F4): un lote se acredita sólo con la salida de sus
// validaciones, deja en el plan hasta cinco líneas de evidencia con el hash de
// su commit, y el commit se aprueba por digest y se vuelve a proponer si los
// archivos cambiaron. Todo sobre un repo git temporal y el binario construido.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { parseBatchEvidence } from "../../src/application/parsers/batch-evidence.js";
import { ensureUnit, planUnit } from "../../src/application/plan-run/units.js";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

const PLAN = "docs/plans/012-plan-cupones.md";
const PLAN_TEXT = [
  "# Plan 012 — cupones",
  "",
  "> Standalone: prueba de ejecución",
  "> Estado: ready",
  "> Límite de ejecución: checkout",
  "",
  "## Tasks",
  "",
  "### F1 — El carrito acepta un cupón",
  "> Estado: pendiente",
  "> Fuentes: app",
  "",
  "**Resultado:** el total baja.",
  "- [ ] T1.1 — aplicar el cupón _(fuentes: app)_",
  "**Validación de fase:** `npx vitest run tests/cupon.test.ts` pasa.",
  "**Condición de salida:** `npx vitest run tests/cupon.test.ts` pasa.",
  "",
  "### F2 — El cupón vence",
  "> Estado: pendiente",
  "> Fuentes: app",
  "",
  "**Resultado:** un cupón vencido no descuenta.",
  "- [ ] T2.1 — vencer el cupón al cerrar el día _(fuentes: app)_",
  "**Validación de fase:** `npx vitest run tests/vence.test.ts` pasa.",
  "**Condición de salida:** `npx vitest run tests/vence.test.ts` pasa.",
  "",
  "## Execution batches",
  "",
  "- B1 · isolated · F1",
  "- B2 · isolated · F2",
  "",
  "## Validations",
  "",
  "- AC-01: `npx vitest run tests/cupon.test.ts` cubre el descuento.",
  "",
].join("\n");

describe("plan-exec sin sesión: cierre de lote, commit por digest y estados del plan", () => {
  let hub: DocFlowHub;
  let app: string;
  const appGit = (...args: string[]) =>
    execFileSync("git", args, { cwd: app, stdio: "pipe" }).toString();

  beforeEach(() => {
    hub = docFlowHub();
    app = join(hub.root, "..", "app");
    mkdirSync(app);
    appGit("init", "-q", "-b", "main");
    appGit("config", "user.email", "t@example.invalid");
    appGit("config", "user.name", "t");
    writeFileSync(join(app, "cupon.ts"), "export const descuento = 0;\n");
    appGit("add", ".");
    appGit("commit", "-q", "-m", "base");
    writeFileSync(join(hub.root, PLAN), PLAN_TEXT);
    hub.checkpoint("plan");
  });
  afterEach(() => hub.dispose());

  const readPlan = () =>
    dataOf(hub.aw(["flow", "read", "--flow", "plan-exec", "--doc", PLAN]).json)
      .read_digest as string;
  const commitArgs = (message: string) => [
    "--source",
    "app",
    "--message",
    message,
    "--path",
    "cupon.ts",
  ];
  const closeBatch = (batch: string, digest: string, body: unknown) =>
    hub.aw(
      ["flow", "close-batch", "--plan", PLAN, "--batch", batch, "--read-digest", digest],
      JSON.stringify(body),
    );
  const commits = () => appGit("rev-list", "--count", "HEAD").trim();

  it("una propuesta invalidada por un cambio posterior no commitea; la nueva sí", () => {
    writeFileSync(join(app, "cupon.ts"), "export const descuento = 10;\n");
    const proposal = dataOf(
      hub.aw(["flow", "propose-commit", ...commitArgs("feat: aplica el cupón")]).json,
    );
    expect(proposal.approval).toMatch(/^sha256:/);

    writeFileSync(join(app, "cupon.ts"), "export const descuento = 15;\n");
    const stale = hub.aw([
      "flow",
      "commit",
      ...commitArgs("feat: aplica el cupón"),
      "--approval",
      proposal.approval as string,
    ]);
    expect(stale.status).toBe(1);
    expect((stale.json.error as { code: string }).code).toBe("COMMIT_PROPOSAL_STALE");
    expect(commits()).toBe("1");

    const fresh = dataOf(
      hub.aw(["flow", "propose-commit", ...commitArgs("feat: aplica el cupón")]).json,
    );
    const done = hub.aw([
      "flow",
      "commit",
      ...commitArgs("feat: aplica el cupón"),
      "--approval",
      fresh.approval as string,
    ]);
    expect(done.status, JSON.stringify(done.json)).toBe(0);
    expect(commits()).toBe("2");
    expect(appGit("log", "-1", "--format=%s%n%b").trim()).toBe("feat: aplica el cupón");
  });

  it("el lote se acredita sólo con la salida de sus validaciones y deja ≤5 líneas con el hash", () => {
    writeFileSync(join(app, "cupon.ts"), "export const descuento = 10;\n");
    const proposal = dataOf(hub.aw(["flow", "propose-commit", ...commitArgs("feat: cupón")]).json);
    const hash = dataOf(
      hub.aw([
        "flow",
        "commit",
        ...commitArgs("feat: cupón"),
        "--approval",
        proposal.approval as string,
      ]).json,
    ).hash as string;

    const digest = readPlan();
    const evidence = {
      validated: "vitest cupon.test.ts 3/3",
      external: "despliegue sin comprobar",
    };
    const failing = closeBatch("B1", digest, {
      validations: [
        { command: "npx vitest run tests/cupon.test.ts", passed: false, output: "1 failed" },
      ],
      evidence,
      commits: { app: hash },
    });
    expect((failing.json.error as { code: string }).code).toBe("PLAN_RUN_VALIDATION_FAILED");
    const silent = closeBatch("B1", digest, {
      validations: [{ command: "npx vitest run tests/cupon.test.ts", passed: true, output: "" }],
      evidence,
      commits: { app: hash },
    });
    expect((silent.json.error as { code: string }).code).toBe("PLAN_RUN_VALIDATION_MISSING");
    expect(readFileSync(join(hub.root, PLAN), "utf8")).toBe(PLAN_TEXT);

    const closed = closeBatch("B1", digest, {
      validations: [
        {
          command: "npx vitest run tests/cupon.test.ts",
          passed: true,
          output: "Tests 3 passed (3)",
        },
      ],
      evidence,
      commits: { app: hash },
    });
    expect(closed.status, JSON.stringify(closed.json)).toBe(0);
    const text = readFileSync(join(hub.root, PLAN), "utf8");
    expect(text).toContain(
      "> Estado: in-progress\n> Próximo paso: T2.1 — vencer el cupón al cerrar el día",
    );
    expect(text).toContain("- [x] T1.1 — aplicar el cupón");
    expect(text).toContain("- [ ] T2.1");
    const evidenceRead = parseBatchEvidence(text);
    expect(evidenceRead.problems).toEqual([]);
    expect(evidenceRead.groups).toHaveLength(1);
    expect(evidenceRead.groups[0]?.lines).toBeLessThanOrEqual(5);
    expect(evidenceRead.groups[0]?.commits).toBe(`app ${hash.slice(0, 12)}`);
    // El plan cerrado por el CLI pasa su propio lint.
    const lint = hub.aw(["plan", "lint", PLAN]);
    expect((dataOf(lint.json).violations as unknown[]) ?? []).toEqual([]);

    // Un digest viejo ya no escribe: la instancia debe releer el plan.
    const stale = closeBatch("B2", digest, {
      validations: [{ command: "npx vitest run tests/vence.test.ts", passed: true, output: "ok" }],
      evidence,
      commits: {},
    });
    expect((stale.json.error as { code: string }).code).toBe("DOC_CHANGED_SINCE_READ");

    const second = closeBatch("B2", readPlan(), {
      validations: [
        {
          command: "npx vitest run tests/vence.test.ts",
          passed: true,
          output: "Tests 2 passed (2)",
        },
      ],
      evidence: { validated: "vitest vence.test.ts 2/2" },
      commits: {},
    });
    expect(second.status).toBe(0);
    const finished = hub.aw(
      ["flow", "finish", "--plan", PLAN, "--read-digest", readPlan()],
      JSON.stringify({
        validations: [{ command: "npm test", passed: true, output: "Tests 5 passed (5)" }],
      }),
    );
    expect(finished.status, JSON.stringify(finished.json)).toBe(0);
    const final = readFileSync(join(hub.root, PLAN), "utf8");
    expect(final).toMatch(/> Estado: done\n> Cierre: \d{4}-\d{2}-\d{2}/);
    expect(final).not.toContain("Próximo paso");

    // Ningún recorrido dejó archivos fuera de las fuentes, el plan y docs/.
    expect(hub.changed()).toEqual([PLAN]);
    expect(hub.sessionResidue()).toEqual([]);
  });

  it("las unidades se identifican por plan y lote, sin sesión", async () => {
    const git = new GitCliAdapter(new NodeProcess());
    const unit = planUnit({
      worktreesRoot: join(tmpdir(), `aw-units-${process.pid}-${Date.now()}`),
      hubKey: "hub-1234",
      alias: "app",
      plan: "012",
      batch: "B1",
    });
    expect(unit.branch).toBe("aw/hub-1234/plan-012-b1");
    const first = await ensureUnit(new NodeFileSystem(), git, app, unit, "main");
    expect(first.created).toBe(true);
    const again = await ensureUnit(new NodeFileSystem(), git, app, unit, "main");
    expect(again.created).toBe(false);
    appGit("worktree", "remove", "--force", unit.path);
  });
});
