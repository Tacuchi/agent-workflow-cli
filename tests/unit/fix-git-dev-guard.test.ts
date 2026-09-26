import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { fixGitCommand } from "../../src/cli/commands/fix-git.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * PR-04 en `aw fix-git` (AC-10 de la spec 051), sobre git real: un merge en
 * curso que trae la rama de desarrollo a una rama de trabajo no se prepara ni
 * se cierra — tampoco en una unidad `aw/*` ni sin flags —, y los demás merges
 * siguen como hoy.
 */

const PROD = "certificacion";
const DEV = "desarrollo";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function commitFile(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `add ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

function args(rest: string[], opts: { path?: string; flags?: string[]; message?: string } = {}) {
  const values = new Map<string, string>();
  if (opts.message !== undefined) values.set("message", opts.message);
  return {
    rest,
    plugin: {},
    flags: new Set(opts.flags ?? []),
    values,
    valuesMulti: new Map(opts.path !== undefined ? [["path", [opts.path]]] : []),
  } as ParsedArgs;
}

describe("aw fix-git no cierra un merge que trae desarrollo a una rama de trabajo (PR-04)", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let home: string;
  let source: string;
  let workspace: string;

  beforeAll(() => {
    const globals = mkdtempSync(join(tmpdir(), "aw-fixgit-globals-"));
    writeFileSync(join(globals, "gitconfig"), "");
    const env: Record<string, string> = {
      GIT_CONFIG_GLOBAL: join(globals, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    };
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "aw-fixgit-")));
    home = join(root, "home");
    source = join(root, "source");
    workspace = join(root, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    git(root, "init", "-q", "-b", PROD, source);
    commitFile(source, "base.txt");
    // Desarrollo: un commit propio y la integración de una feature por un merge.
    git(source, "checkout", "-q", "-b", DEV);
    commitFile(source, "dev-propio.txt");
    git(source, "checkout", "-q", "-b", "feature/integrada", PROD);
    commitFile(source, "integrada.txt");
    git(source, "checkout", "-q", DEV);
    git(source, "merge", "-q", "--no-ff", "-m", "integra feature/integrada", "feature/integrada");
    git(source, "checkout", "-q", "-b", "feature/a", PROD);
    commitFile(source, "a.txt");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A CLI context whose Workline root is `root`, with the WORKSPACE block written
   * there. Without flags `fix-git` inspects that root, so a no-flag invocation is
   * a workspace whose block lives in the repo itself — including inside an
   * `aw/*` unit, whose root is the unit.
   */
  function ctx(root = workspace, withBlock = true): CliContext {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), home, root);
    const block = renderProjectBlock({
      proyecto: "Fixture",
      fuentes: [{ alias: "core", path: source, main_branch: PROD }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      defaultBranches: { desarrollo: DEV },
      workingBranches: { core: "feature/a" },
      qaBranches: {},
      markers: paths.blockMarkers(),
    });
    if (withBlock) writeFileSync(join(root, "CLAUDE.md"), block, "utf8");
    return {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, root),
      paths,
      git: new GitCliAdapter(new NodeProcess()),
    } as unknown as CliContext;
  }

  /** A merge left in progress (no commit yet) on `repo`, bringing `from`. */
  function startMerge(repo: string, from: string): string {
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "merge", "-q", "--no-commit", "--no-ff", from);
    return head;
  }

  const commit = (opts: { path?: string } = {}) =>
    args(["commit"], { ...opts, flags: ["--confirm"], message: "cierra el merge" });

  it("desarrollo mezclado en una rama de trabajo se rechaza en prepare y en commit, sin commit nuevo", async () => {
    const head = startMerge(source, DEV);

    const prepared = await fixGitCommand.execute(args(["prepare"], { path: source }), ctx());
    const closed = await fixGitCommand.execute(commit({ path: source }), ctx());

    for (const result of [prepared, closed]) {
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("FIX_GIT_DEV_INTO_WORK");
      expect(result.error?.message).toMatch(
        /PR-04: el merge en curso trae la rama de desarrollo desarrollo .* a la rama de trabajo feature\/a/,
      );
      expect(result.error?.message).toMatch(/roles de la fuente core/);
    }
    expect(git(source, "rev-parse", "HEAD")).toBe(head);
    expect(git(source, "rev-parse", "--verify", "MERGE_HEAD")).not.toBe("");
  });

  /** An `aw/*` unit of the source on `aw/300-x-plan-exec`, cut from feature/a. */
  function unitOf(): string {
    const unit = join(home, ".agent-workflow", "worktrees", "ws-key", "core", "300-x-plan-exec");
    mkdirSync(join(unit, ".."), { recursive: true });
    git(source, "worktree", "add", "-q", "-b", "aw/300-x-plan-exec", unit, "feature/a");
    return unit;
  }

  it("en una unidad aw/* nombrada desde el workspace (--path), se rechaza con los roles de su fuente", async () => {
    const unit = unitOf();
    const head = startMerge(unit, DEV);

    const prepared = await fixGitCommand.execute(args(["prepare"], { path: unit }), ctx());
    const closed = await fixGitCommand.execute(commit({ path: unit }), ctx());

    for (const result of [prepared, closed]) {
      expect(result.error?.code).toBe("FIX_GIT_DEV_INTO_WORK");
      expect(result.error?.message).toMatch(/a la rama de trabajo aw\/300-x-plan-exec/);
      // La unidad no está bajo la ruta declarada: la fuente dueña sale de la raíz de las unidades.
      expect(result.error?.message).toMatch(/roles de la fuente core/);
    }
    expect(git(unit, "rev-parse", "HEAD")).toBe(head);
  });

  it("dentro de la unidad y sin flags no hay bloque que diga sus roles: falla cerrado", async () => {
    // La raíz de Workline dentro de una unidad es la unidad, que no trae bloque.
    const unit = unitOf();
    const head = startMerge(unit, DEV);

    const prepared = await fixGitCommand.execute(args(["prepare"]), ctx(unit, false));
    const closed = await fixGitCommand.execute(commit(), ctx(unit, false));

    for (const result of [prepared, closed]) {
      expect(result.error?.code).toBe("FIX_GIT_ROLES_UNKNOWN");
      expect(result.error?.message).toMatch(/es una unidad aw\/\* y no hay bloque WORKSPACE/);
    }
    expect(git(unit, "rev-parse", "HEAD")).toBe(head);
  });

  it("un merge octopus que trae desarrollo en su segunda cabeza también se rechaza", async () => {
    git(source, "checkout", "-q", "-b", "feature/c", PROD);
    commitFile(source, "c.txt");
    git(source, "checkout", "-q", "feature/a");
    const head = git(source, "rev-parse", "HEAD");
    git(source, "merge", "-q", "--no-commit", "--no-ff", "feature/c", DEV);

    const closed = await fixGitCommand.execute(commit({ path: source }), ctx());

    expect(closed.error?.code).toBe("FIX_GIT_DEV_INTO_WORK");
    expect(git(source, "rev-parse", "HEAD")).toBe(head);
  });

  it("un merge --squash no se cierra con fix-git: no hay merge en curso que cerrar", async () => {
    const head = git(source, "rev-parse", "HEAD");
    git(source, "merge", "-q", "--squash", DEV);

    const closed = await fixGitCommand.execute(commit({ path: source }), ctx());

    expect(closed.error?.code).toBe("NOT_MERGING");
    expect(git(source, "rev-parse", "HEAD")).toBe(head);
  });

  it("sin flags desde el checkout de la fuente, también se rechaza", async () => {
    startMerge(source, DEV);

    const result = await fixGitCommand.execute(args(["prepare"]), ctx(source));

    expect(result.error?.code).toBe("FIX_GIT_DEV_INTO_WORK");
  });

  it("una rama de trabajo mezclada en otra, que ya pasó por desarrollo, sigue como hoy", async () => {
    const head = startMerge(source, "feature/integrada");

    const closed = await fixGitCommand.execute(commit({ path: source }), ctx());

    expect(closed.ok).toBe(true);
    expect(git(source, "rev-parse", "HEAD^1")).toBe(head);
  });

  it("un merge sobre la rama de desarrollo sigue como hoy", async () => {
    git(source, "checkout", "-q", DEV);
    const head = startMerge(source, "feature/a");

    const closed = await fixGitCommand.execute(commit({ path: source }), ctx());

    expect(closed.ok).toBe(true);
    expect(git(source, "rev-parse", "HEAD^1")).toBe(head);
  });

  it("sin fuente dueña del repo, rigen los roles por defecto del workspace y la salida lo dice", async () => {
    const stray = join(root, "stray");
    git(root, "clone", "-q", source, stray);
    git(stray, "checkout", "-q", "-b", "feature/z", `origin/${PROD}`);
    startMerge(stray, `origin/${DEV}`);

    const result = await fixGitCommand.execute(args(["prepare"], { path: stray }), ctx());

    expect(result.error?.code).toBe("FIX_GIT_DEV_INTO_WORK");
    expect(result.error?.message).toMatch(/origin\/desarrollo/);
    expect(result.error?.message).toMatch(/valores por defecto del workspace/);
  });
});
