import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runBranchCheckHook } from "../../src/application/hook-branch-check.js";
import { runTurnStartHook } from "../../src/application/hook-turn-start.js";
import { PathsService } from "../../src/application/paths-service.js";
import { newRunState, serializeRunState, withScope } from "../../src/domain/flow/run-state.js";
import type { GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const flow of ["plan-exec", "quick"] as const) {
  it(`${flow}: avisa en desarrollo entre turnos y el primer Edit se niega`, async () => {
    root = await mkdtemp(join(tmpdir(), "aw-turn-start-"));
    const repo = join(root, "source");
    const home = join(root, "home");
    await mkdir(repo);
    await mkdir(home);
    const paths = new PathsService(normalizeNamespace("workflow"), home, root);
    const fs = new NodeFileSystem();
    const env = new FakeEnv(home, root);
    const git = {
      isGitRepo: async () => true,
      currentBranch: async () => "development",
      changedFiles: async () => [],
      worktreeList: async () => [],
    } as unknown as GitPort;
    await writeFile(
      join(root, "CLAUDE.md"),
      `<!-- WORKFLOW-PROJECT-START -->\n## Proyecto\nTest\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| codigo | ${repo} | main |\n## Status\n- Modo de edición: in-place\n- Ramas por defecto:\n  - desarrollo: development\n- Ramas de trabajo actuales:\n  - codigo: feature/test\n<!-- WORKFLOW-PROJECT-END -->`,
    );
    const session = "244-turn-start-plan-exec";
    await mkdir(join(paths.cwdSessionsDir(), session), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), session, "SESSION.md"),
      "# SESSION\n\n## Objective\nprobar aviso\n",
    );
    const state =
      flow === "plan-exec"
        ? withScope(newRunState(flow, session), {
            plan: "docs/plans/072-plan-test.md",
            sources: ["codigo"],
            isolation: "in-place",
          })
        : newRunState(flow, session);
    await writeFile(
      join(paths.cwdSessionsDir(), session, ".flow-run.json"),
      serializeRunState(state),
    );
    const key = createHash("sha256").update("conversation-244").digest("hex");
    await writeFile(
      join(paths.cwdSessionsDir(), ".bindings.json"),
      JSON.stringify({ version: 1, bindings: { [key]: session } }),
    );
    const input = { fs, env, git, paths };
    const notice = await runTurnStartHook({
      ...input,
      stdin: JSON.stringify({ session_id: "conversation-244" }),
    });
    expect(notice.exitCode).toBe(0);
    expect(notice.stdout).toContain("development");
    const denial = await runBranchCheckHook({
      ...input,
      stdin: JSON.stringify({
        session_id: "conversation-244",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "code.ts") },
      }),
    });
    expect(denial.exitCode).toBe(2);
    expect(denial.stderr).toContain("development");
  });
}
