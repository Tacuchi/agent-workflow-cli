import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { locateRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import { FLOW_RUN_STATE_VERSION, serializeRunState } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { stateWrittenAt } from "../helpers/journey-fixtures.js";

const SESSION = "001-cierre-quick";

describe("frontera humana de commit del workspace", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function close(choice: string, includeApproval: boolean, failHistory = false) {
    root = mkdtempSync(join(tmpdir(), "aw-close-commit-"));
    const workspace = join(root, "uno");
    const dir = join(workspace, ".workflow", "sessions", SESSION);
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.com");
    writeFileSync(join(root, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-qm", "base");
    const paths = new PathsService(normalizeNamespace("workflow"), root, workspace);
    class HistoryFs extends NodeFileSystem {
      override async writeText(path: string, content: string): Promise<void> {
        if (failHistory && path === paths.cwdHistoryFile() && content.includes("| closed |"))
          throw new Error("HISTORY no disponible");
        return super.writeText(path, content);
      }
    }
    const fs = new HistoryFs();
    const process = new NodeProcess();
    const adapter = new GitCliAdapter(process);
    await fs.writeText(
      paths.cwdHistoryFile(),
      "# Session History\n\n| Sesión | Fecha | Estado | Refs |\n|---|---|---|---|\n| 001-cierre-quick | 2026-09-27 | active | — |\n",
    );
    await fs.writeText(
      join(dir, "SESSION.md"),
      "# SESSION\n\n## Objective\ncerrar\n\n## Origin\n- pedido\n\n## Success criteria\n- [x] cerrado\n",
    );
    const ids = journeyOfFlow("quick").map((step) => step.id);
    const state = stateWrittenAt(
      FLOW_RUN_STATE_VERSION,
      "quick",
      SESSION,
      ids.slice(0, -2),
      "chassis.commit-choice",
      { journey_base: ids },
    );
    await fs.writeText(locateRun(paths, SESSION).statePath, serializeRunState(state));
    const executor = internalActionExecutor({
      fs,
      env: new FakeEnv(root, workspace),
      paths,
      git: adapter,
    });
    const standing = await advanceFlow(fs, paths, {
      code: SESSION,
      adopt: false,
      executor,
      git: adapter,
    });
    if (!standing.ok) throw new Error(JSON.stringify(standing));
    expect(standing.directive.boundary.transition).toBe("chassis.commit-choice");
    const before = git("rev-parse", "HEAD").trim();
    const prepared = await import("../../src/application/workspace-commit-service.js").then((mod) =>
      mod.runWorkspaceCommit(fs, adapter, process, paths, { code: SESSION }),
    );
    if (!("proposal" in prepared)) throw new Error(JSON.stringify(prepared));
    const answer = await submitFlow(fs, paths, {
      code: SESSION,
      raw: JSON.stringify({
        input_digest: standing.directive.state_digest,
        choice,
        decisions: includeApproval ? { commit_approval: prepared.proposal.approval } : {},
      }),
      approval: null,
      executor,
      git: adapter,
      process,
    });
    if (!answer.ok) throw new Error(JSON.stringify(answer));
    return {
      before,
      after: git("rev-parse", "HEAD").trim(),
      fs,
      dir,
      git,
      directive: answer.directive,
    };
  }

  it("cerrar sin commit persiste cierre y archivo sin mover HEAD", async () => {
    const result = await close("Cerrar sin commit", false);
    expect(result.after).toBe(result.before);
    expect(await result.fs.exists(join(result.dir, ".closed"))).toBe(true);
    expect(
      await result.fs.exists(join(root, "uno", ".workflow", "archive", SESSION, "CHECKPOINT.md")),
    ).toBe(true);
  });

  it("aprobar digest del pathspec cierra y ejecuta exactamente un commit", async () => {
    const result = await close("Aprobar commit del workspace", true);
    expect(result.after).not.toBe(result.before);
    expect(await result.fs.exists(join(result.dir, ".closed"))).toBe(true);
    expect(result.git("show", "--pretty=format:", "--name-only", "HEAD")).toContain(
      "uno/.workflow/archive/001-cierre-quick/CHECKPOINT.md",
    );
  });

  it("una fila HISTORY que no se pudo cerrar impide el commit aprobado", async () => {
    const result = await close("Aprobar commit del workspace", true, true);
    expect(result.after).toBe(result.before);
    expect(await result.fs.exists(join(result.dir, ".closed"))).toBe(true);
    expect(result.directive.applied.some((item) => item.transition === "chassis.finalize")).toBe(
      true,
    );
  });
});
