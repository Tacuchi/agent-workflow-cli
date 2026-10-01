import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { runHubCommit } from "../../src/application/hub-commit-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { readCustody, writeCustody } from "../../src/application/session-custody-service.js";
import { sealCustody } from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("workspace-commit por rutas en un repo padre", () => {
  let root: string;
  const fs = new NodeFileSystem();
  const process = new NodeProcess();
  const gitPort = new GitCliAdapter(process);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("sin aprobación no commitea; con ella sólo incluye HISTORY, spec propia y mínimo", async () => {
    root = mkdtempSync(join(tmpdir(), "aw-workspace-commit-"));
    const hub = join(root, "uno");
    mkdirSync(join(hub, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "otro"));
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(root, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-qm", "base");
    const paths = new PathsService(normalizeNamespace("workflow"), root, hub);
    const first = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "propia-quick",
      objetivo: "publicar",
    });
    const second = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "ajena-quick",
      objetivo: "esperar",
    });
    if ("error" in first || "error" in second) throw new Error("no se pudieron crear las sesiones");
    writeFileSync(join(hub, ".workflow", "doc-branches.jsonl"), "\n");
    const own = first.sessionCreate;
    const other = second.sessionCreate;
    const ownSpec = "docs/specs/001-spec-propia.md";
    const pending = "docs/specs/002-spec-pendiente.md";
    writeFileSync(join(hub, ownSpec), "# propia\n");
    writeFileSync(join(hub, pending), "# pendiente\n");
    writeFileSync(join(root, "otro", "staged.txt"), "otro workspace\n");
    const owner = await readCustody(fs, own.path);
    const foreign = await readCustody(fs, other.path);
    if (owner.status !== "present" || foreign.status !== "present")
      throw new Error("faltó custodia");
    const { digest: _old, ...ownCustody } = owner.custody;
    const { digest: _otherOld, ...foreignCustody } = foreign.custody;
    await writeCustody(
      fs,
      own.path,
      sealCustody({
        ...ownCustody,
        subjectPath: ownCustody.subject_path,
        effects: [
          {
            kind: "artifact_published",
            alias: null,
            before: null,
            after: null,
            parents: [],
            ref: null,
            paths: [ownSpec, pending],
            at: "2026-09-27",
          },
        ],
      }),
    );
    await writeCustody(
      fs,
      other.path,
      sealCustody({
        ...foreignCustody,
        subjectPath: foreignCustody.subject_path,
        artifacts: [
          {
            path: pending,
            role: "output",
            before: { existed: false, digest: null, bytes: null, content: null },
          },
        ],
      }),
    );
    await fs.writeText(
      join(own.path, "SESSION.md"),
      "# SESSION\n\n## Objective\npublicar\n\n## Origin\n- pedido\n\n## Success criteria\n- [x] publicada\n",
    );
    const beforeClose = await runHubCommit(fs, gitPort, process, paths, { code: own.folder });
    if (!("proposal" in beforeClose)) throw new Error(JSON.stringify(beforeClose));
    const close = await runSessionClose(
      fs,
      paths,
      { code: own.folder },
      undefined,
      gitPort,
      process,
    );
    if (!("sessionClose" in close)) throw new Error(JSON.stringify(close));
    expect(close).toHaveProperty("sessionClose.closed", true);
    expect(close.sessionClose.commit_proposal?.approval).toBe(beforeClose.proposal.approval);
    git("add", "otro/staged.txt", "uno/docs/specs/002-spec-pendiente.md");
    const before = git("rev-parse", "HEAD").trim();
    const preview = await runHubCommit(fs, gitPort, process, paths, { code: own.folder });
    if (!("proposal" in preview)) throw new Error(JSON.stringify(preview));
    expect(preview.proposal.approval).toBe(beforeClose.proposal.approval);
    expect(preview.proposal.paths).toEqual([
      "uno/.workflow/HISTORY.md",
      `uno/.workflow/archive/${own.folder}/CHECKPOINT.md`,
      "uno/.workflow/doc-branches.jsonl",
      "uno/docs/specs/001-spec-propia.md",
    ]);
    expect(preview.proposal.excluded).toEqual(["uno/docs/specs/002-spec-pendiente.md"]);
    expect(git("rev-parse", "HEAD").trim()).toBe(before);
    expect(
      await runHubCommit(fs, gitPort, process, paths, {
        code: own.folder,
        approval: "vencido",
      }),
    ).toHaveProperty("error");
    const applied = await runHubCommit(fs, gitPort, process, paths, {
      code: own.folder,
      approval: preview.proposal.approval,
    });
    if (!("proposal" in applied) || !applied.committed) throw new Error(JSON.stringify(applied));
    expect(
      git("show", "--pretty=format:", "--name-only", "HEAD").trim().split("\n").sort(),
    ).toEqual(preview.proposal.paths);
    expect(git("diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual([
      "otro/staged.txt",
      "uno/docs/specs/002-spec-pendiente.md",
    ]);
  });

  it("un export también propone HISTORY y aplica sólo su documento aprobado", async () => {
    root = mkdtempSync(join(tmpdir(), "aw-export-commit-"));
    const hub = join(root, "uno");
    mkdirSync(join(hub, "docs", "reports"), { recursive: true });
    mkdirSync(join(root, "otro"));
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.com");
    writeFileSync(join(root, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-qm", "base");
    const paths = new PathsService(normalizeNamespace("workflow"), root, hub);
    writeFileSync(join(hub, "docs", "reports", "001-report.md"), "# Informe\n");
    mkdirSync(join(hub, ".workflow"));
    writeFileSync(paths.cwdHistoryFile(), "# History\n");
    writeFileSync(join(root, "otro", "pendiente.md"), "pendiente\n");
    git("add", "otro/pendiente.md");
    const preview = await runHubCommit(fs, gitPort, process, paths, {
      exportPath: "docs/reports/001-report.md",
    });
    if (!("proposal" in preview)) throw new Error(JSON.stringify(preview));
    expect(preview.proposal.paths).toEqual([
      "uno/.workflow/HISTORY.md",
      "uno/docs/reports/001-report.md",
    ]);
    const applied = await runHubCommit(fs, gitPort, process, paths, {
      exportPath: "docs/reports/001-report.md",
      approval: preview.proposal.approval,
    });
    expect(applied).toHaveProperty("committed.after");
    expect(
      git("show", "--pretty=format:", "--name-only", "HEAD").trim().split("\n").sort(),
    ).toEqual(preview.proposal.paths);
    expect(git("diff", "--cached", "--name-only").trim()).toBe("otro/pendiente.md");
  });
});
