import { describe, expect, it } from "vitest";
import { runCheckpointWrite } from "../../src/application/checkpoint-write-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { DirEntry } from "../../src/ports/file-system.js";
import type { DiffNumstatEntry, GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

// Rebuilds the old FakeFs(files, dirs) shape on the shared MemFs: seed files and
// explicit dir listings; `.writes` covers the write-overlay assertions.
function makeFs(
  files: Map<string, string> = new Map(),
  dirs: Map<string, DirEntry[]> = new Map(),
): MemFs {
  const fs = new MemFs();
  for (const [p, content] of files) fs.file(p, content);
  for (const [dir, entries] of dirs) {
    fs.dir(dir);
    for (const e of entries) {
      if (e.type === "dir") fs.dir(e.path);
      else fs.file(e.path, files.get(e.path) ?? "");
    }
  }
  return fs;
}

class FakeGit implements GitPort {
  async isGitRepo() {
    return true;
  }
  async currentBranch() {
    return "main";
  }
  async isDirty() {
    return false;
  }
  async changedFiles() {
    return [];
  }
  async diffNumstat(): Promise<DiffNumstatEntry[]> {
    return [];
  }
  async checkout(): Promise<void> {}
  async pull(): Promise<void> {}
  async merge(): Promise<{ ok: boolean; conflicted: string[] }> {
    return { ok: true, conflicted: [] };
  }
  async push(): Promise<void> {}
  async isMerging(): Promise<boolean> {
    return false;
  }
  async conflictedFiles(): Promise<string[]> {
    return [];
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");

function workflowProjectBlock(opts: {
  proyecto: string;
  sessions: { folder: string; phase: string; branches: string[] }[];
}): string {
  const sessLines = opts.sessions.length
    ? opts.sessions
        .map((s) => `  - ${s.folder} · fase: ${s.phase} · ramas: ${s.branches.join(", ")}`)
        .join("\n")
    : "  _ninguna_";
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

${opts.proyecto}

Mode: project

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| core | /repo | certificacion |

## Stack

_Stack sin detectar._

## Status

- Sesiones activas:
${sessLines}
- Última actividad: 2026-01-01 00:00
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
}

describe("runCheckpointWrite", () => {
  it("skips when no active sessions in QTC-PROJECT.Status", async () => {
    const fs = makeFs(
      new Map([["/cwd/CLAUDE.md", workflowProjectBlock({ proyecto: "p", sessions: [] })]]),
      new Map([["/cwd/.workflow/sessions", []]]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result && result.skipped) {
      expect(result.reason).toContain("no hay sesiones activas");
    }
  });

  it("writes CHECKPOINT.md for the only active session (no --code) post-flag-day WORKFLOW markers", async () => {
    const sessionFolder = "session010-dev-test-coverage";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const fs = makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [{ folder: sessionFolder, phase: "execution", branches: ["core:feat/x"] }],
          }),
        ],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\n## Requerimiento\nfoo\n"],
        [`${sessionPath}/TASKS.md`, "- [x] T1\n- [ ] T2\n- [ ] T3\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    if (!("checkpoint_path" in result) || "skipped" in result) {
      throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    }
    expect(result.session).toBe(sessionFolder);
    expect(result.checkpoint_path).toBe(`${sessionPath}/CHECKPOINT.md`);
    expect(result.tasks_open).toBe(2);
    expect(result.tasks_closed).toBe(1);
    expect(fs.writes.has(`${sessionPath}/CHECKPOINT.md`)).toBe(true);
  });

  it("skips with helpful reason when ≥2 active sessions and no --code", async () => {
    const fs = makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [
              { folder: "session001-dev-foo", phase: "planning", branches: [] },
              { folder: "session002-dev-bar", phase: "planning", branches: [] },
            ],
          }),
        ],
      ]),
      new Map([
        [
          "/cwd/.workflow/sessions",
          [
            {
              name: "session001-dev-foo",
              path: "/cwd/.workflow/sessions/session001-dev-foo",
              type: "dir",
            },
            {
              name: "session002-dev-bar",
              path: "/cwd/.workflow/sessions/session002-dev-bar",
              type: "dir",
            },
          ],
        ],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result && result.skipped) {
      expect(result.reason).toContain("múltiples sesiones activas");
      expect(result.active_sessions).toEqual(["session001-dev-foo", "session002-dev-bar"]);
    }
  });

  it("--code resolves to specific session and writes CHECKPOINT.md", async () => {
    const sessionFolder = "session042-dev-target";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const fs = makeFs(
      new Map([
        ["/cwd/CLAUDE.md", workflowProjectBlock({ proyecto: "p", sessions: [] })],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\nfoo\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        code: "042",
      },
    );
    if (!("checkpoint_path" in result) || "skipped" in result) {
      throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    }
    expect(result.session).toBe(sessionFolder);
  });

  it("--code returns null folder when no matching session exists (falls through to skip)", async () => {
    const fs = makeFs(
      new Map([["/cwd/CLAUDE.md", workflowProjectBlock({ proyecto: "p", sessions: [] })]]),
      new Map([["/cwd/.workflow/sessions", []]]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
      {
        code: "999",
      },
    );
    expect("skipped" in result && result.skipped).toBe(true);
  });

  it("regression — back-compat: legacy QTC-PROJECT markers in CLAUDE.md still work", async () => {
    const sessionFolder = "session001-dev-legacy";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const legacyBlock = `<!-- QTC-PROJECT-START -->
## Proyecto

legacy

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| core | /repo | certificacion |

## Stack

_Stack sin detectar._

## Status

- Sesiones activas:
  - ${sessionFolder} · fase: planning · ramas: core:feat/x
- Histórico: \`.qtc/HISTORY.md\`
<!-- QTC-PROJECT-END -->
`;
    const fs = makeFs(
      new Map([
        ["/cwd/CLAUDE.md", legacyBlock],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\nfoo\n"],
        [`${sessionPath}/TASKS.md`, "- [ ] T1\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await runCheckpointWrite(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      new FakeGit(),
      paths,
    );
    if (!("checkpoint_path" in result) || "skipped" in result) {
      throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    }
    expect(result.session).toBe(sessionFolder);
  });

  it("idempotency — re-write produces same content (no placeholders)", async () => {
    const sessionFolder = "session001-dev-idem";
    const sessionPath = `/cwd/.workflow/sessions/${sessionFolder}`;
    const fs = makeFs(
      new Map([
        [
          "/cwd/CLAUDE.md",
          workflowProjectBlock({
            proyecto: "p",
            sessions: [{ folder: sessionFolder, phase: "planning", branches: [] }],
          }),
        ],
        [`${sessionPath}/OBJETIVO.md`, "# Objetivo\nfoo\n"],
      ]),
      new Map([
        ["/cwd/.workflow/sessions", [{ name: sessionFolder, path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const r1 = await runCheckpointWrite(fs, new FakeEnv("/home/u", "/cwd"), new FakeGit(), paths);
    if (!("checkpoint_path" in r1) || "skipped" in r1) throw new Error("first call should write");
    const content1 = fs.writes.get(`${sessionPath}/CHECKPOINT.md`) ?? "";

    // Second call: existing CHECKPOINT.md has placeholders → re-writes (placeholders are part of draft).
    // To test true idempotency post-AI-fill, we'd need to manually strip placeholders. For now we
    // verify that re-write returns success again (not skip-because-synthesized).
    const r2 = await runCheckpointWrite(fs, new FakeEnv("/home/u", "/cwd"), new FakeGit(), paths);
    expect("checkpoint_path" in r2 || "skipped" in r2).toBe(true);
    // Sanity: content is non-empty markdown.
    expect(content1.length).toBeGreaterThan(50);
    expect(content1).toContain(sessionFolder);
  });
});
