// Spec 066, AC-03, AC-09 y AC-11: `aw status` y `aw resume` salen de docs/, git y
// el registro de pases. El hub temporal deja `.workflow/sessions/` y HISTORY.md
// ilegibles y además el sistema de archivos se niega a abrirlos: si el tablero
// los tocara, la prueba fallaría.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  declarePass,
  derivePasses,
  readReleasePasses,
  recordArrival,
} from "../../src/application/release-pass-ledger.js";
import { runResume } from "../../src/application/resume-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/** Refuses — and records — any access under the session model's records. */
class SessionlessFs extends NodeFileSystem {
  readonly touched: string[] = [];
  constructor(private readonly forbidden: readonly string[]) {
    super();
  }
  private guard(path: string): void {
    if (this.forbidden.some((root) => path === root || path.startsWith(`${root}${sep}`))) {
      this.touched.push(path);
      throw new Error(`acceso prohibido: ${path}`);
    }
  }
  override async exists(path: string) {
    this.guard(path);
    return super.exists(path);
  }
  override async readText(path: string) {
    this.guard(path);
    return super.readText(path);
  }
  override async list(path: string) {
    this.guard(path);
    return super.list(path);
  }
  override async stat(path: string) {
    this.guard(path);
    return super.stat(path);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

const plan = (number: string, state: string[], tasks: string[], pass = true) =>
  [
    `# Plan ${number} — checkout`,
    "",
    "> Standalone: prueba",
    ...state,
    "> Límite de ejecución: checkout",
    "",
    "## Tasks",
    "",
    "### F3 — El cupón vence",
    "> Estado: en ejecución",
    "> Fuentes: app",
    "",
    ...tasks,
    "",
    ...(pass ? ["## Handoff operativo", "", "- Pase a prod: v1.0.0", ""] : []),
  ].join("\n");

describe("tablero y reanudación sin sesiones ni HISTORY.md", () => {
  let hub: string;
  let app: string;
  let fs: SessionlessFs;
  let paths: PathsService;

  beforeEach(async () => {
    hub = mkdtempSync(join(tmpdir(), "aw-sessionless-"));
    app = join(hub, "app");
    mkdirSync(join(hub, "docs/plans"), { recursive: true });
    mkdirSync(join(hub, ".workflow/sessions/001-viejo-plan-exec"), { recursive: true });
    writeFileSync(join(hub, ".workflow/sessions/001-viejo-plan-exec/SESSION.md"), "# SESSION\n");
    writeFileSync(join(hub, ".workflow/HISTORY.md"), "| 001 | sesión vieja |\n");
    writeFileSync(join(hub, ".workflow/agent-workflow.json"), '{"agent_workflow":1}\n');
    writeFileSync(
      join(hub, "CLAUDE.md"),
      [
        "<!-- WORKFLOW-HUB-START -->",
        "## Hub",
        "",
        "Prueba.",
        "",
        "## Fuentes",
        "",
        "| Alias | Path | Rama principal |",
        "|---|---|---|",
        `| app | ${app} | main |`,
        "",
        "<!-- WORKFLOW-HUB-END -->",
        "",
      ].join("\n"),
    );
    // Caída a mitad de un lote: el plan dice in-progress y apunta a T3.2.
    writeFileSync(
      join(hub, "docs/plans/012-plan-cupones.md"),
      plan(
        "012",
        ["> Estado: in-progress", "> Próximo paso: T3.2 — vencer el cupón al cerrar el día"],
        ["- [x] T3.1 — leer la fecha _(fuentes: app)_", "- [ ] T3.2 — vencer _(fuentes: app)_"],
        false,
      ),
    );
    for (const number of ["013", "014"]) {
      writeFileSync(
        join(hub, `docs/plans/${number}-plan-precios-${number}.md`),
        plan(number, ["> Estado: done"], ["- [x] T3.1 — precio _(fuentes: app)_"]).replace(
          "> Estado: en ejecución",
          "> Estado: validada",
        ),
      );
    }
    // La fuente tiene un commit y un cambio sin commit de la tarea 3.2.
    mkdirSync(app);
    git(app, "init", "-q", "-b", "main");
    git(app, "config", "user.email", "t@example.invalid");
    git(app, "config", "user.name", "t");
    writeFileSync(join(app, "cupon.ts"), "export const vence = false;\n");
    git(app, "add", ".");
    git(app, "commit", "-q", "-m", "base");
    writeFileSync(join(app, "cupon.ts"), "export const vence = true;\n");

    paths = new PathsService(normalizeNamespace("workflow"), hub, hub);
    // Un pase compartido por los dos planes, registrado una vez y ya en producción.
    const ledgerFs = new NodeFileSystem();
    await declarePass(ledgerFs, paths, {
      at: "2026-11-10T10:00:00.000Z",
      pass: {
        version: "v1.0.0",
        plans: [
          { kind: "plan", key: "013" },
          { kind: "plan", key: "014" },
        ],
        sources: ["app"],
      },
      cause: "los dos planes salen juntos",
    });
    await recordArrival(ledgerFs, paths, {
      at: "2026-11-10T12:00:00.000Z",
      passVersion: "v1.0.0",
      arrival: { source: "app", kind: "published-version", detail: "1.0.0", at: "2026-11-10" },
    });

    // Ilegibles en disco Y prohibidos para el puerto: el tablero no debe abrirlos.
    chmodSync(join(hub, ".workflow/sessions"), 0o000);
    chmodSync(join(hub, ".workflow/HISTORY.md"), 0o000);
    fs = new SessionlessFs([join(hub, ".workflow/sessions"), join(hub, ".workflow/HISTORY.md")]);
  });

  afterEach(() => {
    chmodSync(join(hub, ".workflow/sessions"), 0o755);
    chmodSync(join(hub, ".workflow/HISTORY.md"), 0o644);
    rmSync(hub, { recursive: true, force: true });
  });

  it("escenario «caída a mitad de un lote»: plan in-progress, próximo paso T3.2 y cambios sin commit", async () => {
    const env = new FakeEnv(hub, hub);
    const outcome = await runResume(fs, env, paths, {
      git: new GitCliAdapter(new NodeProcess()),
    });

    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    expect(outcome.proposal.file).toBe("docs/plans/012-plan-cupones.md");
    expect(outcome.proposal.progress).toContain("estado in-progress");
    expect(outcome.proposal.next).toBe("próximo paso T3.2 — vencer el cupón al cerrar el día");
    expect(outcome.proposal.uncommitted).toEqual([
      { alias: "app", path: app, changes: ["cupon.ts"] },
    ]);
    expect(fs.touched).toEqual([]);
  });

  it("el estado de cada plan sale de su campo único y el pase compartido se cuenta una vez", async () => {
    const env = new FakeEnv(hub, hub);
    const status = await runStatusCommand(fs, env, paths, { now: new Date(2026, 10, 10) });

    const byNumber = new Map(status.plans.map((item) => [item.number, item]));
    expect(byNumber.get("012")).toMatchObject({
      declared_state: "in-progress",
      plan_state: "open",
      next_step: { task: "T3.2" },
    });
    expect(byNumber.get("012")?.production).toEqual({ axis: "no-record" });
    // La situación del pase sale del registro: el único pase registrado lleva a
    // los dos planes cerrados y ambos lo ven en producción.
    const ledger = derivePasses((await readReleasePasses(new NodeFileSystem(), paths)).events);
    expect(ledger.map((pass) => [pass.pass.version, pass.pass.plans.map((p) => p.key)])).toEqual([
      ["v1.0.0", ["013", "014"]],
    ]);
    for (const number of ["013", "014"]) {
      expect(byNumber.get(number)).toMatchObject({ declared_state: "done", plan_state: "done" });
      expect(byNumber.get(number)?.production).toMatchObject({
        axis: "in-production",
        pass: "v1.0.0",
      });
      expect(byNumber.get(number)?.passes).toEqual([
        { environment: "prod", version: "v1.0.0", state: "done" },
      ]);
    }
    // Sólo el plan en curso queda pendiente: los cerrados ya están en producción.
    expect(status.pipeline.map((item) => item.number)).toEqual(["012"]);
    expect(status.sessions).toEqual({ active: [], closed: [], paused: [], abandoned: [] });
    expect(fs.touched).toEqual([]);
  });
});
