import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { runBranchCheckHook } from "../../src/application/hook-branch-check.js";
import { PathsService } from "../../src/application/paths-service.js";
import { type WorktreeEnsureOutput, runWorktree } from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function block(sourcePath: string, workingBranch: string): string {
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

Test.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| acme | ${sourcePath} | main |

## Stack

_Stack sin detectar._

## Status

- Ramas de trabajo actuales:
  - acme: ${workingBranch}
- Última actividad: 2026-08-07
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
}

/**
 * The git-safe invariant once flows edit in isolation units.
 *
 * The four cases the phase has to answer are exactly the four ways an edit can
 * relate to the units of a source: it is in mine, it is in somebody else's, it
 * is in the shared checkout while somebody is isolated, or nobody is isolated at
 * all — and that last one has to behave EXACTLY as it did before the feature,
 * because it is the case almost every workspace is in.
 */
describe("runBranchCheckHook — la línea de trabajo es la unidad del flujo", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let source: string;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };

  const CONTEXT_A = "conversation-a";
  const CONTEXT_B = "conversation-b";

  function session(folder: string): void {
    const dir = join(workspace, ".workflow", "sessions", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), `# SESSION — ${folder}\n`);
  }

  /** Seed the durable conversation→session association the hook reads. */
  function bind(contextId: string, folder: string): void {
    const file = join(workspace, ".workflow", "sessions", ".bindings.json");
    const key = createHash("sha256").update(contextId, "utf8").digest("hex");
    const current: { version: number; bindings: Record<string, string> } = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf-8"))
      : { version: 1, bindings: {} };
    current.bindings[key] = folder;
    writeFileSync(file, JSON.stringify(current, null, 2));
  }

  function edit(filePath: string, contextId?: string): string {
    return JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: filePath },
      ...(contextId ? { session_id: contextId } : {}),
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hook-units-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    source = join(root, "acme");
    for (const d of [home, workspace, source]) mkdirSync(d, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    writeFileSync(join(source, "README.md"), "hola\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    writeFileSync(join(workspace, "CLAUDE.md"), block(source, "main"));
    session("103-uno-plan-exec");
    session("104-dos-plan-exec");

    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function ensure(code: string): Promise<WorktreeEnsureOutput> {
    return (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: code,
    })) as WorktreeEnsureOutput;
  }

  it("caso 1 — editar dentro de la unidad propia pasa", async () => {
    const mine = await ensure("103");
    bind(CONTEXT_A, "103-uno-plan-exec");

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(mine.path, "src", "foo.ts"), CONTEXT_A),
    });

    expect(result.exitCode).toBe(0);
  });

  it("caso 2 — editar dentro de la unidad de OTRA sesión se bloquea nombrando ambas", async () => {
    await ensure("103");
    const otherFlow = await ensure("104");
    bind(CONTEXT_A, "103-uno-plan-exec");

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(otherFlow.path, "src", "foo.ts"), CONTEXT_A),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("OTRA sesión");
    expect(result.stderr).toContain("104-dos-plan-exec");
    expect(result.stderr).toContain("aw worktree ensure --source acme --code 103-uno-plan-exec");
  });

  it("caso 3 — editar el checkout principal teniendo unidad viva se bloquea con el comando exacto", async () => {
    await ensure("103");
    bind(CONTEXT_A, "103-uno-plan-exec");

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(source, "src", "foo.ts"), CONTEXT_A),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("queda fuera");
    expect(result.stderr).toContain("aw worktree ensure --source acme --code 103-uno-plan-exec");
  });

  it("caso 3b — con la identidad sin resolver, el checkout sigue bloqueado y dice por qué", async () => {
    await ensure("103");

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(source, "src", "foo.ts")),
    });

    // Dos sesiones activas y ninguna asociación: el resolver no puede decir de
    // quién es este flujo. Antes eso se aplanaba a "sin sesión" y el mensaje
    // ofrecía un `<NNN>` de relleno; ahora el motivo viaja, porque es lo que la
    // persona tiene que arreglar.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no se pudo resolver a qué sesión");
    expect(result.stderr).toContain("2 sesiones activas");
    expect(result.stderr).toContain("--code");
  });

  it("caso 3c — con la identidad sin resolver, editar DENTRO de una unidad tampoco pasa", async () => {
    const mine = await ensure("103");

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(mine.path, "src", "foo.ts")),
    });

    // La regresión que este caso fija: una identidad ausente o ambigua daba
    // `null`, y con `null` CUALQUIER unidad contestaba `inside_own_unit`. Con dos
    // corridas vivas eso autorizaba escribir en el árbol de la otra — exactamente
    // lo que el aislamiento existe para impedir. No saber de quién es un árbol no
    // es permiso para escribir en él.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no se pudo resolver a qué sesión");
    expect(result.stderr).toContain(mine.path);
  });

  it("caso 3d — una sola sesión activa sigue resolviendo sola: la unidad propia pasa", async () => {
    rmSync(join(workspace, ".workflow", "sessions", "104-dos-plan-exec"), {
      recursive: true,
      force: true,
    });
    const mine = await ensure("103");

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(mine.path, "src", "foo.ts")),
    });

    // El fail-closed no se paga en el workspace normal: con una única sesión
    // activa la precedencia la resuelve sin que nadie declare nada, que es el
    // caso en el que está casi todo el mundo.
    expect(result.exitCode).toBe(0);
  });

  it("caso 4 — sin ninguna unidad, la verificación es exactamente la de antes: rama correcta pasa", async () => {
    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(source, "src", "foo.ts"), CONTEXT_A),
    });

    expect(result.exitCode).toBe(0);
  });

  it("caso 4b — sin ninguna unidad, la rama equivocada sigue bloqueando como siempre", async () => {
    writeFileSync(join(workspace, "CLAUDE.md"), block(source, "feature/x"));

    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(source, "src", "foo.ts")),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Rama de trabajo incorrecta");
    expect(result.stderr).toContain("feature/x");
  });

  it("un archivo dentro de una unidad ya no queda fuera de toda fuente", async () => {
    const mine = await ensure("103");
    bind(CONTEXT_B, "104-dos-plan-exec");

    // Antes, un worktree colgaba fuera de la ruta declarada de la fuente y por
    // eso NO pertenecía a ninguna: la verificación lo dejaba pasar en silencio.
    const result = await runBranchCheckHook({
      ...deps,
      stdin: edit(join(mine.path, "src", "foo.ts"), CONTEXT_B),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("103-uno-plan-exec");
  });
});
