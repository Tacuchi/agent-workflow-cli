import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSessionTarget } from "../../src/application/session-resolver.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { NARRATIVE_BEGIN, NARRATIVE_END } from "../../src/domain/session/narrative.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const folder = "003-foo-quick";
const sessionPath = `${sessionsDir}/${folder}`;
const closedMarker = `${sessionPath}/.closed`;

const SESSION_DOC = "# SESSION — foo\n\n## Objective\nhacer foo\n\n## Type\nquick\n";

/** The block as `session-close` left it: the CLI's own account of the session. */
const CLOSED_BLOCK = [
  NARRATIVE_BEGIN,
  "## Recorrido",
  "",
  "- **Estado:** cerrada",
  "",
  NARRATIVE_END,
].join("\n");

function buildFs(opts: { closed: boolean; narrated?: boolean }): FakeFs {
  const fs = new FakeFs({ lenient: true });
  fs.file(
    `${sessionPath}/SESSION.md`,
    opts.narrated === true ? `${SESSION_DOC}\n${CLOSED_BLOCK}\n` : SESSION_DOC,
  );
  if (opts.narrated === true) {
    fs.file(`${sessionPath}/CHECKPOINT.md`, "# CHECKPOINT\n\n## Completed\n- se cerró F1\n");
  }
  if (opts.closed) fs.file(closedMarker, "");
  return fs;
}

describe("runSessionResume --reopen", () => {
  it("reopens a closed session: removes .closed and returns state active", async () => {
    const fs = buildFs({ closed: true });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: "003",
      reopen: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");
    expect(await fs.exists(closedMarker)).toBe(false);
  });

  it("without reopen, a closed session stays closed (read-only resume)", async () => {
    const fs = buildFs({ closed: true });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: "003",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("closed");
    expect(await fs.exists(closedMarker)).toBe(true);
  });

  it("reopen on an already-active session is a no-op (stays active)", async () => {
    const fs = buildFs({ closed: false });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: "003",
      reopen: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");
  });

  // La reapertura movía el estado que `aw sessions` publica y dejaba intacto el
  // bloque administrado dentro de SESSION.md: el CLI declaraba «cerrada» una
  // sesión que él mismo acababa de reactivar, y eso es lo PRIMERO que lee quien
  // retoma — el payload de abajo devuelve el documento entero.
  it("reabrir deja coherente el bloque administrado: ninguna superficie dice cerrada", async () => {
    const fs = buildFs({ closed: true, narrated: true });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: folder,
      reopen: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");

    const document = await fs.readText(`${sessionPath}/SESSION.md`);
    expect(document).not.toContain("**Estado:** cerrada");
    expect(document).toContain("**Estado:** reanudada");
    // Un solo bloque: la reescritura reemplaza el anterior, no lo anida.
    expect(document.split(NARRATIVE_BEGIN)).toHaveLength(2);
    // Y el payload de reanudación viaja con el documento ya corregido.
    expect(result.objetivo).toContain("**Estado:** reanudada");
    expect(result.objetivo).not.toContain("**Estado:** cerrada");
  });

  it("sin --reopen el bloque no se toca: una lectura no reescribe la sesión", async () => {
    const fs = buildFs({ closed: true, narrated: true });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: folder,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("closed");
    expect(fs.writes.has(`${sessionPath}/SESSION.md`)).toBe(false);
  });
});

describe("SESSION_CLOSED — el error enseña la salida", () => {
  // Cerrar a mitad de recorrido es recuperable, pero el error decía `--code
  // <NNN>`: un marcador de posición que quien lo recibe tiene que resolver, y
  // que en un workspace con una carpeta legacy homónima resuelve a dos sesiones.
  it("la acción nombra la operación exacta, con la carpeta y no un placeholder", async () => {
    const fs = buildFs({ closed: true });
    const resolution = await resolveSessionTarget(fs, paths, { code: "003", intent: "read" });
    if (resolution.outcome !== "error") throw new Error("se esperaba SESSION_CLOSED");
    expect(resolution.code).toBe("SESSION_CLOSED");
    expect(resolution.action).toContain(`aw session-resume --code ${folder} --reopen`);
    expect(resolution.action).not.toContain("<NNN>");
  });

  it("esa acción, ejecutada tal cual, devuelve la sesión al recorrido", async () => {
    const fs = buildFs({ closed: true });
    const resolution = await resolveSessionTarget(fs, paths, { code: "003", intent: "read" });
    if (resolution.outcome !== "error") throw new Error("se esperaba SESSION_CLOSED");
    // La invocación se lee del propio error: si dejara de ser ejecutable verbatim,
    // esta prueba se cae en vez de seguir comprobando una que nadie emite.
    const invoked = resolution.action.match(/aw session-resume --code (\S+) --reopen/);
    if (invoked?.[1] === undefined) throw new Error(`acción no ejecutable: ${resolution.action}`);

    const resumed = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: invoked[1],
      reopen: true,
    });
    if ("error" in resumed) throw new Error(`unexpected error: ${resumed.error}`);
    expect(resumed.state).toBe("active");
    // Y el recorrido vuelve a resolver: `advance`/`submit` piden allowClosed:false.
    const again = await resolveSessionTarget(fs, paths, { code: "003", intent: "read" });
    expect(again.outcome).toBe("resolved");
  });
});

describe("session-resume / session-artifacts commands — not-found envelope", () => {
  // Regression: both commands wrapped every service result in {ok:true, exitCode:0},
  // so a nonexistent session looked like success to loops keying off exit codes.
  function fakeCtx(fs: FakeFs): CliContext {
    return { fs, env: new FakeEnv("/home/u", "/cwd"), paths } as unknown as CliContext;
  }

  it("session-resume maps session_not_found to ok:false + exit 1", async () => {
    const { sessionResumeCommand } = await import("../../src/cli/commands/session-resume.js");
    const args = {
      rest: [],
      plugin: {},
      flags: new Set<string>(),
      values: new Map([["code", "999"]]),
      valuesMulti: new Map(),
    };
    const result = await sessionResumeCommand.execute(args, fakeCtx(buildFs({ closed: false })));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("SESSION_NOT_FOUND");
  });

  it("session-artifacts maps session_not_found to ok:false + exit 1", async () => {
    const { sessionArtifactsCommand } = await import("../../src/cli/commands/session-artifacts.js");
    const args = {
      rest: [],
      plugin: {},
      flags: new Set<string>(),
      values: new Map([["code", "999"]]),
      valuesMulti: new Map(),
    };
    const result = await sessionArtifactsCommand.execute(args, fakeCtx(buildFs({ closed: false })));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("SESSION_NOT_FOUND");
  });
});
