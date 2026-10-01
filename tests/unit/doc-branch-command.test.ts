import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { readDocBranches } from "../../src/application/doc-branch-ledger.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";
import { docBranchCommand } from "../../src/cli/commands/doc-branch.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function args(action: string, values: Record<string, string>): ParsedArgs {
  return {
    rest: [action],
    plugin: {},
    flags: new Set(),
    values: new Map(Object.entries(values).filter(([key]) => key !== "source")),
    valuesMulti: new Map(values.source ? [["source", [values.source]]] : []),
  };
}

describe("aw doc-branch show|set", () => {
  let root: string;
  let repo: string;
  let origin: string;
  let ctx: CliContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "doc-branch-command-"));
    origin = join(root, "origin.git");
    repo = join(root, "repo");
    const ws = join(root, "workspace");
    mkdirSync(ws);
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, repo);
    git(repo, "config", "user.email", "fixture@example.com");
    git(repo, "config", "user.name", "Fixture");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-qm", "base");
    git(repo, "push", "-q", "origin", "main");
    const paths = new PathsService(normalizeNamespace("workflow"), root, ws);
    mkdirSync(paths.cwdRoot());
    mkdirSync(join(ws, "docs", "plans"), { recursive: true });
    mkdirSync(join(ws, "docs", "specs"), { recursive: true });
    writeFileSync(join(ws, "docs", "plans", "067-plan-rama.md"), "# Plan 067\n");
    writeFileSync(join(ws, "docs", "specs", "049-spec-rama.md"), "# Spec 049\n");
    writeFileSync(
      join(ws, "CLAUDE.md"),
      renderHubBlock({
        proyecto: "Fixture",
        fuentes: [{ alias: "core", path: repo, main_branch: "main" }],
        stack: {},
        lastActivity: "2026-09-27",
        workingBranches: { core: "feature/default" },
        qaBranches: {},
        markers: paths.blockMarkers(),
      }),
    );
    ctx = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(root, ws),
      paths,
      git: new GitCliAdapter(new NodeProcess()),
    } as unknown as CliContext;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("show sólo lee referencias locales y propone el nombre por documento", async () => {
    const before = git(repo, "status", "--porcelain");
    const result = await docBranchCommand.execute(args("show", { doc: "plan:067" }), ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      doc: "plan:067",
      sources: [
        {
          proposed: "feature/plan-067-rama",
          origin: "registered",
          branch: "feature/default",
          local: false,
        },
      ],
    });
    expect((result.data as { next: string }).next).toContain("Confirmá");
    expect(existsSync(join(root, "workspace", ".workflow", "doc-branches.jsonl"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe(before);
  });

  it("crea desde origin/main sin upstream y cambia sólo la asociación nombrada", async () => {
    const one = await docBranchCommand.execute(
      args("set", { doc: "plan:067", source: "core", rama: "feature/elegida" }),
      ctx,
    );
    expect(one.ok).toBe(true);
    expect(one.data).toMatchObject({ outcome: "created", branch: "feature/elegida" });
    expect(git(repo, "rev-parse", "feature/elegida")).toBe(git(repo, "rev-parse", "origin/main"));
    expect(() => git(repo, "rev-parse", "feature/elegida@{upstream}")).toThrow();
    const two = await docBranchCommand.execute(
      args("set", { doc: "spec:049", source: "core", rama: "feature/segunda" }),
      ctx,
    );
    expect(two.ok).toBe(true);
    const update = await docBranchCommand.execute(
      args("set", { doc: "plan:067", source: "core", rama: "feature/tercera" }),
      ctx,
    );
    expect(update.ok).toBe(true);
    const read = await readDocBranches(ctx.fs, ctx.paths);
    expect(read.events.map((event) => event.branch)).toEqual([
      "feature/elegida",
      "feature/segunda",
      "feature/tercera",
    ]);
  });

  it("reutiliza la rama local, trae la homónima remota y rechaza roles, aw/* y fuentes desconocidas", async () => {
    git(repo, "branch", "feature/local");
    const local = await docBranchCommand.execute(
      args("set", { doc: "plan:067", source: "core", rama: "feature/local" }),
      ctx,
    );
    expect(local.data).toMatchObject({ outcome: "existing" });
    git(repo, "push", "-q", "origin", "main:refs/heads/feature/remota");
    const remote = await docBranchCommand.execute(
      args("set", { doc: "plan:067", source: "core", rama: "feature/remota" }),
      ctx,
    );
    expect(remote.data).toMatchObject({ outcome: "tracked" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "feature/remota@{upstream}")).toBe(
      "origin/feature/remota",
    );
    const count = (await readDocBranches(ctx.fs, ctx.paths)).events.length;
    for (const rama of ["main", "development", "qa", "aw/123", "bad..name"]) {
      expect(
        (
          await docBranchCommand.execute(
            args("set", { doc: "plan:067", source: "core", rama }),
            ctx,
          )
        ).ok,
      ).toBe(false);
    }
    expect(
      (
        await docBranchCommand.execute(
          args("set", { doc: "plan:067", source: "unknown", rama: "feature/no" }),
          ctx,
        )
      ).ok,
    ).toBe(false);
    expect((await readDocBranches(ctx.fs, ctx.paths)).events).toHaveLength(count);
    expect(
      readFileSync(join(root, "workspace", ".workflow", "doc-branches.jsonl"), "utf8"),
    ).toContain("feature/local");
  });

  it("copia sólo la rama propia de un quick a la spec mediante --from", async () => {
    const quick = "105-escalada-quick";
    const dir = join(root, "workspace", ".workflow", "sessions", quick);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), `# SESSION — ${quick}\n`);
    git(repo, "branch", "feature/quick");
    const own = await docBranchCommand.execute(
      args("set", { doc: "quick:105", source: "core", rama: "feature/quick" }),
      ctx,
    );
    expect(own.ok).toBe(true);
    const copied = await docBranchCommand.execute(
      args("set", { doc: "spec:049", source: "core", from: "quick:105" }),
      ctx,
    );
    expect(copied.data).toMatchObject({
      doc: "spec:049",
      branch: "feature/quick",
      outcome: "existing",
    });
    const shown = await docBranchCommand.execute(args("show", { doc: "quick:105" }), ctx);
    expect(shown.data).toMatchObject({ sources: [{ proposed: "feature/quick-105-escalada" }] });
  });
});
