import { describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import type { ProcessPort, RunOptions, RunResult } from "../../src/ports/process.js";

interface ScriptedRun {
  match: (cmd: string, args: string[]) => boolean;
  result: RunResult;
}

class ScriptedProcess implements ProcessPort {
  public invocations: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = [];
  constructor(private readonly scripts: ScriptedRun[]) {}
  async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    this.invocations.push({ cmd, args, opts });
    for (const s of this.scripts) {
      if (s.match(cmd, args)) return s.result;
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  async which(): Promise<string | undefined> {
    return undefined;
  }
}

const ok: RunResult = { code: 0, stdout: "", stderr: "" };
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
const argsOf = (p: ScriptedProcess, op: string) =>
  p.invocations.find((i) => i.args[0] === op)?.args ?? [];

describe("GitCliAdapter — new git-flow ops", () => {
  it("checkout runs `git checkout <branch>` in repo cwd", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).checkout("/repo", "feature/x");
    expect(argsOf(p, "checkout")).toEqual(["checkout", "feature/x"]);
    expect(p.invocations[0]?.opts).toEqual({ cwd: "/repo" });
  });

  it("checkout throws on non-zero exit", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a[0] === "checkout", result: fail("boom") },
    ]);
    await expect(new GitCliAdapter(p).checkout("/repo", "x")).rejects.toThrow(/checkout x failed/);
  });

  it("pull runs `git pull`", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).pull("/repo");
    expect(argsOf(p, "pull")).toEqual(["pull"]);
  });

  it("pull throws on non-zero exit", async () => {
    const p = new ScriptedProcess([{ match: (_c, a) => a[0] === "pull", result: fail("network") }]);
    await expect(new GitCliAdapter(p).pull("/repo")).rejects.toThrow(/git pull failed/);
  });

  it("merge returns ok=true on clean merge", async () => {
    const p = new ScriptedProcess([]);
    const r = await new GitCliAdapter(p).merge("/repo", "main");
    expect(r).toEqual({ ok: true, conflicted: [] });
    expect(argsOf(p, "merge")).toEqual(["merge", "main"]);
  });

  it("merge returns ok=false + parsed conflicted files on conflict", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a[0] === "merge", result: fail("CONFLICT") },
      {
        match: (_c, a) => a.includes("--diff-filter=U"),
        result: { code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" },
      },
    ]);
    const r = await new GitCliAdapter(p).merge("/repo", "feature/x");
    expect(r).toEqual({ ok: false, conflicted: ["src/a.ts", "src/b.ts"] });
  });

  it("merge throws when it fails with no conflicted files (non-conflict error)", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a[0] === "merge", result: fail("fatal: not a thing") },
      { match: (_c, a) => a.includes("--diff-filter=U"), result: ok },
    ]);
    await expect(new GitCliAdapter(p).merge("/repo", "x")).rejects.toThrow(/git merge x failed/);
  });

  it("push runs plain `git push origin <branch>` (never --force)", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).push("/repo", "desarrollo");
    expect(argsOf(p, "push")).toEqual(["push", "origin", "desarrollo"]);
    const joined = p.invocations.flatMap((i) => i.args).join(" ");
    expect(joined).not.toMatch(/--force|--no-verify|--amend/);
  });

  it("push throws on non-zero exit", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a[0] === "push", result: fail("rejected") },
    ]);
    await expect(new GitCliAdapter(p).push("/repo", "x")).rejects.toThrow(/git push x failed/);
  });

  it("isMerging is true when MERGE_HEAD verifies", async () => {
    const p = new ScriptedProcess([
      {
        match: (_c, a) => a.includes("MERGE_HEAD"),
        result: { code: 0, stdout: "sha", stderr: "" },
      },
    ]);
    expect(await new GitCliAdapter(p).isMerging("/repo")).toBe(true);
  });

  it("isMerging is false when MERGE_HEAD is absent", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a.includes("MERGE_HEAD"), result: fail("not found") },
    ]);
    expect(await new GitCliAdapter(p).isMerging("/repo")).toBe(false);
  });

  it("conflictedFiles parses `git diff --name-only --diff-filter=U`", async () => {
    const p = new ScriptedProcess([
      {
        match: (_c, a) => a.includes("--diff-filter=U"),
        result: { code: 0, stdout: "x.ts\n y.ts \n\n", stderr: "" },
      },
    ]);
    expect(await new GitCliAdapter(p).conflictedFiles("/repo")).toEqual(["x.ts", "y.ts"]);
  });

  it("conflictedFiles returns [] on non-zero exit", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a.includes("--diff-filter=U"), result: fail("err") },
    ]);
    expect(await new GitCliAdapter(p).conflictedFiles("/repo")).toEqual([]);
  });
});
