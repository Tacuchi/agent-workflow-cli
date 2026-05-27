import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHistoryUpdate } from "../../src/application/history-update-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import {
  TestEnv,
  cloneFixture,
  makeWorkflowPaths,
  normalizeLastActivity,
  normalizeTodayDate,
  readFile,
} from "./lib/before-after-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "sample-workspace");
const GOLDEN_DIR = join(HERE, "..", "fixtures", "golden-write");

function loadGoldenFile(scenario: string, relativePath: string): string {
  return readFileSync(join(GOLDEN_DIR, scenario, relativePath), "utf8");
}

const fs = new NodeFileSystem();

describe("Wave 1B write commands — golden parity (legacy ES fixture)", () => {
  it("history-update --code 001 --state closed --summary 'tarea cerrada via test'", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runHistoryUpdate(fs, env, paths, {
      code: "001",
      state: "closed",
      summary: "tarea cerrada via test",
    });
    expect(result).toEqual({ code: "001", flow: "dev", action: "updated", state: "closed" });
    expect(readFile(join(clone.cwd, ".workflow", "HISTORY.md"))).toEqual(
      loadGoldenFile("history-update-001-closed", ".workflow/HISTORY.md"),
    );
  });

  it("project-md-upsert --add-session session999-dev-test --phase planning --branches sample:main", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "add-session",
      sessionFolder: "session999-dev-test",
      phase: "planning",
      branches: ["sample:main"],
    });
    expect(result).toEqual({
      ok: true,
      action: "add-session",
      session: "session999-dev-test",
    });
    expect(normalizeLastActivity(readFile(join(clone.cwd, "CLAUDE.md")))).toEqual(
      normalizeLastActivity(loadGoldenFile("project-add-session", "CLAUDE.md")),
    );
  });

  it("project-md-upsert --remove-session session001-dev-foo", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "remove-session",
      sessionFolder: "session001-dev-foo",
    });
    expect(result).toEqual({
      ok: true,
      action: "remove-session",
      session: "session001-dev-foo",
    });
    expect(normalizeLastActivity(readFile(join(clone.cwd, "CLAUDE.md")))).toEqual(
      normalizeLastActivity(loadGoldenFile("project-remove-session", "CLAUDE.md")),
    );
  });

  it("project-md-upsert --update-phase session001-dev-foo --phase execution", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "update-phase",
      sessionFolder: "session001-dev-foo",
      phase: "execution",
    });
    expect(result).toEqual({
      ok: true,
      action: "update-phase",
      session: "session001-dev-foo",
    });
    expect(normalizeLastActivity(readFile(join(clone.cwd, "CLAUDE.md")))).toEqual(
      normalizeLastActivity(loadGoldenFile("project-update-phase", "CLAUDE.md")),
    );
  });

  it("session-close --code 001 --graduated-decisions 001-stack-typescript", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedDecisions: "001-stack-typescript",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose).toEqual({
      code: "001",
      folder: "session001-dev-foo",
      history_action: "updated",
      refs: "[DEC](../docs/decisiones/001-stack-typescript.md)",
      aw_project_updated: true,
    });
    expect(readFile(join(clone.cwd, ".workflow", "HISTORY.md"))).toEqual(
      loadGoldenFile("session-close-001", ".workflow/HISTORY.md"),
    );
    expect(normalizeLastActivity(readFile(join(clone.cwd, "CLAUDE.md")))).toEqual(
      normalizeLastActivity(loadGoldenFile("session-close-001", "CLAUDE.md")),
    );
  });

  it("session-close --code 001 --graduated-conclusions 002-audit-runtime", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedConclusions: "002-audit-runtime",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose).toEqual({
      code: "001",
      folder: "session001-dev-foo",
      history_action: "updated",
      refs: "[CONCLUSION](../docs/conclusiones/002-audit-runtime.md)",
      aw_project_updated: true,
    });
  });

  it("session-close --graduated-manuales 003-mcp-setup (R5 new flag)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedManuales: "003-mcp-setup",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe("[MANUAL](../docs/manuales/003-mcp-setup.md)");
  });

  it("session-close --graduated-especificaciones 001-export-func-format (R5 new flag)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedEspecificaciones: "001-export-func-format",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe(
      "[ESPECIFICACION](../docs/especificaciones/001-export-func-format/)",
    );
  });

  it("session-close --graduated-release 001-informe-release (R5 new flag)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedRelease: "001-informe-release",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe("[RELEASE](../docs/release/001-informe-release.md)");
  });

  it("session-close --graduated-design 001-spec-foo (legacy alias → especificacion)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedDesign: "001-spec-foo",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe(
      "[ESPECIFICACION](../docs/especificaciones/001-spec-foo/)",
    );
  });

  it("session-close rechaza slug sin prefijo NNN (R5 — DEC-003)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedConclusions: "mejoras-flujos-qtc-runtime",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/graduated-conclusions requiere slug con prefijo NNN-/);
  });

  it("session-close acepta slug suelto con --allow-loose-slugs", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      graduatedConclusions: "legacy-slug-sin-nnn",
      allowLooseSlugs: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe(
      "[CONCLUSION](../docs/conclusiones/legacy-slug-sin-nnn.md)",
    );
  });

  it("session-close transiciona plan active → done si OBJECTIVE tiene ## Origin (plan) (R4)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    seedPlanAndOrigin(clone.cwd, "session001-dev-foo", "001-test-plan", "active");

    const result = await runSessionClose(fs, env, paths, { code: "001" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.plan_transition).toEqual({
      plan: "001-test-plan.md",
      from: "active",
      to: "done",
    });
    const planContent = readFile(join(clone.cwd, "docs", "planes", "001-test-plan.md"));
    expect(planContent).toContain("state: done");
    expect(planContent).toContain("from: active, to: done");
    expect(planContent).toContain("session-close 001");
  });

  it("session-close skip silencioso si plan ya está done (R4 idempotente)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    seedPlanAndOrigin(clone.cwd, "session001-dev-foo", "001-test-plan", "done");

    const result = await runSessionClose(fs, env, paths, { code: "001" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.plan_transition).toBeUndefined();
  });

  it("session-close continúa sin abortar si plan archivado / no existe (R4 DEC-002)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    // Plan archivado: resolveFromPlan retorna PLAN_ARCHIVED → skip silencioso.
    seedPlanAndOrigin(clone.cwd, "session001-dev-foo", "001-test-plan", "archived");

    const result = await runSessionClose(fs, env, paths, { code: "001" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.plan_transition).toBeUndefined();
    // El cierre se completa correctamente igualmente.
    expect(result.sessionClose.history_action).toBe("updated");
  });

  it("session-create --flow dev --name nueva-tarea --objetivo ... --branches sample:main", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      flow: "dev",
      name: "nueva-tarea",
      objetivo: "Probar session-create del CLI TS",
      branchesRaw: "sample:main",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionCreate.code).toBe("004");
    expect(result.sessionCreate.folder).toBe("session004-dev-nueva-tarea");
    expect(result.sessionCreate.flow).toBe("dev");
    expect(result.sessionCreate.branches).toEqual(["sample:main"]);

    const objPath = join(
      clone.cwd,
      ".workflow",
      "sessions",
      "session004-dev-nueva-tarea",
      "OBJECTIVE.md",
    );
    expect(existsSync(objPath)).toBe(true);
    expect(readFile(objPath)).toEqual(loadGoldenFile("session-create-dev", "OBJECTIVE.md"));
    expect(normalizeTodayDate(readFile(join(clone.cwd, ".workflow", "HISTORY.md")))).toEqual(
      normalizeTodayDate(loadGoldenFile("session-create-dev", ".workflow/HISTORY.md")),
    );
    expect(normalizeLastActivity(readFile(join(clone.cwd, "CLAUDE.md")))).toEqual(
      normalizeLastActivity(loadGoldenFile("session-create-dev", "CLAUDE.md")),
    );
  });

  it("session-create --lite: micro-sesión con OBJECTIVE condensado + Type bugfix + kind:patch", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      flow: "dev",
      name: "fix-typo",
      objetivo: "Arreglar typo en el validador",
      lite: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    // Type default bugfix (lite no cae a feature) + kind patch en el record.
    expect(result.sessionCreate.tipo).toBe("bugfix");
    expect(result.sessionCreate.kind).toBe("patch");

    const folder = result.sessionCreate.folder;
    const obj = readFile(join(clone.cwd, ".workflow", "sessions", folder, "OBJECTIVE.md"));
    expect(obj).toContain("## Type\nbugfix");
    expect(obj).toContain("## Requirement\nArreglar typo en el validador");
    expect(obj).not.toContain("## Context");
    expect(obj).not.toContain("## Acceptance criteria");
    expect(obj).not.toContain("## Topics");

    // Tag kind:patch literal en HISTORY (no renderizado como link).
    expect(readFile(join(clone.cwd, ".workflow", "HISTORY.md"))).toContain("kind:patch");
  });

  it("session-create --lite --type chore respeta chore", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      flow: "dev",
      name: "limpieza",
      objetivo: "Limpiar imports",
      tipo: "chore",
      lite: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionCreate.tipo).toBe("chore");
    expect(result.sessionCreate.kind).toBe("patch");
  });

  it("session-create --lite rechaza --type feature", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      flow: "dev",
      name: "x",
      objetivo: "y",
      tipo: "feature",
      lite: true,
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--lite no admite --type/);
  });

  it("session-create --lite sólo aplica a flow=dev (analyze rechaza)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      flow: "analyze",
      name: "x",
      objetivo: "y",
      modalidad: "technical",
      lite: true,
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--lite sólo aplica a flow=dev/);
  });
});

/**
 * Helper for R4 tests: creates a plan in docs/planes/ and appends ## Origin (plan)
 * to the session's OBJETIVO.md so runSessionClose detects the wire-up.
 */
function seedPlanAndOrigin(
  cwd: string,
  sessionFolder: string,
  planSlug: string,
  state: "draft" | "active" | "done" | "archived",
): void {
  const planesDir = join(cwd, "docs", "planes");
  mkdirSync(planesDir, { recursive: true });
  const planRelpath = `docs/planes/${planSlug}.md`;
  const planContent = `---
state: ${state}
sessions: [001]
created: 2026-05-19
slug: test-plan
state_changes:
  - {from: null, to: draft, when: '2026-05-19T00:00:00Z', trigger: 'export-plan create'}
---

# Plan test

## Resumen

Plan sintético para test R4.
`;
  writeFileSync(join(planesDir, `${planSlug}.md`), planContent);

  const objetivoPath = join(cwd, ".workflow", "sessions", sessionFolder, "OBJETIVO.md");
  const existing = readFileSync(objetivoPath, "utf8");
  const withOrigin = `${existing.trimEnd()}\n\n## Origin (plan)\n\nDerivado del plan \`${planRelpath}\` (sessions: 001).\n`;
  writeFileSync(objetivoPath, withOrigin);
}
