import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runGitCommitAdvisor } from "../../src/application/hook-git-commit-advisor.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeEnv implements EnvPort {
  constructor(
    private readonly _cwd: string,
    private readonly _vars: Record<string, string> = {},
  ) {}
  get(name: string): string | undefined {
    return this._vars[name];
  }
  homeDir(): string {
    return this._cwd;
  }
  cwd(): string {
    return this._cwd;
  }
}

function buildBlock(opts: {
  sessions?: string[];
  workingBranches?: Record<string, string>;
}): string {
  const sessions = opts.sessions ?? [];
  const sessionLines =
    sessions.length === 0
      ? "  - _ninguna_"
      : sessions
          .map((folder) => `  - ${folder} · fase: execution · ramas: agent-workflow:feature/last`)
          .join("\n");
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

Test project.

Mode: hub

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| agent-workflow | /tmp/aw | certificacion |

## Stack

_Stack sin detectar._

## Status

- Ramas de trabajo actuales:
  - agent-workflow: feature/last
- Sesiones activas:
${sessionLines}
- Última actividad: 2026-05-17
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
}

describe("runGitCommitAdvisor", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "git-commit-advisor-"));
    env = new FakeEnv(workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("caso A: tool_name != Bash → exit 0 silent", async () => {
    const stdin = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/x" } });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso A.2: Bash sin git commit → exit 0 silent", async () => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso A.3: git commit sin -m (interactivo) → exit 0 silent (no message a validar)", async () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git commit --amend" },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso B: git commit con -m pero sin QTC-PROJECT block → exit 0 silent", async () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix algo"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso B.2: git commit con -m y QTC-PROJECT pero sin sesión activa → exit 0 silent", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sessions: [] }));
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix algo"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso C: sesión activa, mensaje sin tag → advisor stderr + exit 0", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sessions: ["session053-dev-foo"] }));
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix algo"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeDefined();
    expect(r.stderr).toContain("session053");
    expect(r.stderr).toContain("git-commit-advisor");
    expect(r.stderr).toContain("AW_COMMIT_ADVISOR=off");
  });

  it("caso D: sesión activa, mensaje con tag → exit 0 silent", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sessions: ["session053-dev-foo"] }));
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix algo (session053)"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso D.2: tag con código diferente también es aceptado (regex laxo session\\d{3})", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sessions: ["session053-dev-foo"] }));
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "[session999] hotfix de emergencia"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso E: AW_COMMIT_ADVISOR=off bypass → exit 0 silent aunque haya sesión sin tag", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sessions: ["session053-dev-foo"] }));
    const envOff = new FakeEnv(workspace, { AW_COMMIT_ADVISOR: "off" });
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix algo"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env: envOff, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso F: comillas simples también se parsean correctamente", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sessions: ["session053-dev-foo"] }));
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'fix sin tag'" },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeDefined();
    expect(r.stderr).toContain("session053");
  });

  it("caso G: stdin inválido (no JSON) → exit 0 silent", async () => {
    const r = await runGitCommitAdvisor({ stdin: "not-json", fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("caso H: AGENTS.md fallback cuando no hay CLAUDE.md", async () => {
    writeFileSync(join(workspace, "AGENTS.md"), buildBlock({ sessions: ["session077-dev-bar"] }));
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix sin tag"' },
    });
    const r = await runGitCommitAdvisor({ stdin, fs, env, paths });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeDefined();
    expect(r.stderr).toContain("session077");
  });
});
