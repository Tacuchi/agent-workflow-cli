import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runBranchCheckHook } from "../../src/application/hook-branch-check.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function fakeGit(opts: {
  current: string;
  isRepo?: boolean;
  changed?: string[];
}): GitPort {
  return {
    isGitRepo: async () => opts.isRepo ?? true,
    currentBranch: async () => opts.current,
    changedFiles: async () => opts.changed ?? [],
  } as unknown as GitPort;
}

// WORKSPACE block: source `acme` with a declared WORKING branch. The source path
// is filled per-test so it points at a real on-disk dir inside the workspace.
function buildBlock(opts: { sourcePath: string; workingBranch?: string }): string {
  const working = opts.workingBranch
    ? `- Ramas de trabajo actuales:\n  - acme: ${opts.workingBranch}\n`
    : "";
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

Test.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| acme | ${opts.sourcePath} | main |

## Stack

_Stack sin detectar._

## Status

${working}- Última actividad: 2026-01-01
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
}

describe("runBranchCheckHook — expected = WORKSPACE working branch", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;
  let sourcePath: string;

  function editStdin(filePath: string): string {
    return JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath } });
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "branch-check-"));
    sourcePath = join(workspace, "acme");
    mkdirSync(sourcePath, { recursive: true });
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("blocks when HEAD differs from the declared working branch", async () => {
    writeFileSync(
      join(workspace, "CLAUDE.md"),
      buildBlock({ sourcePath, workingBranch: "feature/x" }),
    );
    const r = await runBranchCheckHook({
      stdin: editStdin(join(sourcePath, "src/foo.ts")),
      fs,
      env,
      paths,
      git: fakeGit({ current: "main" }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Rama esperada: feature/x");
    expect(r.stderr).toContain("Rama actual:   main");
  });

  it("allows when HEAD matches the declared working branch", async () => {
    writeFileSync(
      join(workspace, "CLAUDE.md"),
      buildBlock({ sourcePath, workingBranch: "feature/x" }),
    );
    const r = await runBranchCheckHook({
      stdin: editStdin(join(sourcePath, "src/foo.ts")),
      fs,
      env,
      paths,
      git: fakeGit({ current: "feature/x" }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
  });

  it("no-ops when the source declares NO working branch (main is base, not expected)", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), buildBlock({ sourcePath }));
    const r = await runBranchCheckHook({
      stdin: editStdin(join(sourcePath, "src/foo.ts")),
      fs,
      env,
      paths,
      git: fakeGit({ current: "anything" }),
    });
    expect(r.exitCode).toBe(0);
  });

  it("no-ops when the edited file is outside any declared source", async () => {
    writeFileSync(
      join(workspace, "CLAUDE.md"),
      buildBlock({ sourcePath, workingBranch: "feature/x" }),
    );
    const r = await runBranchCheckHook({
      stdin: editStdin("/elsewhere/file.ts"),
      fs,
      env,
      paths,
      git: fakeGit({ current: "main" }),
    });
    expect(r.exitCode).toBe(0);
  });
});
