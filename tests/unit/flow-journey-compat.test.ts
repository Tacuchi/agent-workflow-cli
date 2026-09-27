import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKLINE_FLOWS } from "../../src/application/capability/compose.js";
import { journeyForRun } from "../../src/application/flow/run-journey.js";
import {
  applyUnderLock,
  locateRun,
  readRun,
} from "../../src/application/flow/run-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { expandJourney, journeyOfFlow } from "../../src/domain/flow/authority.js";
import { V11_JOURNEY_BASE } from "../../src/domain/flow/journey-baseline.js";
import {
  FLOW_RUN_STATE_VERSION,
  type FlowRunReentry,
  type FlowRunState,
  checkAgainstJourney,
  parseRunState,
  serializeRunState,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { loadJourneyFixtures, stateWrittenAt } from "../helpers/journey-fixtures.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * AC-08 of spec 052: an open run survives updating the CLI.
 *
 * Every release that changes a journey freezes it under `tests/fixtures/journeys`.
 * The installed build must walk exactly the newest snapshot, and a run stopped at
 * ANY position of ANY frozen journey must keep going on it without a new
 * session and without being asked again what it already answered.
 */

const fixtures = loadJourneyFixtures();
const newest = fixtures.at(-1);

function expectPersistedPrefix(
  before: FlowRunState,
  disk: FlowRunState,
  ids: readonly string[],
): void {
  const expected = [...before.applied];
  const consent = "plan-exec.unchanged-phase-consent";
  const scope = expected.indexOf("plan-exec.source-scope");
  if (!ids.includes(consent) && scope >= 0) {
    expected.splice(scope, 0, consent);
    expect(disk.skipped).toContain(consent);
  }
  expect(disk.applied).toEqual(expected);
}

describe("recorridos congelados — el instalado es el de la última release", () => {
  it("conserva los recorridos históricos junto al gate de cierre nuevo", () => {
    expect(fixtures.map((fixture) => fixture.cli_version)).toEqual([
      "25.6.1",
      "25.8.0",
      "25.8.0-next",
      "25.8.1",
    ]);
    const published = fixtures.find((fixture) => fixture.cli_version === "25.8.0");
    expect(published?.run_state_version).toBe(13);
    const ids = published?.journeys["plan-exec"] ?? [];
    expect(ids).toContain("plan-exec.batch-close");
    expect(ids).not.toContain("plan-exec.batch-commit");
    expect(ids.indexOf("plan-exec.source-scope")).toBeGreaterThan(
      ids.indexOf("plan-exec.normalization-consent"),
    );
    expect(newest?.journeys["plan-exec"]).toContain("plan-exec.batch-commit");
  });

  it("hay al menos un fixture, y el último declara el registro que la release escribía", () => {
    expect(newest).toBeDefined();
    expect(newest?.run_state_version).toBeLessThanOrEqual(FLOW_RUN_STATE_VERSION);
  });

  for (const flow of WORKLINE_FLOWS) {
    it(`${flow}: el recorrido instalado es idéntico al del último fixture`, () => {
      expect(journeyOfFlow(flow).map((decision) => decision.id)).toEqual(newest?.journeys[flow]);
    });
  }

  it("la base de un registro v11 es el recorrido que caminaba la 25.6.1", () => {
    const frozen = fixtures.find((fixture) => fixture.cli_version === "25.6.1");
    expect(frozen?.run_state_version).toBe(11);
    expect(V11_JOURNEY_BASE).toEqual(frozen?.journeys);
  });

  it("plan-exec conserva los dos bordes de su tramo repetible", () => {
    const ids = journeyOfFlow("plan-exec").map((decision) => decision.id);
    const { first, last } = newest?.repeatable["plan-exec"] ?? { first: "", last: "" };
    expect(ids.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(last)).toBeGreaterThan(ids.indexOf(first));
  });
});

describe("una corrida detenida en cualquier posición sigue con el build instalado", () => {
  const SESSION = "001-compat-recorridos";
  const fs = new NodeFileSystem();
  let workdir: string;
  let paths: PathsService;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-journey-compat-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  for (const fixture of fixtures) {
    for (const flow of WORKLINE_FLOWS) {
      it(`${fixture.cli_version} · ${flow}: toda posición se continúa sin repreguntar`, async () => {
        const ids = fixture.journeys[flow];
        const location = locateRun(paths, SESSION);
        for (let position = 0; position <= ids.length; position += 1) {
          const before = stateWrittenAt(
            fixture.run_state_version,
            flow,
            SESSION,
            ids.slice(0, position),
            ids[position] ?? null,
            fixture.run_state_version >= 12 ? { journey_base: ids } : {},
          );
          await writeFile(location.statePath, serializeRunState(before), "utf8");

          const read = await readRun(fs, location);
          if (!read.ok) throw new Error(`${flow}@${position}: ${read.failure.code}`);
          const after = read.state;
          expect(after.version).toBe(FLOW_RUN_STATE_VERSION);
          expect(checkAgainstJourney(after, journeyForRun(after))).toBeNull();
          // Standing on the same boundary is what "not asked again" means: every
          // step behind it stays behind it.
          expect(after.boundary).toBe(before.boundary);
          const kept = after.applied.filter((id) => before.applied.includes(id));
          expect(kept).toEqual(before.applied);
          const inserted = after.applied.filter((id) => !before.applied.includes(id));
          expect(inserted.every((id) => after.skipped.includes(id))).toBe(true);
        }
      });

      it(`${fixture.cli_version} · ${flow}: la siguiente escritura la persiste en la versión vigente`, async () => {
        // Continuing means the next write persists the upgraded run at the
        // position it had, standing on the installed journey.
        const ids = fixture.journeys[flow];
        const location = locateRun(paths, SESSION);
        const stopped = Math.floor(ids.length / 2);
        const before = stateWrittenAt(
          fixture.run_state_version,
          flow,
          SESSION,
          ids.slice(0, stopped),
          ids[stopped] ?? null,
          fixture.run_state_version >= 12 ? { journey_base: ids } : {},
        );
        await writeFile(location.statePath, serializeRunState(before), "utf8");
        const written = await applyUnderLock(fs, location, (state) =>
          state === null
            ? { ok: false as const, failure: { code: "X", message: "sin corrida", action: "-" } }
            : { ok: true as const, state, value: null },
        );
        if (!written.ok) throw new Error(`${flow}: ${written.failure.code}`);
        const disk = parseRunState(await readFile(location.statePath, "utf8"));
        if (!disk.ok) throw new Error(`${flow}: ${disk.failure.code}`);
        expect(disk.state.version).toBe(FLOW_RUN_STATE_VERSION);
        expectPersistedPrefix(before, disk.state, ids);
        expect(disk.state.boundary).toBe(before.boundary);
        expect(disk.state.journey_base).toEqual(journeyOfFlow(flow).map((decision) => decision.id));
      });
    }
  }
});

describe("una corrida que refinó una o dos veces sigue alineada", () => {
  /**
   * AC-12 no puede romper AC-08: una corrida con reentradas de `Refinar`, parada
   * en cualquier posición después de ellas, se lee, se continúa y no se le
   * repregunta nada — también cuando la release instalada agregó una fila antes
   * de la confirmación, que es cuando un índice absoluto dejaría de apuntar a su
   * fila. Y un registro v12 (la 25.7.0) sube a la versión vigente sin moverse.
   */
  const SESSION = "002-compat-refinar";
  const fs = new NodeFileSystem();
  /** Authoring row, and a row of the redraft stretch a newer build could add. */
  const REDRAFT = {
    "spec-refine": { from: "spec-refine.content-authoring", added: "spec-refine.design-reuse" },
    "plan-new": { from: "plan-new.phase-shaping", added: "plan-new.split-gate" },
    "plan-refine": { from: "plan-refine.journey-map", added: "plan-refine.preserve-validated" },
  } as const;
  let workdir: string;
  let paths: PathsService;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-journey-refinar-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  /** The walked ids and the reentries of a run that refined `times` times over `base`. */
  function refinedJourney(flow: keyof typeof REDRAFT, base: readonly string[], times: number) {
    const confirmation = `${flow}.save-confirmation`;
    const { from } = REDRAFT[flow];
    const segment = base.slice(base.indexOf(from), base.indexOf(confirmation) + 1);
    let ids = [...base];
    const reentries: FlowRunReentry[] = [];
    let position = base.indexOf(confirmation);
    for (let round = 1; round <= times; round += 1) {
      reentries.push({ kind: "refine", transition: confirmation, occurrence: round, from });
      ids = [...ids.slice(0, position + 1), ...segment, ...ids.slice(position + 1)];
      position += segment.length;
    }
    return { ids, reentries, after: position - segment.length };
  }

  for (const flow of Object.keys(REDRAFT) as (keyof typeof REDRAFT)[]) {
    const installed = journeyOfFlow(flow).map((decision) => decision.id);
    const older = installed.filter((id) => id !== REDRAFT[flow].added);
    for (const times of [1, 2]) {
      for (const [label, base] of [
        ["instalada", installed],
        [`sin '${REDRAFT[flow].added}'`, older],
      ] as const) {
        it(`${flow} · refinó ${times} vez/veces · base ${label}: toda posición posterior sigue`, async () => {
          const { ids, reentries, after } = refinedJourney(flow, base, times);
          const location = locateRun(paths, SESSION);
          for (let position = after + 1; position <= ids.length; position += 1) {
            const before = stateWrittenAt(
              FLOW_RUN_STATE_VERSION,
              flow,
              SESSION,
              ids.slice(0, position),
              ids[position] ?? null,
              { reentries, journey_base: [...base] },
            );
            await writeFile(location.statePath, serializeRunState(before), "utf8");
            const read = await readRun(fs, location);
            if (!read.ok) throw new Error(`${flow}@${position}: ${read.failure.code}`);
            expect(checkAgainstJourney(read.state, journeyForRun(read.state))).toBeNull();
            expect(read.state.boundary).toBe(before.boundary);
            // Nothing it had answered moved; only the added row entered, skipped,
            // once per walk of it the run had already passed.
            const added = REDRAFT[flow].added;
            expect(read.state.applied.filter((id) => base.includes(id))).toEqual(before.applied);
            const entered = read.state.applied.filter((id) => !base.includes(id));
            expect(entered.every((id) => id === added)).toBe(true);
            expect(read.state.skipped.filter((id) => id === added)).toEqual(entered);
          }
        });
      }
    }
  }

  for (const flow of WORKLINE_FLOWS) {
    it(`${flow}: un registro v12 sube a la versión vigente sin moverse`, async () => {
      const ids = journeyOfFlow(flow).map((decision) => decision.id);
      const stopped = Math.floor(ids.length / 2);
      const location = locateRun(paths, SESSION);
      const before = stateWrittenAt(12, flow, SESSION, ids.slice(0, stopped), ids[stopped] ?? null);
      await writeFile(location.statePath, serializeRunState(before), "utf8");
      const read = await readRun(fs, location);
      if (!read.ok) throw new Error(`${flow}: ${read.failure.code}`);
      expect(read.state.version).toBe(FLOW_RUN_STATE_VERSION);
      expect(read.state.applied).toEqual(before.applied);
      expect(read.state.boundary).toBe(before.boundary);
      expect(read.state.reentries).toBeUndefined();
    });
  }
});

describe("una corrida v14 en la segunda copia del tramo previo al commit por lote", () => {
  it("inserta omitidas las filas nuevas ya atravesadas y conserva la frontera vigente", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-journey-batch-commit-"));
    try {
      const paths = new PathsService(normalizeNamespace("workflow"), root, root);
      const session = "236-compat-plan-exec";
      const location = locateRun(paths, session);
      await mkdir(location.dir, { recursive: true });
      const newer = journeyOfFlow("plan-exec").map((row) => row.id);
      const prior = newer.filter((id) => !id.startsWith("plan-exec.batch-commit"));
      const first = prior.indexOf("plan-exec.batch-eligibility-signal");
      const last = prior.indexOf("plan-exec.batch-close");
      const priorWalk = [
        ...prior.slice(0, first),
        ...prior.slice(first, last + 1),
        ...prior.slice(first),
      ];
      const secondClose = priorWalk.lastIndexOf("plan-exec.batch-close");
      const batch = (id: string, iteration: number, closed: boolean) => ({
        id,
        iteration,
        mode: "isolated" as const,
        phases: [iteration],
        tasks: [`T${iteration}.1`],
        plan_digest: "plan",
        stage: closed ? ("closed" as const) : ("reviewing" as const),
        ...(closed ? { published_plan_digest: "after" } : {}),
      });
      const before = stateWrittenAt(
        14,
        "plan-exec",
        session,
        priorWalk.slice(0, secondClose),
        "plan-exec.batch-close",
        {
          journey_base: prior,
          batches: [batch("batch-1", 1, true), batch("batch-2", 2, false)],
          batch_loop: { pending: true, iteration: 2 },
        },
      );
      await writeFile(location.statePath, serializeRunState(before));
      const read = await readRun(new NodeFileSystem(), location);
      if (!read.ok) throw new Error(read.failure.message);
      expect(checkAgainstJourney(read.state, journeyForRun(read.state))).toBeNull();
      expect(read.state.boundary).toBe("plan-exec.batch-close");
      expect(
        read.state.applied.filter((id) => id === "plan-exec.batch-commit-proposal"),
      ).toHaveLength(2);
      expect(read.state.skipped.filter((id) => id === "plan-exec.batch-commit")).toHaveLength(2);
      expect(read.state.batches?.[0]?.commit_result).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("expandJourney: el cierre en frontera y la reapertura", () => {
  const base = journeyOfFlow("spec-refine");
  const ids = base.map((decision) => decision.id);
  const expand = (reentries: FlowRunReentry[]) =>
    expandJourney({ flow: "spec-refine", reentries }, base);
  const close: FlowRunReentry = {
    kind: "close",
    transition: "spec-refine.functional-ambiguity",
    occurrence: 1,
    from: null,
  };
  const at = ids.indexOf("spec-refine.functional-ambiguity");

  it("cerrar en una frontera termina el recorrido en un finalize puesto ahí", () => {
    const { rows, copies } = expand([close]);
    expect(rows.map((row) => row.id)).toEqual([...ids.slice(0, at), "chassis.finalize"]);
    expect(copies.at(-1)).toBe(1);
  });

  it("reabrir después del cierre devuelve las filas originales, sin copias", () => {
    const reopen: FlowRunReentry = { ...close, kind: "reopen", from: close.transition };
    const { rows, copies } = expand([close, reopen]);
    expect(rows.map((row) => row.id)).toEqual([
      ...ids.slice(0, at),
      "chassis.finalize",
      ...ids.slice(at),
    ]);
    // La frontera cerrada conserva su identidad: cerrar y reabrir no rellena intentos.
    expect(copies.slice(at + 1).every((copy) => copy === 0)).toBe(true);
  });

  it("reabrir un recorrido terminado repite desde su última humana, como copia", () => {
    const human = "spec-refine.save-confirmation";
    const reopen: FlowRunReentry = {
      kind: "reopen",
      transition: human,
      occurrence: 1,
      from: human,
    };
    const { rows, copies } = expand([reopen]);
    const again = ids.slice(ids.indexOf(human));
    expect(rows.map((row) => row.id)).toEqual([...ids, ...again]);
    expect(copies.slice(ids.length).every((copy) => copy === 1)).toBe(true);
  });

  it("un cierre cuya frontera ya no existe se omite, y su reapertura también", () => {
    const lost: FlowRunReentry = { ...close, transition: "spec-refine.retirada" };
    const reopen: FlowRunReentry = { ...lost, kind: "reopen", from: lost.transition };
    expect(expand([lost, reopen]).rows.map((row) => row.id)).toEqual(ids);
  });
});
