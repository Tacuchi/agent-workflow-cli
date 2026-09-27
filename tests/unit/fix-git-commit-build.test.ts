import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { fixGitCommand } from "../../src/cli/commands/fix-git.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

let root: string;
let repo: string;
let workspace: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();

function setup(build?: string) {
  root = mkdtempSync(join(tmpdir(), "aw-fixgit-build-"));
  repo = join(root, "source");
  workspace = join(root, "workspace");
  mkdirSync(repo);
  mkdirSync(workspace);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "theirs.txt"), "theirs\n");
  git("add", ".");
  git("commit", "-q", "-m", "theirs");
  git("checkout", "-q", "main");
  writeFileSync(join(repo, "ours.txt"), "ours\n");
  git("add", ".");
  git("commit", "-q", "-m", "ours");
  git("merge", "-q", "--no-commit", "--no-ff", "feature");
  const paths = new PathsService(normalizeNamespace("workflow"), root, workspace);
  writeFileSync(
    join(workspace, "AGENTS.md"),
    renderProjectBlock({
      proyecto: "Fixture",
      stack: {},
      fuentes: [{ alias: "core", path: repo, main_branch: "main" }],
      ...(build ? { pipeline: { core: { build } } } : {}),
      markers: paths.blockMarkers(),
      lastActivity: "2026-01-01",
    }),
  );
  const processPort = new NodeProcess();
  return {
    fs: new NodeFileSystem(),
    git: new GitCliAdapter(processPort),
    process: processPort,
    paths,
    env: new FakeEnv(root, workspace),
  } as unknown as CliContext;
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const args = (...flags: string[]) =>
  parseArgv(["fix-git", "commit", "--path", repo, "--message", "merge de fixture", ...flags]);

describe("fix-git commit ejecuta el build declarado", () => {
  it("muestra preview y left_out; compila y confirma sólo después de --confirm", async () => {
    const ctx = setup("test -f theirs.txt");
    writeFileSync(join(repo, "no-incluido.txt"), "pendiente\n");
    const before = git("rev-parse", "HEAD");
    const preview = await fixGitCommand.execute(args(), ctx);
    expect(preview).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
      data: {
        stage: "commit",
        committed: false,
        preview: {
          build: { status: "run", command: "test -f theirs.txt", origin: "AGENTS.md" },
          included: ["theirs.txt"],
          left_out: ["no-incluido.txt"],
        },
      },
    });
    expect(git("rev-parse", "HEAD")).toBe(before);
    const confirmed = await fixGitCommand.execute(args("--confirm"), ctx);
    expect(confirmed).toMatchObject({
      ok: true,
      data: {
        committed: true,
        build: { status: "run" },
        left_out: ["no-incluido.txt"],
        tree_differs: true,
      },
    });
    expect(git("rev-parse", "HEAD")).not.toBe(before);
  });

  it("un build que falla impide confirmar y deja el merge abierto", async () => {
    const ctx = setup("exit 7");
    const before = git("rev-parse", "HEAD");
    const result = await fixGitCommand.execute(args("--confirm"), ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "FIX_GIT_BUILD_FAILED", message: expect.stringContaining("7") },
    });
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(git("rev-parse", "--verify", "MERGE_HEAD")).toBeTruthy();
  });

  it("el build puede alterar el árbol sin agregarlo al commit y lo avisa", async () => {
    const ctx = setup("printf alterado > base.txt");
    const result = await fixGitCommand.execute(args("--confirm"), ctx);
    expect(result).toMatchObject({
      ok: true,
      data: { left_out: ["base.txt"], tree_differs: true },
    });
    expect(git("show", "HEAD:base.txt")).toBe("base");
  });

  it("si el build modifica el índice, no confirma algo distinto de la vista previa", async () => {
    const ctx = setup("printf alterado > theirs.txt && git add theirs.txt");
    const before = git("rev-parse", "HEAD");
    const result = await fixGitCommand.execute(args("--confirm"), ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "FIX_GIT_STAGED_CHANGED" } });
    expect(git("rev-parse", "HEAD")).toBe(before);
  });

  it("sin declaración se niega; skip explícito registra motivo y origen", async () => {
    const ctx = setup();
    const refused = await fixGitCommand.execute(args("--confirm"), ctx);
    expect(refused).toMatchObject({ ok: false, error: { code: "FIX_GIT_BUILD_UNDECLARED" } });
    const skipped = await fixGitCommand.execute(
      args("--skip-build", "se verificó externamente", "--confirm"),
      ctx,
    );
    expect(skipped).toMatchObject({
      ok: true,
      data: {
        build: { status: "skipped", reason: "se verificó externamente", origin: "--skip-build" },
      },
    });
  });

  it("ninguno declarado evita build y deja su origen visible", async () => {
    const ctx = setup("ninguno");
    const none = await fixGitCommand.execute(args("--confirm"), ctx);
    expect(none).toMatchObject({
      ok: true,
      data: { build: { status: "skipped", reason: "ninguno declarado", origin: "AGENTS.md" } },
    });
  });

  it("--skip-build sin motivo no llega a confirmar", async () => {
    const ctx = setup("exit 7");
    const result = await fixGitCommand.execute(args("--skip-build", "--confirm"), ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ARGS_INVALID", message: expect.stringContaining("motivo") },
    });
    expect(git("rev-parse", "--verify", "MERGE_HEAD")).toBeTruthy();
  });
});
