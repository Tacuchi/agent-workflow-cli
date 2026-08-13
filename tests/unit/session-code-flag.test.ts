import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { checkBranchCommand } from "../../src/cli/commands/check-branch.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import { sourcesCommand } from "../../src/cli/commands/sources.js";
import { worktreeCommand } from "../../src/cli/commands/worktree.js";
import { parseArgv, sessionCodeFlag } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * Una sola ortografía para decir de qué sesión se habla.
 *
 * La divergencia era real y no cosmética: `aw worktree` leía `--code` y `aw
 * check-branch` leía `--session`, así que la misma conversación tenía que
 * escribir su identidad de dos maneras para preguntar "¿es mío este árbol?" y
 * "dame mi árbol". Un flag que no aterriza en ningún lado no es un error visible:
 * es identidad AUSENTE, y con identidad ausente la verificación de aislamiento
 * no puede decidir nada.
 */
describe("la sesión se nombra igual en todos los comandos que la nombran", () => {
  let root: string;
  let ctx: CliContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-flag-"));
    ctx = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(root, root),
      git: new GitCliAdapter(new NodeProcess()),
      process: new NodeProcess(),
      paths: new PathsService(normalizeNamespace("agent-workflow"), root, root),
      runtime: undefined,
    } as unknown as CliContext;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("`--code` es la ortografía, y `--session` sigue siendo su alias", () => {
    expect(sessionCodeFlag(parseArgv(["worktree", "list", "--code", "114"])).ok).toBe(true);
    expect(sessionCodeFlag(parseArgv(["worktree", "list", "--code", "114"]))).toEqual({
      ok: true,
      code: "114",
    });
    expect(sessionCodeFlag(parseArgv(["check-branch", "--session", "114"]))).toEqual({
      ok: true,
      code: "114",
    });
    // Los dos, de acuerdo: una sola sesión, ninguna ambigüedad que resolver.
    expect(
      sessionCodeFlag(parseArgv(["flow", "advance", "--code", "114", "--session", "114"])),
    ).toEqual({ ok: true, code: "114" });
    // Y ninguno: no es un error, es no haber nombrado ninguna.
    expect(sessionCodeFlag(parseArgv(["sources", "--verbose"]))).toEqual({ ok: true });
  });

  it("dos ortografías que se contradicen se rechazan en vez de arbitrarse", async () => {
    const parsed = sessionCodeFlag(
      parseArgv(["check-branch", "--code", "114", "--session", "113"]),
    );
    expect(parsed.ok).toBe(false);

    // Y el rechazo llega desde el comando, no sólo desde el lector: elegir una de
    // las dos sería verificar —o escribir en— el árbol del flujo equivocado.
    for (const command of [checkBranchCommand, sourcesCommand, worktreeCommand]) {
      const result = await command.execute(
        parseArgv([command.name, "list", "--code", "114", "--session", "113"]),
        ctx,
      );
      expect(result.ok, command.name).toBe(false);
      expect(JSON.stringify(result), command.name).toContain("nombran sesiones distintas");
    }
    const flow = await flowCommand.execute(
      parseArgv(["flow", "advance", "--code", "114", "--session", "113"]),
      ctx,
    );
    expect(flow.ok).toBe(false);
    expect(JSON.stringify(flow)).toContain("nombran sesiones distintas");
  });

  it("`aw flow` acepta el `--code` que la proyección de resume publica", async () => {
    // `status` y `resume` proyectan `aw flow advance --code <sesión>`. Que ese
    // comando corra es la mitad que importa: proyectar un flag que el comando no
    // lee deja a quien reanuda con una línea que no hace nada.
    const result = await flowCommand.execute(parseArgv(["flow", "advance", "--code", "999"]), ctx);
    expect(result.ok).toBe(false);
    // Falla por la sesión inexistente, que es haber leído el flag — no por el flag.
    expect(JSON.stringify(result)).toContain("999");
    expect(JSON.stringify(result)).not.toContain("nombran sesiones distintas");
  });
});
