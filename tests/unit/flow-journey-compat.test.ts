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
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import { V11_JOURNEY_BASE } from "../../src/domain/flow/journey-baseline.js";
import {
  FLOW_RUN_STATE_VERSION,
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
 * The installed build must walk exactly the newest one, and a v11 run stopped at
 * ANY position of ANY frozen journey must keep going on it without a new
 * session and without being asked again what it already answered.
 */

const fixtures = loadJourneyFixtures();
const newest = fixtures.at(-1);

describe("recorridos congelados — el instalado es el de la última release", () => {
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

      it(`${fixture.cli_version} · ${flow}: la siguiente escritura la persiste en la v12`, async () => {
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
        expect(disk.state.applied).toEqual(before.applied);
        expect(disk.state.boundary).toBe(before.boundary);
        expect(disk.state.journey_base).toEqual(journeyOfFlow(flow).map((decision) => decision.id));
      });
    }
  }
});
