import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import {
  FLOW_RUN_STATE_FILE,
  newRunState,
  serializeRunState,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { decidedState } from "../helpers/decided-state.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

// The engine walks only what the CLI owns, and no tranche is migrated yet: over the
// live rows this run would stop at its first `legacy` boundary and this file would
// be testing the migration instead of its own subject. The service resolves the
// journey from the registry, so the flip happens here — same flip, same reason as
// `tests/helpers/owned-journey.ts`, which the direct callers use.
vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  return {
    ...real,
    // The composed journey is what production walks, so that is what the flip
    // has to cover: mocking `decisionsOfScope` alone would leave the real
    // composition reading the real rows.
    journeyOfFlow: (flow: string) =>
      real
        .journeyOfFlow(flow as Parameters<typeof real.journeyOfFlow>[0])
        .map((row) => ({ ...row, ownership: "cli-owned" as const })),
  };
});

/**
 * A response that does not serve changes NOTHING it decided.
 *
 * The five failure modes are exercised over a real run and every one of them is
 * checked the same way: everything the run DECIDED — cursor, skips, boundary,
 * effects, observations, authorizations — has to come out identical, the
 * rejection has to travel with `ok: true` inside the recalculated directive, and
 * it has to name a code and one valid action.
 *
 * One field is deliberately outside that comparison: the attempt ledger. A
 * refused answer spends an attempt, and the count is the whole mechanism behind
 * the chassis' cap — asserting the file byte for byte would be asserting that
 * the cap cannot work. The last test here is the other half of that claim.
 */

const SESSION = "001-prueba-quick";
const fs = new NodeFileSystem();

describe("fail-closed — los cinco modos dejan el estado intacto", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-fail-closed-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);

  /** Everything the run decided, with the attempt bookkeeping left out. */
  const bytes = async (): Promise<string> =>
    JSON.stringify(decidedState(await readFile(statePath(), "utf8")));

  /** Put the run back where `beforeEach` left it, attempts included. */
  const reseed = async (): Promise<void> => {
    await rm(statePath());
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba re-adoptar la corrida");
  };

  async function seal(): Promise<string> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return resolveBoundary(read.state, journeyOfFlow(read.state.flow)).seal;
  }

  async function submit(raw: string, approval: string | null = null): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, { code: "001", raw, approval });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true, no ok:false");
    return result.directive;
  }

  it("ausente, inválida, ambigua, fuera de alcance y vencida: cinco códigos distintos", async () => {
    const current = await seal();
    const cases: Array<[string, string]> = [
      ["", "FLOW_ANSWER_MISSING"],
      ["{", "FLOW_ANSWER_INVALID"],
      [JSON.stringify({ input_digest: current }), "FLOW_ANSWER_AMBIGUOUS"],
      [
        JSON.stringify({ input_digest: current, signals: ["quick.inventada"] }),
        "FLOW_SIGNAL_UNKNOWN",
      ],
      [
        JSON.stringify({ input_digest: "0".repeat(64), signals: ["quick.needs-architecture"] }),
        "FLOW_ANSWER_STALE",
      ],
    ];

    const before = await bytes();
    const seen: string[] = [];
    for (const [raw, code] of cases) {
      // Fresh run per mode, on purpose: five refused answers in a row at ONE
      // boundary is not five failure modes, it is the loop the cap stops — and
      // the third of them would degrade the boundary before the fourth arrived.
      // Each mode gets its own run so this file keeps testing what it is about.
      await reseed();
      const directive = await submit(raw);
      expect(directive.error?.code, raw.slice(0, 40)).toBe(code);
      expect(directive.error?.action.length, code).toBeGreaterThan(0);
      expect(directive.next_action.length, code).toBeGreaterThan(0);
      // The recalculated boundary travels with the rejection: the sender can see
      // what to answer instead of being told only that it failed.
      expect(directive.boundary.transition, code).toBe("quick.entry-gate-signal");
      expect(await bytes(), `${code} escribió`).toBe(before);
      seen.push(code);
    }
    expect(new Set(seen).size).toBe(5);
  });

  it("el escenario de la spec: el estado cambió antes de que el agente respondiera", async () => {
    const stale = JSON.stringify({
      input_digest: await seal(),
      signals: ["quick.needs-architecture"],
    });

    // The world moves: a first answer is accepted and the run advances.
    const applied = await submit(
      JSON.stringify({ input_digest: await seal(), decisions: { tamaño: "cabe en un quick" } }),
    );
    expect(applied.error).toBeNull();
    expect(applied.applied.map((step) => step.transition)).toContain("quick.entry-gate-signal");

    const before = await bytes();
    const rejected = await submit(stale);
    expect(rejected.error?.code).toBe("FLOW_ANSWER_STALE");
    // Recalculated: the boundary it reports is the one in force NOW, not the one
    // the stale answer was written against.
    expect(rejected.boundary.transition).not.toBe("quick.entry-gate-signal");
    // The seal it reports is the CURRENT boundary's, not the one the stale answer
    // quoted: that difference is exactly what made it stale.
    expect(rejected.state_digest).not.toBe(JSON.parse(stale).input_digest);
    expect(await bytes()).toBe(before);
  });

  it("un reenvío idéntico no avanza el recorrido dos veces", async () => {
    const payload = JSON.stringify({
      input_digest: await seal(),
      signals: ["quick.needs-architecture"],
    });
    const first = await submit(payload);
    expect(first.error).toBeNull();
    const advancedTo = first.boundary.transition;
    const after = await bytes();

    const resent = await submit(payload);
    expect(resent.error?.code).toBe("FLOW_ANSWER_RESENT");
    expect(resent.outcome).toBe("completed");
    expect(resent.boundary.transition).toBe(advancedTo);
    expect(await bytes()).toBe(after);

    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    // One application, one recorded attempt — not two of either.
    expect(read.state.applied.filter((id) => id === "quick.entry-gate-signal")).toHaveLength(1);
    expect(read.state.attempts).toHaveLength(1);
  });

  it("una corrida que nunca se detuvo no acepta respuestas: la frontera la emite el motor", async () => {
    // A freshly seeded run has no boundary in force. Answering it would mean the
    // caller assuming which boundary applies, which is precisely what the engine
    // owns — so it is refused with the action that produces one.
    await writeFile(statePath(), serializeRunState(newRunState("quick", SESSION)), "utf8");
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    expect(read.state.boundary).toBeNull();

    const before = await bytes();
    const directive = await submit(JSON.stringify({ input_digest: await seal() }));
    expect(directive.error?.code).toBe("FLOW_ANSWER_NOT_EXPECTED");
    expect(directive.error?.action).toContain("aw flow advance");
    expect(await bytes()).toBe(before);
  });

  it("una sesión sin corrida no acepta respuestas", async () => {
    await rm(statePath());
    const result = await submitFlow(fs, paths, { code: "001", raw: "{}", approval: null });
    if (result.ok) throw new Error("sin corrida no hay nada que responder");
    if ("session" in result) throw new Error("esperaba un fallo de corrida, no de sesión");
    expect(result.failure.code).toBe("FLOW_RUN_ABSENT");
    expect(result.failure.action).toContain("--adopt");
  });
});
