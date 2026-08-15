import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyUnderLock,
  locateRun,
  readRun,
} from "../../src/application/flow/run-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_READABLE,
  FLOW_RUN_STATE_VERSION,
  type FlowRunAttempt,
  type FlowRunState,
  applyTransition,
  atCurrentVersion,
  attemptsAt,
  checkAgainstJourney,
  degradeTransition,
  grantAttempts,
  newRunState,
  parseRunState,
  positionDigest,
  serializeRunState,
  skipTransition,
  withActionAttempted,
  withAttempt,
  withAttemptCounters,
  withBoundary,
  withObservation,
  withPendingAction,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * The run state over a real workspace: it survives a round trip, it refuses
 * anything it cannot trust, it never touches the human artifacts, and two
 * concurrent applications end with one winner and zero lost transitions.
 */

const SESSION = "001-prueba-quick";

function journey(): FlowDecision[] {
  return ["a", "b", "c"].map((id) => ({
    id: `fixture.${id}`,
    scope: "quick",
    title: `transición determinista ${id} del fixture`,
    authority: "cli" as const,
    // Owned on purpose: this file exercises the state, and the engine walks only
    // the transitions the CLI owns.
    ownership: "cli-owned" as const,
    document: "loops/quick-loop/LOOP.md",
  }));
}

describe("estado de corrida — ida y vuelta", () => {
  it("una ronda completa de sellado, serialización y parseo devuelve el mismo estado", () => {
    const state = newRunState("quick", SESSION);
    const back = parseRunState(serializeRunState(state));
    if (!back.ok) throw new Error(`esperaba un estado válido: ${back.failure.code}`);
    expect(back.state).toEqual(state);
  });

  it("aplicar una transición re-sella y deja la traza en orden", () => {
    const [first, second] = journey();
    if (first === undefined || second === undefined) throw new Error("fixture incompleto");
    const one = applyTransition(newRunState("quick", SESSION), first.id);
    const two = applyTransition(one, second.id);
    expect(two.applied).toEqual([first.id, second.id]);
    expect(two.digest).not.toBe(one.digest);
    const back = parseRunState(serializeRunState(two));
    expect(back.ok).toBe(true);
  });

  it("aplicar no mueve la frontera: eso lo hace el motor al detenerse", () => {
    const stopped = withBoundary(newRunState("quick", SESSION), "fixture.b");
    const applied = applyTransition(stopped, "fixture.a");
    expect(applied.boundary).toBe("fixture.b");
    expect(withBoundary(applied, null).boundary).toBeNull();
  });
});

describe("contabilidad de intentos — el ledger, el piso y lo perdonado", () => {
  const spent = (transition: string, count: number): FlowRunAttempt[] =>
    Array.from({ length: count }, (_unused, index) => ({
      invocation_id: `sello-${transition}`,
      attempt: index + 1,
      request_digest: `payload-${index}`,
      parent_request_digest: index === 0 ? null : `payload-${index - 1}`,
      transition,
    }));

  it("sin contador, el ledger es la cuenta: un campo ausente asume el valor conservador", () => {
    const state = { ...newRunState("quick", SESSION), attempts: spent("fixture.a", 2) };
    expect(state.attempt_floor).toBeUndefined();
    expect(attemptsAt(state, "fixture.a")).toBe(2);
    expect(attemptsAt(state, "fixture.b")).toBe(0);
  });

  it("el piso manda cuando el ledger fue rebobinado, y lo perdonado se resta", () => {
    const restored = {
      ...newRunState("quick", SESSION),
      attempts: spent("fixture.a", 1),
      attempt_floor: { "fixture.a": 3 },
    };
    // Restaurar una copia anterior deja el ledger en uno; el contador sigue en
    // tres, y tres es lo que cuenta.
    expect(attemptsAt(restored, "fixture.a")).toBe(3);
    // Recuperar no borra el contador: registra cuánto devolvió.
    const recovered = grantAttempts(restored, "fixture.a", 3);
    expect(recovered.attempt_grants).toEqual({ "fixture.a": 3 });
    expect(attemptsAt(recovered, "fixture.a")).toBe(0);
    // Y a partir de ahí se vuelve a contar desde el intento siguiente.
    const retried = { ...recovered, attempts: spent("fixture.a", 4) };
    expect(attemptsAt(retried, "fixture.a")).toBe(1);
  });

  it("los contadores no entran en el sello de la posición: no vuelven vencida una respuesta", () => {
    const state = newRunState("quick", SESSION);
    const counted = withAttemptCounters(state, {
      floor: { "fixture.a": 2 },
      grants: { "fixture.a": 1 },
    });
    expect(positionDigest(counted)).toBe(positionDigest(state));
    // La degradación sí: es una decisión de la corrida, no contabilidad.
    expect(positionDigest(degradeTransition(state, "fixture.a", "agotó sus intentos"))).not.toBe(
      positionDigest(state),
    );
  });

  it("un contador vacío no se escribe: el archivo queda como estaba", () => {
    const state = newRunState("quick", SESSION);
    const reconciled = withAttemptCounters(state, { floor: {}, grants: {} });
    expect(serializeRunState(reconciled)).toBe(serializeRunState(state));
    expect(parseRunState(serializeRunState(reconciled)).ok).toBe(true);
  });
});

describe("degradación — una frontera agotada deja dicho por qué", () => {
  it("degradar omite el paso Y lo declara, con su causa", () => {
    const state = degradeTransition(
      newRunState("quick", SESSION),
      "fixture.a",
      "agotó sus 3 intentos: degradá el gap",
    );
    expect(state.applied).toEqual(["fixture.a"]);
    expect(state.skipped).toEqual(["fixture.a"]);
    expect(state.degraded).toEqual([
      { transition: "fixture.a", cause: "agotó sus 3 intentos: degradá el gap" },
    ]);
    // Salteada por condición: omitida SIN degradación. La diferencia que un
    // lector del estado final no podía hacer.
    const conditional = skipTransition(state, "fixture.b");
    expect(conditional.skipped).toEqual(["fixture.a", "fixture.b"]);
    expect(conditional.degraded?.map((one) => one.transition)).toEqual(["fixture.a"]);
    const back = parseRunState(serializeRunState(conditional));
    if (!back.ok) throw new Error(`esperaba un estado válido: ${back.failure.code}`);
    expect(back.state).toEqual(conditional);
  });

  it("una degradación sin causa, o sobre un paso que nunca se omitió, se rechaza", () => {
    const state = degradeTransition(newRunState("quick", SESSION), "fixture.a", "agotó");
    for (const broken of [
      { ...state, degraded: [{ transition: "fixture.a" }] },
      { ...state, degraded: [{ transition: "fixture.a", cause: "  " }] },
      { ...state, degraded: [{ transition: "fixture.z", cause: "agotó" }] },
      { ...state, attempt_floor: { "fixture.a": "tres" } },
      { ...state, attempt_grants: { "fixture.a": -1 } },
    ]) {
      const read = parseRunState(JSON.stringify(broken));
      if (read.ok) throw new Error("un estado mal formado no puede leerse");
      expect(read.failure.code).toBe("FLOW_RUN_INVALID");
    }
  });
});

describe("estado de corrida — fail-closed", () => {
  it("un estado editado a mano se rechaza con acción", () => {
    const state = newRunState("quick", SESSION);
    const tampered = { ...state, applied: ["fixture.a"] };
    const read = parseRunState(JSON.stringify(tampered));
    if (read.ok) throw new Error("un estado manipulado no puede leerse como válido");
    expect(read.failure.code).toBe("FLOW_RUN_TAMPERED");
    expect(read.failure.action.length).toBeGreaterThan(0);
  });

  it("una versión desconocida no avanza", () => {
    const state = newRunState("quick", SESSION);
    const ahead = JSON.stringify({ ...state, version: FLOW_RUN_STATE_VERSION + 1 });
    const read = parseRunState(ahead);
    if (read.ok) throw new Error("una versión futura no puede leerse");
    expect(read.failure.code).toBe("FLOW_RUN_VERSION_UNSUPPORTED");
  });

  it("un estado de una versión anterior se rechaza con re-adopción, sin migrar en silencio", () => {
    // Both older shapes, written out. Each predates fields the engine now reads,
    // and inventing them would fabricate the history this file exists to make
    // trustworthy — a run that started before the QUICK cutover has no record of
    // what it skipped, and "nothing was skipped" is not a safe guess.
    const v1 = {
      version: 1,
      flow: "quick",
      session: SESSION,
      applied: ["quick.entry-gate-signal"],
      boundary: "quick.entry-size-gate",
      authorizations: [],
      effects: { planned: [], approved: [], applied: [] },
      attempts: [],
      digest: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    };
    const v2 = { ...v1, version: 2, pending_action: null, observations: [] };
    for (const older of [v1, v2]) {
      const read = parseRunState(JSON.stringify(older));
      if (read.ok) throw new Error(`un estado v${older.version} no puede leerse como el vigente`);
      expect(read.failure.code).toBe("FLOW_RUN_VERSION_UNSUPPORTED");
      expect(read.failure.action).toContain("--adopt");
      expect(read.failure.action).toContain("migración automática");
    }
  });

  /**
   * La versión que este CLI escribe es la que un CLI anterior NO lee.
   *
   * El formato creció —el piso monótono de intentos, el perdón de una
   * recuperación, las degradaciones— y la versión se había quedado quieta: un
   * binario anterior leía el archivo nuevo sin error, ignoraba el piso y apagaba
   * el techo en silencio. Como la compuerta de versión es igualdad exacta en
   * todo build que salió, subirla es lo único que hace que ese binario falle con
   * causa. Y la lectura hacia atrás se preserva aparte, sin migrar nada: los
   * campos nuevos son opcionales y su ausencia es la lectura conservadora.
   */
  it("escribe una versión que un CLI anterior rechaza, y lee la anterior sin inventarle campos", () => {
    expect(FLOW_RUN_STATE_VERSION).toBeGreaterThan(7);
    expect(FLOW_RUN_STATE_READABLE).toContain(7);
    expect(FLOW_RUN_STATE_READABLE).not.toContain(FLOW_RUN_STATE_VERSION + 1);

    const { digest: _seal, ...current } = newRunState("quick", SESSION);
    const legacy = { ...current, version: 7 };
    const read = parseRunState(JSON.stringify({ ...legacy, digest: semanticDigest(legacy) }));
    if (!read.ok) throw new Error(`un ledger de la versión anterior se lee: ${read.failure.code}`);
    expect(read.state.attempt_floor).toBeUndefined();
    expect(read.state.degraded).toBeUndefined();
    // Y se re-sella con la vigente, para que el formato deje de variar por
    // archivo dentro de un mismo workspace.
    const stamped = atCurrentVersion(read.state);
    expect(stamped.version).toBe(FLOW_RUN_STATE_VERSION);
    expect(parseRunState(JSON.stringify(stamped)).ok).toBe(true);
  });

  it("los pasos omitidos son un subconjunto de los que la corrida pasó", () => {
    const state = newRunState("quick", SESSION);
    const inconsistent = {
      ...state,
      applied: ["quick.entry-gate-signal"],
      skipped: ["quick.gate-choice"],
    };
    const read = parseRunState(JSON.stringify(inconsistent));
    if (read.ok) throw new Error("una omisión fuera del cursor no puede leerse");
    expect(read.failure.code).toBe("FLOW_RUN_INVALID");
  });

  it("omitir avanza el cursor sin aplicar efecto alguno", () => {
    const state = skipTransition(newRunState("quick", SESSION), "quick.gate-choice");
    expect(state.applied).toEqual(["quick.gate-choice"]);
    expect(state.skipped).toEqual(["quick.gate-choice"]);
    expect(state.effects).toEqual({ planned: [], approved: [], applied: [] });
  });

  it("la acción pendiente y las observaciones se rechazan por forma", () => {
    const state = newRunState("quick", SESSION);
    for (const broken of [
      { ...state, pending_action: { transition: "fixture.a" } },
      { ...state, pending_action: "fixture.a" },
      { ...state, observations: [{ transition: "fixture.a" }] },
      { ...state, observations: [{ transition: "fixture.a", signals: [1, 2] }] },
    ]) {
      const read = parseRunState(JSON.stringify(broken));
      if (read.ok) throw new Error("un estado mal formado no puede leerse");
      expect(read.failure.code).toBe("FLOW_RUN_INVALID");
    }
  });

  it("la acción pendiente se pone y se limpia, y la observación no se duplica", () => {
    const pending = { transition: "fixture.a", digest: "sello" };
    const waiting = withPendingAction(newRunState("quick", SESSION), pending);
    // Emitida, todavía no empezada: la marca nace en falso y sólo la escribe el
    // paso que está por ejercer el efecto.
    expect(waiting.pending_action).toEqual({ ...pending, attempted: false });
    // Clearing matters as much: a run that moved on would otherwise tell whoever
    // resumes it to run something the engine no longer expects.
    expect(withPendingAction(waiting, null).pending_action).toBeNull();

    // Re-emitir la MISMA acción no puede olvidar que ya se empezó: cada advance
    // recalcula la frontera, y una marca reseteada al pasar por acá haría ver
    // intacta una corrida que no lo está.
    const begun = withActionAttempted(waiting);
    expect(begun.pending_action?.attempted).toBe(true);
    expect(withPendingAction(begun, pending).pending_action?.attempted).toBe(true);
    // Otra acción es otra cosa: la marca no viaja de una a la siguiente.
    expect(
      withPendingAction(begun, { transition: "fixture.b", digest: "sello" }).pending_action
        ?.attempted,
    ).toBe(false);

    const once = withObservation(waiting, { transition: "fixture.a", signals: ["s1"] });
    const twice = withObservation(once, { transition: "fixture.a", signals: ["s1", "s2"] });
    expect(twice.observations).toEqual([{ transition: "fixture.a", signals: ["s1", "s2"] }]);
    expect(parseRunState(serializeRunState(twice)).ok).toBe(true);
  });

  it("un JSON inválido o vacío no avanza", () => {
    for (const raw of ["", "{", "[]", '"texto"']) {
      const read = parseRunState(raw);
      if (read.ok) throw new Error(`'${raw}' no puede leerse como estado`);
      expect(read.failure.code, raw).toBe("FLOW_RUN_INVALID");
      expect(read.failure.action.length, raw).toBeGreaterThan(0);
    }
  });

  it("un flow desconocido o una sesión sin nombre se rechazan por forma", () => {
    const state = newRunState("quick", SESSION);
    for (const broken of [
      { ...state, flow: "no-existe" },
      { ...state, session: "  " },
      { ...state, authorizations: ["inventado"] },
    ]) {
      const read = parseRunState(JSON.stringify(broken));
      if (read.ok) throw new Error("un estado mal formado no puede leerse");
      expect(read.failure.code).toBe("FLOW_RUN_INVALID");
    }
  });

  it("un estado adelantado respecto de su recorrido se rechaza", () => {
    const state = { ...newRunState("quick", SESSION), applied: ["fixture.z"] } as FlowRunState;
    const failure = checkAgainstJourney(state, journey());
    expect(failure?.code).toBe("FLOW_RUN_AHEAD_OF_JOURNEY");
    expect(failure?.action.length).toBeGreaterThan(0);
  });

  it("una frontera que el estado no sostiene se rechaza", () => {
    const seeded = newRunState("quick", SESSION);
    const lying = { ...seeded, boundary: "fixture.c" } as FlowRunState;
    expect(checkAgainstJourney(lying, journey())?.code).toBe("FLOW_RUN_AHEAD_OF_JOURNEY");
  });
});

describe("estado de corrida — sobre un workspace real", () => {
  let workdir: string;
  let paths: PathsService;
  const fs = new NodeFileSystem();

  const HUMAN_ARTIFACTS = {
    "SESSION.md": "# SESSION — prueba\n\n## Objective\nprobar\n\n## Success criteria\n- [ ] una\n",
    "CHECKPOINT.md": "# CHECKPOINT — prueba\n\n## Completed\n- nada\n\n## Pending / Next\n- algo\n",
    "BACKLOG.md": "# BACKLOG — prueba\n\n## Deferred\n- nada\n",
  };

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-run-state-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    const dir = join(paths.cwdSessionsDir(), SESSION);
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(HUMAN_ARTIFACTS)) {
      await writeFile(join(dir, name), body, "utf8");
    }
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("una sesión sin estado es legacy, no corrupción: devuelve la acción de adopción", async () => {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (read.ok) throw new Error("no debería haber estado todavía");
    expect(read.failure.code).toBe("FLOW_RUN_ABSENT");
    expect(read.failure.action).toContain("--adopt");
  });

  it("la corrida se reconstruye desde el archivo", async () => {
    const location = locateRun(paths, SESSION);
    const created = await applyUnderLock(
      fs,
      location,
      () => ({ ok: true, state: newRunState("quick", SESSION), value: null }),
      { allowAbsent: true },
    );
    expect(created.ok).toBe(true);

    const read = await readRun(fs, location);
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    expect(read.state.flow).toBe("quick");
    expect(read.state.session).toBe(SESSION);
  });

  it("un estado manipulado en disco se rechaza con acción y no avanza", async () => {
    const location = locateRun(paths, SESSION);
    await writeFile(
      location.statePath,
      JSON.stringify({ ...newRunState("quick", SESSION), applied: ["fixture.a"] }),
      "utf8",
    );
    const read = await readRun(fs, location);
    if (read.ok) throw new Error("un estado manipulado no puede leerse");
    expect(read.failure.code).toBe("FLOW_RUN_TAMPERED");

    const attempted = await applyUnderLock(fs, location, () => ({
      ok: true,
      state: newRunState("quick", SESSION),
      value: null,
    }));
    expect(attempted.ok).toBe(false);
  });

  it("los tres artefactos humanos conservan sus encabezados", async () => {
    const location = locateRun(paths, SESSION);
    await applyUnderLock(
      fs,
      location,
      (current) => ({
        ok: true,
        state: applyTransition(current ?? newRunState("quick", SESSION), "fixture.a"),
        value: null,
      }),
      { allowAbsent: true },
    );
    for (const [name, body] of Object.entries(HUMAN_ARTIFACTS)) {
      expect(await readFile(join(location.dir, name), "utf8"), name).toBe(body);
    }
  });

  it("una respuesta sobre un estado que ya cambió no aplica nada", async () => {
    const location = locateRun(paths, SESSION);
    const seeded = newRunState("quick", SESSION);
    await applyUnderLock(fs, location, () => ({ ok: true, state: seeded, value: null }), {
      allowAbsent: true,
    });
    const moved = await applyUnderLock(fs, location, (current) => ({
      ok: true,
      state: applyTransition(current as FlowRunState, "fixture.a"),
      value: null,
    }));
    expect(moved.ok).toBe(true);

    const stale = await applyUnderLock(
      fs,
      location,
      (current) => ({
        ok: true,
        state: applyTransition(current as FlowRunState, "fixture.b"),
        value: null,
      }),
      { expectDigest: seeded.digest },
    );
    if (stale.ok) throw new Error("una respuesta vencida no puede aplicar");
    expect(stale.failure.code).toBe("FLOW_RUN_STALE");

    const after = await readRun(fs, location);
    if (!after.ok) throw new Error("esperaba leer la corrida");
    expect(after.state.applied).toEqual(["fixture.a"]);
  });

  /**
   * El contador se escribe aparte, sube solo, y una adopción lo empieza de cero.
   *
   * Lo último no es un agujero en la monotonía: para llegar a una adopción hay
   * que tirar la corrida entera —con todas sus transiciones aplicadas—, que es
   * un precio incomparable con perder tres intentos. Conservarlo sería peor que
   * inútil: re-adoptar tras un estado corrupto —la reparación que este mismo CLI
   * imprime— volvería con la primera frontera ya agotada.
   */
  it("el contador vive en su propio archivo, sube solo y una adopción lo reinicia", async () => {
    const location = locateRun(paths, SESSION);
    const attempt = {
      invocation_id: "sello",
      attempt: 1,
      request_digest: "payload",
      parent_request_digest: null,
      transition: "fixture.a",
    };
    await applyUnderLock(
      fs,
      location,
      () => ({ ok: true, state: newRunState("quick", SESSION), value: null }),
      { allowAbsent: true },
    );
    await applyUnderLock(fs, location, (current) => ({
      ok: true,
      state: withAttempt(current as FlowRunState, attempt),
      value: null,
    }));
    const counter = JSON.parse(await readFile(location.countersPath, "utf8"));
    expect(counter.attempts).toEqual({ "fixture.a": 1 });

    // Borrar el estado no borra la cuenta: restaurar es exactamente eso.
    await rm(location.statePath);
    await writeFile(location.statePath, serializeRunState(newRunState("quick", SESSION)), "utf8");
    const restored = await readRun(fs, location);
    if (!restored.ok) throw new Error("esperaba leer la corrida restaurada");
    expect(attemptsAt(restored.state, "fixture.a")).toBe(1);

    // Adoptar de nuevo sí: la corrida es otra, y empieza sin intentos.
    await rm(location.statePath);
    await applyUnderLock(
      fs,
      location,
      () => ({ ok: true, state: newRunState("quick", SESSION), value: null }),
      { allowAbsent: true },
    );
    const adopted = await readRun(fs, location);
    if (!adopted.ok) throw new Error("esperaba leer la corrida adoptada");
    expect(attemptsAt(adopted.state, "fixture.a")).toBe(0);
    expect(await fs.exists(location.countersPath)).toBe(false);
  });

  it("un contador ilegible no se degrada a cero: se rechaza con causa", async () => {
    const location = locateRun(paths, SESSION);
    await applyUnderLock(
      fs,
      location,
      () => ({ ok: true, state: newRunState("quick", SESSION), value: null }),
      { allowAbsent: true },
    );
    // El contador vive en el runtime del workspace, fuera de la carpeta de la
    // sesión: un backup de esa carpeta ya no se lo lleva.
    await mkdir(dirname(location.countersPath), { recursive: true });
    await writeFile(location.countersPath, "{ esto no es json", "utf8");
    const read = await readRun(fs, location);
    if (read.ok) throw new Error("un contador ilegible no puede leerse como cero intentos");
    expect(read.failure.code).toBe("FLOW_RUN_COUNTER_INVALID");
    expect(read.failure.action.length).toBeGreaterThan(0);
  });

  it("dos aplicaciones concurrentes: una sola ganadora y cero transiciones perdidas", async () => {
    const location = locateRun(paths, SESSION);
    await applyUnderLock(
      fs,
      location,
      () => ({
        ok: true,
        state: newRunState("quick", SESSION),
        value: null,
      }),
      { allowAbsent: true },
    );

    const race = (id: string) =>
      applyUnderLock(fs, location, async (current) => {
        // Yield inside the critical section: without the lock both readers would
        // see the same state and the second write would erase the first.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ok: true,
          state: applyTransition(current as FlowRunState, id),
          value: id,
        };
      });

    const [first, second] = await Promise.all([race("fixture.a"), race("fixture.b")]);
    const winners = [first, second].filter((result) => result.ok);
    const losers = [first, second].filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (loser === undefined || loser.ok) throw new Error("esperaba una perdedora");
    expect(loser.failure.code).toBe("FLOW_RUN_LOCKED");
    expect(loser.failure.action.length).toBeGreaterThan(0);

    const after = await readRun(fs, location);
    if (!after.ok) throw new Error("esperaba leer la corrida");
    expect(after.state.applied).toHaveLength(1);
  });
});
