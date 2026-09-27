import { describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import type {
  ProcessPort,
  RunBinaryResult,
  RunOptions,
  RunResult,
} from "../../src/ports/process.js";

interface ScriptedRun {
  match: (cmd: string, args: string[]) => boolean;
  /** stdout may be scripted as raw bytes: the fingerprint reads git's output as bytes. */
  result: Omit<RunResult, "stdout"> & { stdout: string | Buffer };
}

const asBuffer = (value: string | Buffer): Buffer =>
  typeof value === "string" ? Buffer.from(value) : value;

class ScriptedProcess implements ProcessPort {
  public invocations: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = [];
  constructor(private readonly scripts: ScriptedRun[]) {}
  private script(cmd: string, args: string[], opts?: RunOptions): ScriptedRun["result"] {
    this.invocations.push({ cmd, args, opts });
    for (const s of this.scripts) {
      if (s.match(cmd, args)) return s.result;
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    const scripted = this.script(cmd, args, opts);
    return { ...scripted, stdout: asBuffer(scripted.stdout).toString("utf8") };
  }
  async runBinary(cmd: string, args: string[], opts?: RunOptions): Promise<RunBinaryResult> {
    const scripted = this.script(cmd, args, opts);
    return {
      code: scripted.code,
      stdout: asBuffer(scripted.stdout),
      stderr: Buffer.from(scripted.stderr),
    };
  }
  async which(): Promise<string | undefined> {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

const ok: RunResult = { code: 0, stdout: "", stderr: "" };
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
const argsOf = (p: ScriptedProcess, op: string) =>
  p.invocations.find((i) => i.args[0] === op)?.args ?? [];

describe("GitCliAdapter — new git-flow ops", () => {
  it("lee modo y hash SHA-256 de una etapa del índice sin perder el blob", async () => {
    const hash = "a".repeat(64);
    const p = new ScriptedProcess([
      {
        match: (_c, args) => args[0] === "ls-files" && args.includes("-u"),
        result: { code: 0, stdout: `100755 ${hash} 2\tscript.sh\n`, stderr: "" },
      },
      {
        match: (_c, args) => args[0] === "cat-file",
        result: { code: 0, stdout: "#!/bin/sh\n", stderr: "" },
      },
    ]);
    const stages = await new GitCliAdapter(p).conflictStages("/repo", "script.sh");
    expect(stages.ours).toMatchObject({ hash, mode: "100755", content: "#!/bin/sh\n", bytes: 10 });
    expect(stages.base.hash).toBeNull();
  });
  it("checkout runs `git checkout <branch>` in repo cwd", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).checkout("/repo", "feature/x");
    expect(argsOf(p, "checkout")).toEqual(["checkout", "feature/x"]);
    expect(p.invocations[0]?.opts?.cwd).toBe("/repo");
  });

  it("runs every git command non-interactively (GIT_TERMINAL_PROMPT=0) so it fails fast on creds", async () => {
    const p = new ScriptedProcess([]);
    const git = new GitCliAdapter(p);
    // A network op that could otherwise block on a credential prompt.
    await git.push("/repo", "main");
    await git.fetchBranch("/repo", "main");
    await git.currentBranch("/repo");
    for (const inv of p.invocations) {
      expect(inv.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
      // The rest of the environment is preserved (not wiped).
      expect(inv.opts?.env?.PATH).toBe(process.env.PATH);
    }
  });

  it("checkout throws on non-zero exit", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a[0] === "checkout", result: fail("boom") },
    ]);
    await expect(new GitCliAdapter(p).checkout("/repo", "x")).rejects.toThrow(/checkout x failed/);
  });

  it("no expone `pull`: ninguna rama se actualiza con lo que rastree", () => {
    expect("pull" in new GitCliAdapter(new ScriptedProcess([]))).toBe(false);
  });

  it("lee el upstream completo de una rama local sin cambiarla", async () => {
    const process = new ScriptedProcess([
      {
        match: (_cmd, args) => args[0] === "for-each-ref",
        result: { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" },
      },
    ]);
    expect(await new GitCliAdapter(process).upstreamBranch("/repo", "feature/w")).toBe(
      "refs/remotes/origin/main",
    );
    expect(process.invocations.map((call) => call.args)).toEqual([
      ["for-each-ref", "--format=%(upstream)", "refs/heads/feature/w"],
    ]);
  });

  it("createBranch crea sin cambiar de rama, con o sin rastreo", async () => {
    const p = new ScriptedProcess([]);
    const git = new GitCliAdapter(p);
    await git.createBranch("/repo", "feature/n", "refs/remotes/origin/certificacion", {
      track: false,
    });
    await git.createBranch("/repo", "feature/r", "refs/remotes/origin/feature/r", { track: true });
    const branchCalls = p.invocations.filter((i) => i.args[0] === "branch").map((i) => i.args);
    expect(branchCalls).toEqual([
      ["branch", "--no-track", "feature/n", "refs/remotes/origin/certificacion"],
      ["branch", "--track", "feature/r", "refs/remotes/origin/feature/r"],
    ]);
  });

  it("originFetchRefspecs lee remote.origin.fetch y trata la clave ausente como vacía", async () => {
    const set = new ScriptedProcess([
      {
        match: (_c, a) => a[0] === "config",
        result: { code: 0, stdout: "+refs/heads/*:refs/remotes/origin/*\n", stderr: "" },
      },
    ]);
    expect(await new GitCliAdapter(set).originFetchRefspecs("/repo")).toEqual([
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    const unset = new ScriptedProcess([
      { match: (_c, a) => a[0] === "config", result: { code: 1, stdout: "", stderr: "" } },
    ]);
    expect(await new GitCliAdapter(unset).originFetchRefspecs("/repo")).toEqual([]);
  });

  it("mergeOrigin conserva el remoto: origin/feature/x no es feature/x trayéndose a sí misma", async () => {
    const p = new ScriptedProcess([
      {
        match: (_c, a) => a[0] === "name-rev",
        result: { code: 0, stdout: "remotes/origin/feature/x~2\n", stderr: "" },
      },
    ]);
    expect(await new GitCliAdapter(p).mergeOrigin("/repo")).toBe("origin/feature/x");
  });

  it("remoteHasBranch pregunta a origin por la rama exacta y distingue ausente de ilegible", async () => {
    const present = new ScriptedProcess([]);
    expect(await new GitCliAdapter(present).remoteHasBranch("/repo", "certificacion")).toBe(true);
    expect(argsOf(present, "ls-remote")).toEqual([
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      "refs/heads/certificacion",
    ]);

    const absent = new ScriptedProcess([
      { match: (_c, a) => a[0] === "ls-remote", result: { code: 2, stdout: "", stderr: "" } },
    ]);
    expect(await new GitCliAdapter(absent).remoteHasBranch("/repo", "x")).toBe(false);

    const unreadable = new ScriptedProcess([
      {
        match: (_c, a) => a[0] === "ls-remote",
        result: { code: 128, stdout: "", stderr: "no route" },
      },
    ]);
    await expect(new GitCliAdapter(unreadable).remoteHasBranch("/repo", "x")).rejects.toThrow(
      /ls-remote origin x failed.*no route/,
    );
  });

  it("fetchBranch trae sólo esa rama a origin/<rama>, sin mezclar", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).fetchBranch("/repo", "feature/x");
    expect(argsOf(p, "fetch")).toEqual([
      "fetch",
      "origin",
      "+refs/heads/feature/x:refs/remotes/origin/feature/x",
    ]);
  });

  it("fastForward sólo avanza: `merge --ff-only`, y falla con el stderr de git", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).fastForward("/repo", "origin/certificacion");
    expect(argsOf(p, "merge")).toEqual(["merge", "--ff-only", "origin/certificacion"]);

    const refused = new ScriptedProcess([
      { match: (_c, a) => a[0] === "merge", result: fail("Not possible to fast-forward") },
    ]);
    await expect(new GitCliAdapter(refused).fastForward("/repo", "origin/x")).rejects.toThrow(
      /Not possible to fast-forward/,
    );
  });

  it("aheadBehind lee el conteo de `rev-list --left-right --count`", async () => {
    const p = new ScriptedProcess([
      { match: (_c, a) => a[0] === "rev-list", result: { code: 0, stdout: "3\t1\n", stderr: "" } },
    ]);
    const counts = await new GitCliAdapter(p).aheadBehind(
      "/repo",
      "certificacion",
      "origin/certificacion",
    );
    expect(counts).toEqual({ ahead: 3, behind: 1 });
    expect(argsOf(p, "rev-list")).toEqual([
      "rev-list",
      "--left-right",
      "--count",
      "certificacion...origin/certificacion",
    ]);
  });

  it("revList excluye cada ref con --not y devuelve un sha por línea", async () => {
    const p = new ScriptedProcess([
      {
        match: (_c, a) => a[0] === "rev-list",
        result: { code: 0, stdout: "aaa\nbbb\n", stderr: "" },
      },
    ]);
    const shas = await new GitCliAdapter(p).revList("/repo", "certificacion", [
      "origin/certificacion",
      "feature/x",
    ]);
    expect(shas).toEqual(["aaa", "bbb"]);
    expect(argsOf(p, "rev-list")).toEqual([
      "rev-list",
      "certificacion",
      "--not",
      "origin/certificacion",
      "feature/x",
    ]);
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

  it("push runs `git push origin refs/heads/<b>:refs/heads/<b>` (never --force)", async () => {
    const p = new ScriptedProcess([]);
    await new GitCliAdapter(p).push("/repo", "desarrollo");
    expect(argsOf(p, "push")).toEqual([
      "push",
      "origin",
      "refs/heads/desarrollo:refs/heads/desarrollo",
    ]);
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

// El defecto que cierra este bloque no tenia NINGUN test: el adaptador recortaba
// un caracter del PRIMER archivo cambiado y su comentario llamaba a eso
// «back-compat with prior consumers». No habia consumidor que dependiera de ello
// ni prueba que lo fijara — sólo una ruta inexistente mostrada como si existiera.
describe("GitCliAdapter — changedFiles lee el formato porcelain sin recortar", () => {
  const porcelain = (stdout: string) =>
    new ScriptedProcess([
      { match: (_c, a) => a.includes("--porcelain"), result: { code: 0, stdout, stderr: "" } },
    ]);

  it("el PRIMER archivo sale completo, igual que los siguientes", async () => {
    const p = porcelain(" M src/application/markdown.ts\n M src/adapters/git-cli.ts\n");
    expect(await new GitCliAdapter(p).changedFiles("/repo")).toEqual([
      "src/application/markdown.ts",
      "src/adapters/git-cli.ts",
    ]);
  });

  it("con un solo archivo tampoco se recorta", async () => {
    const p = porcelain(" M src/domain/harnesses.ts\n");
    expect(await new GitCliAdapter(p).changedFiles("/repo")).toEqual(["src/domain/harnesses.ts"]);
  });

  it("lee los codigos de estado de dos letras: staged, sin seguimiento y renombrado", async () => {
    const p = porcelain("M  a.ts\n?? b.ts\nR  viejo.ts -> nuevo.ts\nA  c.ts\n");
    expect(await new GitCliAdapter(p).changedFiles("/repo")).toEqual([
      "a.ts",
      "b.ts",
      "viejo.ts -> nuevo.ts",
      "c.ts",
    ]);
  });

  it("un arbol limpio no devuelve una entrada vacia", async () => {
    expect(await new GitCliAdapter(porcelain("")).changedFiles("/repo")).toEqual([]);
    expect(await new GitCliAdapter(porcelain("\n")).changedFiles("/repo")).toEqual([]);
  });
});

describe("GitCliAdapter — huella del checkout", () => {
  const fingerprint = (patch: string | Buffer) =>
    new ScriptedProcess([
      {
        match: (_c, args) => args[0] === "diff" && args.includes("--binary"),
        result: { code: 0, stdout: patch, stderr: "" },
      },
      {
        match: (_c, args) => args[0] === "status" && args.includes("--porcelain=v2"),
        result: {
          code: 0,
          stdout: "1 .M N... 100644 100644 100644 abc abc src/policy.ts\0",
          stderr: "",
        },
      },
      {
        match: (_c, args) => args[0] === "ls-files" && args.includes("--others"),
        result: { code: 0, stdout: "scratch.txt\0", stderr: "" },
      },
      {
        match: (_c, args) => args[0] === "hash-object",
        result: { code: 0, stdout: "untracked-blob\n", stderr: "" },
      },
    ]);

  it("cambia cuando cambian los bytes aunque status siga nombrando el mismo archivo", async () => {
    const before = await new GitCliAdapter(
      fingerprint("diff --git a/src/policy.ts\n-old\n+one\n"),
    ).checkoutFingerprint("/repo");
    const after = await new GitCliAdapter(
      fingerprint("diff --git a/src/policy.ts\n-old\n+two\n"),
    ).checkoutFingerprint("/repo");
    expect(after).not.toBe(before);
  });

  it("distingue dos parches que sólo difieren en bytes que no son utf-8", async () => {
    // Todo byte suelto decodifica al MISMO carácter de reemplazo: hasheando la
    // salida como texto, dos árboles distintos darían una huella idéntica.
    const patch = (byte: number) =>
      Buffer.concat([
        Buffer.from("diff --git a/src/policy.ts\n+línea "),
        Buffer.from([byte]),
        Buffer.from("\n"),
      ]);
    const before = await new GitCliAdapter(fingerprint(patch(0xe1))).checkoutFingerprint("/repo");
    const after = await new GitCliAdapter(fingerprint(patch(0xe9))).checkoutFingerprint("/repo");
    expect(after).not.toBe(before);
  });
});
