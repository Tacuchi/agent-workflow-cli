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

function setup() {
  const cwd = cloneFixture(FIXTURE);
  const env = new TestEnv(cwd);
  return { cwd, env, paths: makeWorkflowPaths(env) };
}

describe("Wave 1B write commands — golden parity (new model)", () => {
  it("history-update --code 001 --state closed --summary 'tarea cerrada via test'", async () => {
    const { cwd, env, paths } = setup();
    const result = await runHistoryUpdate(fs, env, paths, {
      code: "001",
      state: "closed",
      summary: "tarea cerrada via test",
    });
    // Sessions no longer carry a `flow` segment; the output flow is always
    // null. The upsert also migrates the fixture's legacy 7-column table to
    // the slim `| Sesión | Fecha | Estado | Refs |` shape (the Sesión cell is
    // re-keyed with its `#` prefix so future upserts keep matching).
    expect(result).toEqual({ code: "001", flow: null, action: "updated", state: "closed" });
    expect(readFile(join(cwd, ".workflow", "HISTORY.md"))).toEqual(
      loadGoldenFile("history-update-001-closed", ".workflow/HISTORY.md"),
    );
  });

  it("session-close --code 001 writes the .closed sentinel AND upserts the HISTORY row", async () => {
    const { cwd, env, paths } = setup();
    const historyBefore = readFile(join(cwd, ".workflow", "HISTORY.md"));

    const result = await runSessionClose(fs, env, paths, { code: "001" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.code).toBe("001");
    expect(result.sessionClose.folder).toBe("session001-dev-foo");
    expect(result.sessionClose.closed).toBe(true);

    // Folder-local `.closed` sentinel persisted.
    const sessionDir = join(cwd, ".workflow", "sessions", "session001-dev-foo");
    expect(existsSync(join(sessionDir, ".closed"))).toBe(true);
    // CHECKPOINT.md is created (resume safety net) and persists in the folder.
    expect(result.sessionClose.checkpoint_path).toContain("CHECKPOINT.md");
    expect(existsSync(join(sessionDir, "CHECKPOINT.md"))).toBe(true);
    // BACKLOG.md is NOT auto-fabricated: close still reports `backlog_path` as a
    // string, but the empty boilerplate file is never written.
    expect(result.sessionClose.backlog_path).toContain("BACKLOG.md");
    expect(existsSync(join(sessionDir, "BACKLOG.md"))).toBe(false);

    // Close now upserts the session's HISTORY.md row (sessions are gitignored;
    // HISTORY is the durable record — reverses the old "release bookkeeping only"
    // decoupling, ratified in spec 008 Q2).
    expect(result.sessionClose.history).toEqual({ action: "updated", state: "closed" });
    const historyAfter = readFile(join(cwd, ".workflow", "HISTORY.md"));
    expect(historyAfter).not.toEqual(historyBefore);
    // Slim table: the row key is the `NNN-<name>` Sesión cell.
    const row = historyAfter.split("\n").find((l) => l.startsWith("| 001-dev-foo |"));
    expect(row).toBeDefined();
    expect(row).toContain("closed");
  });

  it("session-close --refs lands the refs (free text included) in the HISTORY row", async () => {
    const { cwd, env, paths } = setup();
    const result = await runSessionClose(fs, env, paths, {
      code: "001",
      refs: "see docs/decisiones/001-foo.md",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.refs).toBe("see docs/decisiones/001-foo.md");
    // Free-form refs (no `kind:`) render as plain text in the row, never dropped.
    const historyAfter = readFile(join(cwd, ".workflow", "HISTORY.md"));
    const row = historyAfter.split("\n").find((l) => l.startsWith("| 001-dev-foo |"));
    expect(row).toContain("see docs/decisiones/001-foo.md");
  });

  it("session-close es no-fatal ante HISTORY bloqueado: cierra igual y reporta history_error", async () => {
    const { cwd, env, paths } = setup();
    // Live foreign lock (test's pid, current ISO ts) → history-update returns lock busy.
    await fs.writeText(
      join(cwd, ".workflow", ".lock"),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    const historyBefore = readFile(join(cwd, ".workflow", "HISTORY.md"));

    const result = await runSessionClose(fs, env, paths, { code: "001" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionClose.closed).toBe(true);
    expect(existsSync(join(cwd, ".workflow", "sessions", "session001-dev-foo", ".closed"))).toBe(
      true,
    );
    expect(result.sessionClose.history).toBeUndefined();
    expect(result.sessionClose.history_error).toMatch(/lock ocupado/);
    expect(readFile(join(cwd, ".workflow", "HISTORY.md"))).toEqual(historyBefore);
  });

  it("session-close error si la sesión no existe", async () => {
    const { env, paths } = setup();
    const result = await runSessionClose(fs, env, paths, { code: "999" });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/Sesión no encontrada/);
  });

  it("session-create --type exec --name ... --objetivo ... --from ... writes SESSION.md (no HISTORY, no project-block)", async () => {
    const { cwd, env, paths } = setup();
    const historyBefore = readFile(join(cwd, ".workflow", "HISTORY.md"));
    const result = await runSessionCreate(fs, env, paths, {
      type: "exec",
      name: "session004-dev-nueva-tarea",
      objetivo: "Probar session-create del CLI TS",
      originRaw: "loop exec, docs/plan-004.md",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    // The CLI prepends a global sequential NNN to the descriptor `--name`. The
    // fixture's legacy `sessionNNN-…` folders don't match the new sequence, so
    // this fresh session takes 001.
    expect(result.sessionCreate.type).toBe("exec");
    expect(result.sessionCreate.name).toBe("session004-dev-nueva-tarea");
    expect(result.sessionCreate.number).toBe("001");
    expect(result.sessionCreate.folder).toBe("001-session004-dev-nueva-tarea");
    expect(result.sessionCreate.origin).toBe("loop exec, docs/plan-004.md");

    // Descriptor is SESSION.md (replaces the old per-flow OBJECTIVE.md).
    const sessionPath = join(
      cwd,
      ".workflow",
      "sessions",
      "001-session004-dev-nueva-tarea",
      "SESSION.md",
    );
    expect(existsSync(sessionPath)).toBe(true);
    expect(result.sessionCreate.session_path).toBe(sessionPath);
    expect(readFile(sessionPath)).toEqual(loadGoldenFile("session-create-exec", "SESSION.md"));

    // session-create no longer writes a per-session HISTORY row.
    expect(readFile(join(cwd, ".workflow", "HISTORY.md"))).toEqual(historyBefore);
    // session-create no longer touches the project block (sessions are internal/light).
    const claudeAfter = readFile(join(cwd, "CLAUDE.md"));
    expect(claudeAfter).not.toContain("session004-dev-nueva-tarea");
  });

  it("session-create numbers sessions globally & sequentially, regardless of type", async () => {
    const { env, paths } = setup();

    const first = await runSessionCreate(fs, env, paths, {
      type: "refine",
      name: "spec-refine",
      objetivo: "control del loop de refinamiento",
    });
    const second = await runSessionCreate(fs, env, paths, {
      type: "research",
      name: "spec-refine-research-winfacts",
      objetivo: "investigar hechos de Windows",
    });
    const third = await runSessionCreate(fs, env, paths, {
      type: "refine",
      name: "plan-new",
      objetivo: "control del loop de planificación",
    });
    if ("error" in first || "error" in second || "error" in third) {
      throw new Error("unexpected error creating sessions");
    }
    // One global counter: each new session takes the next NNN, never resetting
    // per type — this is the fix for "all sessions numbered 001".
    expect(first.sessionCreate.folder).toBe("001-spec-refine");
    expect(second.sessionCreate.folder).toBe("002-spec-refine-research-winfacts");
    expect(third.sessionCreate.folder).toBe("003-plan-new");

    // A descriptor that accidentally carries a leading NNN- is normalized, never doubled.
    const fourth = await runSessionCreate(fs, env, paths, {
      type: "quick",
      name: "001-quick",
      objetivo: "no debe duplicar el prefijo",
    });
    if ("error" in fourth) throw new Error("unexpected error");
    expect(fourth.sessionCreate.folder).toBe("004-quick");
  });

  it("session-create without --from renders the Origin placeholder", async () => {
    const { cwd, env, paths } = setup();
    const result = await runSessionCreate(fs, env, paths, {
      type: "research",
      name: "investiga-x",
      objetivo: "Investigar el patrón X",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.sessionCreate.type).toBe("research");
    expect(result.sessionCreate.origin).toBeUndefined();

    expect(result.sessionCreate.folder).toBe("001-investiga-x");
    const obj = readFile(join(cwd, ".workflow", "sessions", "001-investiga-x", "SESSION.md"));
    expect(obj).toContain("# SESSION — investiga-x");
    expect(obj).toContain("## Objective\nInvestigar el patrón X");
    // Type is no longer rendered (derivable from the name suffix).
    expect(obj).not.toContain("## Type");
    expect(obj).toContain("Who created it and from where");
  });

  it("session-create requires --type (research|refine|exec|quick)", async () => {
    const { env, paths } = setup();
    const result = await runSessionCreate(fs, env, paths, {
      name: "x",
      objetivo: "y",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--type es obligatorio/);
    expect(result.expected).toEqual(["research", "refine", "exec", "quick"]);
  });

  it("session-create rejects an invalid --type", async () => {
    const { env, paths } = setup();
    const result = await runSessionCreate(fs, env, paths, {
      type: "feature",
      name: "x",
      objetivo: "y",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--type inválido/);
  });

  it("session-create requires --objetivo", async () => {
    const { env, paths } = setup();
    const result = await runSessionCreate(fs, env, paths, {
      type: "exec",
      name: "x",
    });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toMatch(/--objetivo es obligatorio/);
  });
});
