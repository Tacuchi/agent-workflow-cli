import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHistoryUpdate } from "../../src/application/history-update-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { TestEnv, cloneFixture, makeWorkflowPaths, readFile } from "./lib/before-after-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "sample-workspace");
const GOLDEN_DIR = join(HERE, "..", "fixtures", "golden-write");

function loadGoldenFile(scenario: string, relativePath: string): string {
  return readFileSync(join(GOLDEN_DIR, scenario, relativePath), "utf8");
}

const fs = new NodeFileSystem();

describe("Wave 1B write commands — golden parity (new model)", () => {
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

  it("session-close --code 001 writes the .closed sentinel (no project-block, no HISTORY)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const historyBefore = readFile(join(clone.cwd, ".workflow", "HISTORY.md"));

    const result = await runSessionClose(fs, env, paths, { code: "001" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.code).toBe("001");
    expect(result.sessionClose.folder).toBe("session001-dev-foo");
    expect(result.sessionClose.closed).toBe(true);

    // Folder-local `.closed` sentinel persisted.
    expect(
      existsSync(join(clone.cwd, ".workflow", "sessions", "session001-dev-foo", ".closed")),
    ).toBe(true);
    // CHECKPOINT.md + BACKLOG.md persist in the folder.
    expect(result.sessionClose.checkpoint_path).toContain("CHECKPOINT.md");
    expect(result.sessionClose.backlog_path).toContain("BACKLOG.md");

    // HISTORY.md is no longer touched by session-close (release bookkeeping only).
    expect(readFile(join(clone.cwd, ".workflow", "HISTORY.md"))).toEqual(historyBefore);
  });

  it("session-close --refs persists a free-form refs string", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      refs: "see docs/decisiones/001-foo.md",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe("see docs/decisiones/001-foo.md");
  });

  it("session-close error si la sesión no existe", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionClose(fs, env, paths, { code: "999" });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/Sesión no encontrada/);
  });

  it("session-create --type exec --name ... --objetivo ... --from ... writes SESSION.md (no HISTORY, no project-block)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const historyBefore = readFile(join(clone.cwd, ".workflow", "HISTORY.md"));
    const result = await runSessionCreate(fs, env, paths, {
      type: "exec",
      name: "session004-dev-nueva-tarea",
      objetivo: "Probar session-create del CLI TS",
      originRaw: "loop exec, docs/plan-004.md",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    // Folder is the --name verbatim (no numeric NNN, no type suffix).
    expect(result.sessionCreate.type).toBe("exec");
    expect(result.sessionCreate.name).toBe("session004-dev-nueva-tarea");
    expect(result.sessionCreate.folder).toBe("session004-dev-nueva-tarea");
    expect(result.sessionCreate.origin).toBe("loop exec, docs/plan-004.md");

    // Descriptor is SESSION.md (replaces the old per-flow OBJECTIVE.md).
    const sessionPath = join(
      clone.cwd,
      ".workflow",
      "sessions",
      "session004-dev-nueva-tarea",
      "SESSION.md",
    );
    expect(existsSync(sessionPath)).toBe(true);
    expect(result.sessionCreate.session_path).toBe(sessionPath);
    expect(readFile(sessionPath)).toEqual(loadGoldenFile("session-create-exec", "SESSION.md"));

    // session-create no longer writes a per-session HISTORY row.
    expect(readFile(join(clone.cwd, ".workflow", "HISTORY.md"))).toEqual(historyBefore);
    // session-create no longer touches the project block (sessions are internal/light).
    const claudeAfter = readFile(join(clone.cwd, "CLAUDE.md"));
    expect(claudeAfter).not.toContain("session004-dev-nueva-tarea");
  });

  it("session-create without --from renders the Origin placeholder", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      type: "research",
      name: "investiga-x",
      objetivo: "Investigar el patrón X",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionCreate.type).toBe("research");
    expect(result.sessionCreate.origin).toBeUndefined();

    const obj = readFile(join(clone.cwd, ".workflow", "sessions", "investiga-x", "SESSION.md"));
    expect(obj).toContain("# SESSION — investiga-x");
    expect(obj).toContain("## Objective\nInvestigar el patrón X");
    expect(obj).toContain("## Type\nresearch");
    expect(obj).toContain("Who created it and from where");
  });

  it("session-create requires --type (research|refine|exec|quick)", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      name: "x",
      objetivo: "y",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--type es obligatorio/);
    expect(result.expected).toEqual(["research", "refine", "exec", "quick"]);
  });

  it("session-create rejects an invalid --type", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      type: "feature",
      name: "x",
      objetivo: "y",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--type inválido/);
  });

  it("session-create requires --objetivo", async () => {
    const clone = cloneFixture(FIXTURE);
    const env = new TestEnv(clone.cwd);
    const paths = makeWorkflowPaths(env);
    const result = await runSessionCreate(fs, env, paths, {
      type: "exec",
      name: "x",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--objetivo es obligatorio/);
  });
});
