import { existsSync, readFileSync } from "node:fs";
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

describe("Wave 1B write commands — golden parity vs python qtc_core", () => {
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
      qtc_project_updated: true,
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
      qtc_project_updated: true,
    });
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
});
