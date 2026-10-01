import { describe, expect, it } from "vitest";
import { findActiveSessions } from "../../src/application/checkpoint-service.js";
import { locateRun } from "../../src/application/flow/run-state-service.js";
import { reconcileHistory } from "../../src/application/history-reconcile-service.js";
import { readHistoryRows } from "../../src/application/history-table.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runResume } from "../../src/application/resume-service.js";
import { lookupBinding } from "../../src/application/session-binding-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { runSessionLoad } from "../../src/application/session-load-service.js";
import { runSessionPause } from "../../src/application/session-pause-service.js";
import { SessionsService } from "../../src/application/sessions-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const env = new FakeEnv("/home", "/cwd");
const paths = new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");

class FailHistory extends MemFs {
  rejectActive = false;
  override async writeText(path: string, content: string) {
    if (this.rejectActive && path === paths.cwdHistoryFile() && content.includes("| active |")) {
      this.rejectActive = false;
      throw new Error("HISTORY no disponible");
    }
    await super.writeText(path, content);
  }
}

describe("estados que sólo marca el usuario", () => {
  it("una legacy pausada conserva una sola identidad al retomar y cerrar", async () => {
    const fs = new MemFs({ lenient: true });
    const folder = "session047-legacy-x";
    fs.file(
      `${paths.cwdSessionsDir()}/${folder}/SESSION.md`,
      "# SESSION\n\n## Objective\nLegacy\n",
    );
    expect(await runSessionPause(fs, paths, folder)).toMatchObject({ state: "paused" });
    expect(
      readHistoryRows(await fs.readText(paths.cwdHistoryFile())).map((row) => row.key),
    ).toEqual(["047-legacy-x"]);
    expect(await runSessionLoad(fs, env, paths, { code: folder })).toHaveProperty(
      "state",
      "active",
    );
    expect(await runSessionClose(fs, paths, { code: folder })).toHaveProperty(
      "sessionClose.closed",
      true,
    );
    expect((await reconcileHistory(fs, paths)).missing_rows).toEqual([]);
  });

  it("un HISTORY fallido al retomar conserva pausa y binding anterior", async () => {
    const fs = new FailHistory({ lenient: true });
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "retomar-quick",
      objetivo: "probar",
    });
    if ("error" in created) throw new Error(created.error);
    const code = created.sessionCreate.folder;
    await runSessionPause(fs, paths, code);
    fs.rejectActive = true;
    expect(await runSessionLoad(fs, env, paths, { code, contextId: "conv" })).toMatchObject({
      code: "SESSION_RESUME_FAILED",
    });
    expect(await fs.exists(`${created.sessionCreate.path}/.paused`)).toBe(true);
    expect(await fs.exists(paths.cwdSessionBindingsFile())).toBe(false);
    expect(await fs.readText(paths.cwdHistoryFile())).toContain("| paused |");
  });

  it("un fallo de HISTORY al reabrir restaura marcadores y asociación", async () => {
    const fs = new FailHistory({ lenient: true });
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "reabrir-quick",
      objetivo: "probar",
    });
    if ("error" in created) throw new Error(created.error);
    const code = created.sessionCreate.folder;
    await runSessionClose(fs, paths, { code, force: true });
    fs.rejectActive = true;
    expect(
      await runSessionLoad(fs, env, paths, { code, reopen: true, contextId: "conv" }),
    ).toMatchObject({ code: "SESSION_REOPEN_FAILED" });
    expect(await fs.exists(`${created.sessionCreate.path}/.closed`)).toBe(true);
    expect(await fs.exists(paths.cwdSessionBindingsFile())).toBe(false);
    expect(await fs.readText(paths.cwdHistoryFile())).toContain("| closed |");
  });

  it("una corrida ilegible que rechaza la reapertura no deja binding hacia la cerrada", async () => {
    const fs = new MemFs({ lenient: true });
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "bloqueada-quick",
      objetivo: "probar",
    });
    if ("error" in created) throw new Error(created.error);
    const code = created.sessionCreate.folder;
    await runSessionClose(fs, paths, { code, force: true });
    fs.file(locateRun(paths, code).statePath, "{");
    const failed = await runSessionLoad(fs, env, paths, {
      code,
      reopen: true,
      contextId: "conv",
    });
    expect(failed).toHaveProperty("run_error.code");
    expect(await fs.exists(`${created.sessionCreate.path}/.closed`)).toBe(true);
    const registry = JSON.parse(await fs.readText(paths.cwdSessionBindingsFile()));
    expect(Object.keys(registry.bindings)).toEqual([]);
  });

  it("pausa relee el estado dentro del candado si alguien cerró después de resolver", async () => {
    class InterleavingFs extends MemFs {
      inject = false;
      target = "";
      override async writeTextExclusive(path: string, content: string) {
        if (this.inject && path === paths.cwdLockFile()) {
          this.inject = false;
          this.file(`${this.target}/.closed`, "");
        }
        return super.writeTextExclusive(path, content);
      }
    }
    const fs = new InterleavingFs({ lenient: true });
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "carrera-quick",
      objetivo: "probar",
    });
    if ("error" in created) throw new Error(created.error);
    fs.target = created.sessionCreate.path;
    fs.inject = true;
    expect(await runSessionPause(fs, paths, created.sessionCreate.folder)).toMatchObject({
      code: "SESSION_NOT_ACTIVE",
    });
    expect(await fs.exists(`${fs.target}/.paused`)).toBe(false);
  });

  it("resume ofrece cerrar una sesión con todos sus criterios marcados", async () => {
    const fs = new MemFs({ lenient: true });
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "terminada-quick",
      objetivo: "terminar",
    });
    if ("error" in created) throw new Error(created.error);
    fs.file(
      created.sessionCreate.session_path,
      "# SESSION\n\n## Objective\nTerminar\n\n## Origin\n- petición\n\n## Success criteria\n- [x] probado\n",
    );
    const result = await runResume(fs, env, paths);
    expect(result.ready_to_close).toEqual([
      {
        session: created.sessionCreate.folder,
        command: `aw session-close --code ${created.sessionCreate.folder}`,
      },
    ]);
    await runSessionPause(fs, paths, created.sessionCreate.folder);
    const paused = await runStatusCommand(fs, env, paths);
    expect(paused.counts).toMatchObject({ sessions_active: 0, sessions_paused: 1 });
    const proposed = await runResume(fs, env, paths);
    expect(proposed.paused_sessions).toEqual([created.sessionCreate.folder]);
    expect(proposed.ready_to_close).toBeUndefined();
  });

  it("pausada no es candidata y vuelve a activa; abandonada exige reapertura expresa", async () => {
    const fs = new MemFs({ lenient: true });
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "mi-trabajo-quick",
      objetivo: "terminar",
    });
    if ("error" in created) throw new Error(created.error);
    const code = created.sessionCreate.folder;
    expect(await runSessionPause(fs, paths)).toMatchObject({ code: "INVALID_INPUT" });
    expect(await runSessionPause(fs, paths, code)).toMatchObject({ folder: code, state: "paused" });
    expect(await fs.readText(created.sessionCreate.session_path)).toContain("**Estado:** pausada");
    expect((await findActiveSessions(fs, paths)).map((session) => session.folder)).toEqual([]);
    const paused = await new SessionsService(fs, env, paths).list({ state: "all" });
    expect(paused).toMatchObject({ active_count: 0, paused_count: 1, abandoned_count: 0 });
    expect(await fs.readText(paths.cwdHistoryFile())).toContain("| paused |");

    const resumed = await runSessionLoad(fs, env, paths, { code, contextId: "conversación" });
    expect(resumed).toHaveProperty("state", "active");
    expect(await lookupBinding(fs, paths, "conversación")).toMatchObject({
      status: "bound",
      folder: code,
    });
    expect((await findActiveSessions(fs, paths)).map((session) => session.folder)).toEqual([code]);

    expect(await runSessionClose(fs, paths, { code, abandon: true })).toHaveProperty(
      "sessionClose.closed",
      true,
    );
    expect(await runSessionLoad(fs, env, paths, { code })).toMatchObject({
      code: "SESSION_ABANDONED",
    });
    const abandoned = await new SessionsService(fs, env, paths).list({ state: "all" });
    expect(abandoned).toMatchObject({ active_count: 0, paused_count: 0, abandoned_count: 1 });
    expect(await fs.readText(paths.cwdHistoryFile())).toContain("| abandoned |");
    expect(await fs.readText(created.sessionCreate.session_path)).toContain(
      "**Estado:** abandonada",
    );
    const reopened = await runSessionLoad(fs, env, paths, { code, reopen: true });
    expect(reopened).toHaveProperty("state", "active");
    expect(await fs.readText(paths.cwdHistoryFile())).toContain("| active |");
  });
});
