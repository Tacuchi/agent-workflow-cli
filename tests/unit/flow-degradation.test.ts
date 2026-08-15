import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow, recoverFlowBoundary } from "../../src/application/flow/flow-service.js";
import type { InternalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import {
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  attemptsAt,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Qué puede degradarse cuando se agota, y qué tiene que quedar agotado.
 *
 * Degradar es pasar por alto la frontera y seguir. Eso es correcto para un gap
 * que sólo produce un veredicto —una lectura, un juicio— y es una mentira para
 * una fila que ESCRIBE: el recorrido se declararía terminado con el documento
 * que existe para producir sin escribir. La excepción que admitía cualquier fila
 * delegada con una ejecución fallida detrás habilitaba exactamente eso.
 *
 * El otro defecto que cubre este archivo es su espejo: las negativas propias de
 * `submit` —el scope que nombra una fuente que el workspace no declara— no
 * gastaban intento, así que esa frontera no agotaba, no degradaba y no se
 * recuperaba nunca. Un bucle sin techo adentro del mecanismo que existe para
 * poner uno.
 *
 * Dos recorridos de fixture, uno por flow, aislados del registro de producción.
 */

vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  const entry: FlowDecision = {
    id: "fixture.entry",
    scope: "quick",
    title: "abrir el tramo",
    authority: "cli",
    ownership: "cli-owned",
    document: "loops/quick-loop/LOOP.md",
  };
  const wrap: FlowDecision = {
    id: "fixture.wrap",
    scope: "quick",
    title: "cerrar el tramo",
    authority: "cli",
    ownership: "cli-owned",
    document: "loops/quick-loop/LOOP.md",
  };
  const write: FlowDecision = {
    id: "fixture.write",
    scope: "quick",
    title: "sembrar los artefactos de la sesión",
    authority: "cli",
    ownership: "cli-owned",
    document: "loops/quick-loop/LOOP.md",
    // Una ESCRITURA, no un veredicto. Auto-autorizable, así que la corrida se
    // para directamente en la frontera de ejecución y no en una de aprobación.
    effects: ["local_additive"],
    action: {
      invocation: { program: "aw", args: ["session-artifacts"], target: ".", input: null },
      evidence: ["artefactos"],
      idempotent: true,
      recovery: "revisá permisos y volvé a sembrar los artefactos",
      execution: { kind: "internal", operation: "session.artifacts" },
    },
  };
  const scope: FlowDecision = {
    id: "fixture.scope",
    scope: "plan-exec",
    title: "fijar el plan y las fuentes que la corrida edita",
    authority: "agent",
    ownership: "cli-owned",
    document: "loops/plan-exec-loop/LOOP.md",
    scopes_sources: true,
  };
  return {
    ...real,
    journeyOfFlow: (flow: string) =>
      flow === "plan-exec" ? [entry, scope, wrap] : [entry, write, wrap],
  };
});

const fs = new NodeFileSystem();
const WRITE_SESSION = "001-escritura-quick";
const SCOPE_SESSION = "002-alcance-plan-exec";

describe("una frontera agotada degrada sólo cuando saltearla no acredita nada", () => {
  let workdir: string;
  let paths: PathsService;
  let runs = 0;
  const executor: InternalActionExecutor = async () => {
    runs += 1;
    return {
      ok: false,
      summary: "no se pudieron sembrar los artefactos: permiso denegado",
      output: "",
      effects: [],
    };
  };

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-degradacion-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    runs = 0;
    for (const session of [WRITE_SESSION, SCOPE_SESSION]) {
      await mkdir(join(paths.cwdSessionsDir(), session), { recursive: true });
      await writeFile(
        join(paths.cwdSessionsDir(), session, "SESSION.md"),
        "# SESSION — prueba\n\n## Objective\nprobar\n",
        "utf8",
      );
    }
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function state(session: string): Promise<FlowRunState> {
    const read = await readRun(fs, locateRun(paths, session));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return read.state;
  }

  async function seal(session: string): Promise<string> {
    const current = await state(session);
    const { journeyOfFlow } = await import("../../src/domain/flow/authority.js");
    return resolveBoundary(current, journeyOfFlow(current.flow)).seal;
  }

  describe("una ESCRITURA delegada que falla", () => {
    beforeEach(async () => {
      // Adoptada SIN ejecutor: la corrida llega a la fila delegada sin haberla
      // ejecutado todavía, así cada avance de abajo es una ejecución contada.
      const adopted = await advanceFlow(fs, paths, {
        code: WRITE_SESSION,
        flow: "quick",
        adopt: true,
      });
      if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    });

    async function advance(): Promise<FlowDirective> {
      const result = await advanceFlow(fs, paths, {
        code: WRITE_SESSION,
        adopt: false,
        executor,
      });
      if (!result.ok) throw new Error("esperaba una directiva del avance");
      return result.directive;
    }

    it("queda AGOTADA en vez de degradarse, y el recorrido no se declara terminado", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await advance();
      expect(runs).toBe(MAX_BOUNDARY_ATTEMPTS);
      const exhausted = await advance();
      const after = await state(WRITE_SESSION);

      expect(attemptsAt(after, "fixture.write")).toBe(MAX_BOUNDARY_ATTEMPTS);
      // Ni pasada por alto, ni degradada, ni acreditada: el recorrido sigue
      // parado sobre ella y lo dice.
      expect(after.applied).toEqual(["fixture.entry"]);
      expect(after.skipped).toEqual([]);
      expect(after.degraded ?? []).toEqual([]);
      expect(exhausted.boundary.kind).toBe("blocked");
      expect(exhausted.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
      // Y no es un callejón: el bloqueo enseña la salida soportada.
      expect(exhausted.error?.action).toContain("aw flow recover");
      // Agotada quiere decir agotada: la acción ya no se vuelve a ejecutar.
      expect(runs).toBe(MAX_BOUNDARY_ATTEMPTS);
    });

    it("y su salida declarada funciona: recover la devuelve a ejecutable", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await advance();
      const recovered = await recoverFlowBoundary(fs, paths, { code: WRITE_SESSION });
      if (!recovered.ok) throw new Error("esperaba recuperar la frontera agotada");
      expect(recovered.directive.boundary.transition).toBe("fixture.write");
      expect(recovered.directive.boundary.kind).toBe("execution");
      expect(attemptsAt(await state(WRITE_SESSION), "fixture.write")).toBe(0);
    });
  });

  describe("las negativas propias de submit son respuestas evaluadas", () => {
    beforeEach(async () => {
      const adopted = await advanceFlow(fs, paths, {
        code: SCOPE_SESSION,
        flow: "plan-exec",
        adopt: true,
      });
      if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
      expect((await state(SCOPE_SESSION)).boundary).toBe("fixture.scope");
    });

    /** Un scope que nombra un alias que el workspace no declara. */
    async function refuseScope(turn: number): Promise<FlowDirective> {
      const result = await submitFlow(fs, paths, {
        code: SCOPE_SESSION,
        approval: null,
        raw: JSON.stringify({
          input_digest: await seal(SCOPE_SESSION),
          decisions: { sources: [`inventada-${turn}`], plan: "docs/plans/025-plan.md" },
        }),
      });
      if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true, no ok:false");
      return result.directive;
    }

    it("un scope que el workspace no declara gasta intento y termina agotando", async () => {
      const first = await refuseScope(1);
      // Código propio: `FLOW_ANSWER_INVALID` significaba «el sobre no se pudo
      // leer», que es lo contrario de lo que pasó acá.
      expect(first.error?.code).toBe("FLOW_SCOPE_UNKNOWN_SOURCE");
      expect(attemptsAt(await state(SCOPE_SESSION), "fixture.scope")).toBe(1);

      await refuseScope(2);
      const last = await refuseScope(3);
      expect(attemptsAt(await state(SCOPE_SESSION), "fixture.scope")).toBe(MAX_BOUNDARY_ATTEMPTS);
      expect(last.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
      // Nada quedó aplicado por rechazar: el scope sigue sin fijarse.
      expect((await state(SCOPE_SESSION)).scope).toBeNull();
    });

    it("y agotada sale del bloqueo: degrada con causa o se recupera", async () => {
      for (const turn of [1, 2, 3]) await refuseScope(turn);
      const degraded = await advanceFlow(fs, paths, { code: SCOPE_SESSION, adopt: false });
      if (!degraded.ok) throw new Error("esperaba una directiva del avance");
      const after = await state(SCOPE_SESSION);
      // Un juicio agotado sí se pasa por alto: saltearlo no acredita ninguna
      // escritura, y el estado declara por qué se lo salteó.
      expect(after.skipped).toContain("fixture.scope");
      expect((after.degraded ?? []).map((one) => one.transition)).toEqual(["fixture.scope"]);
      expect(degraded.directive.boundary.kind).toBe("final");
      expect(degraded.directive.next_action).toContain("fixture.scope");
    });
  });
});
