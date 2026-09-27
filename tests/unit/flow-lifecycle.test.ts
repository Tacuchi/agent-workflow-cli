import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorklineFlow } from "../../src/application/capability/compose.js";
import { findActiveSessions } from "../../src/application/checkpoint-service.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { markCloseAtBoundary } from "../../src/application/flow/close-at-boundary.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { journeyForRun } from "../../src/application/flow/run-journey.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { CLOSED_MARKER } from "../../src/application/session-resolver.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import { sessionCloseCommand } from "../../src/cli/commands/session-close.js";
import { sessionResumeCommand } from "../../src/cli/commands/session-resume.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_VERSION,
  type FlowRunState,
  serializeRunState,
} from "../../src/domain/flow/run-state.js";
import { sealProposal } from "../../src/domain/proposal.js";
import { reservationMarker } from "../../src/domain/reservation.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { stateWrittenAt } from "../helpers/journey-fixtures.js";
import { NodeFileSystem } from "../helpers/real-fs.js";
import { testExecutor } from "../helpers/test-executor.js";

/**
 * AC-13 de la spec 052: `aw session-close` sobre una sesión con corrida abierta
 * cierra la sesión y termina la corrida en la frontera en que estaba, con el
 * cierre en su traza. Si el cierre no puede correr, se niega sin dejar nada a
 * medias; sin corrida, cierra como antes.
 */

const units = vi.hoisted(() => ({
  listed: { units: [] } as unknown,
}));

vi.mock("../../src/application/worktree-service.js", () => ({
  runWorktree: async () => units.listed,
  classifyListedUnits: async (_deps: unknown, listed: unknown) => listed,
}));

const fs = new NodeFileSystem();
const SESSION = "051-ciclo-spec-refine";
const AMBIGUITY = "spec-refine.functional-ambiguity";
const IDS = journeyOfFlow("spec-refine").map((decision) => decision.id);

let workdir: string;
let paths: PathsService;
let ctx: CliContext;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "aw-ciclo-"));
  paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
  ctx = {
    fs,
    env: new FakeEnv(workdir, workdir),
    git: new RecordingGit(),
    paths,
  } as unknown as CliContext;
  units.listed = { units: [] };
  await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
  await writeFile(
    join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
    "# SESSION — ciclo\n\n## Objective\nrefinar la spec\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** A spec-refine run standing on `boundary`, every row before it walked. */
async function runStandingOn(boundary: string, extra: Partial<FlowRunState> = {}): Promise<string> {
  const at = IDS.indexOf(boundary);
  const state = stateWrittenAt(
    FLOW_RUN_STATE_VERSION,
    "spec-refine",
    SESSION,
    IDS.slice(0, at),
    boundary,
    extra,
  );
  const bytes = serializeRunState(state);
  await writeFile(locateRun(paths, SESSION).statePath, bytes, "utf8");
  return bytes;
}

async function close() {
  return sessionCloseCommand.execute(parseArgv(["session-close", "--code", "051"]), ctx);
}

async function run() {
  const read = await readRun(fs, locateRun(paths, SESSION));
  if (!read.ok) throw new Error(read.failure.code);
  return read.state;
}

const closed = () => existsSync(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER));
const history = async () => {
  const file = paths.cwdHistoryFile();
  return existsSync(file) ? await readFile(file, "utf8") : "";
};

describe("Cerrar aplica finalize y conserva lo pendiente (073 F1)", () => {
  async function seed(flow: WorklineFlow, boundary: string, extra: Partial<FlowRunState> = {}) {
    const ids = journeyOfFlow(flow).map((row) => row.id);
    const state = stateWrittenAt(
      FLOW_RUN_STATE_VERSION,
      flow,
      SESSION,
      ids.slice(0, ids.indexOf(boundary)),
      boundary,
      extra,
    );
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state));
  }

  async function chooseClose(git = new RecordingGit(), filesystem = fs) {
    const state = await run();
    const boundary = resolveBoundary(state, journeyForRun(state));
    const result = await submitFlow(filesystem, paths, {
      code: "051",
      raw: JSON.stringify({ input_digest: boundary.seal, choice: "Cerrar" }),
      approval: null,
      executor: testExecutor(filesystem, paths, { git }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.directive;
  }

  it.each([
    ["spec-refine", "spec-refine.save-confirmation"],
    ["plan-new", "plan-new.save-confirmation"],
    ["plan-refine", "plan-refine.save-confirmation"],
    ["plan-exec", "plan-exec.commit-authorization"],
    ["quick", "quick.gate-choice"],
  ] as const)("%s: cierra sesión, HISTORY y corrida, y reabre en %s", async (flow, boundary) => {
    await seed(flow, boundary);
    const result = await chooseClose();
    expect(result.error).toBeNull();
    expect(result.outcome).toBe("completed");
    expect(closed()).toBe(true);
    expect(await history()).toContain("closed");
    expect(await findActiveSessions(fs, paths)).toEqual([]);
    const state = await run();
    expect(state.applied.at(-1)).toBe("chassis.finalize");
    expect(state.applied).not.toContain(boundary);
    expect(state.attempts.filter((attempt) => attempt.transition === boundary)).toEqual([]);
    for (const artifact of ["CHECKPOINT.md", "BACKLOG.md"]) {
      const text = await readFile(join(paths.cwdSessionsDir(), SESSION, artifact), "utf8");
      expect(text).toContain(boundary);
      expect(text).toContain(`aw session-resume --code ${SESSION} --reopen`);
      expect(text).not.toContain("_[AI:");
    }
    const resumed = await runSessionResume(fs, ctx.env, paths, { code: "051", reopen: true });
    expect(resumed).toMatchObject({ run: { resumes_at: boundary }, state: "active" });
  });

  it("conserva lote 2 sucio y unidades sin integrar, y avisa cuáles en la respuesta", async () => {
    await seed("plan-exec", "plan-exec.commit-authorization", {
      batches: [
        {
          id: "batch-2",
          iteration: 2,
          mode: "continuous",
          phases: [2],
          tasks: ["T2.1"],
          plan_digest: "a".repeat(64),
          stage: "closed",
        },
      ],
    });
    const unitPath = join(workdir, "unidad");
    await mkdir(unitPath);
    await writeFile(join(unitPath, "cambio.ts"), "trabajo del lote 2");
    units.listed = {
      units: [
        { alias: "cli", session: SESSION, path: unitPath, branch: `aw/${SESSION}`, dirty: true },
        { alias: "api", session: SESSION, path: "/tmp/api", branch: `aw/${SESSION}`, dirty: false },
        {
          alias: "ajena",
          session: "099-ajena",
          path: "/tmp/ajena",
          branch: "aw/ajena",
          dirty: true,
        },
      ],
    };
    const result = await chooseClose();
    expect(result.error).toBeNull();
    expect(result.next_action).toContain("lote 2 (batch-2): cli: sin commitear y sin integrar");
    expect(result.next_action).toContain("api: sin integrar");
    expect(result.next_action).not.toContain("ajena");
    expect(await readFile(join(unitPath, "cambio.ts"), "utf8")).toBe("trabajo del lote 2");
    expect(await readFile(join(paths.cwdSessionsDir(), SESSION, "BACKLOG.md"), "utf8")).toContain(
      "lote 2",
    );
  });

  it.each(["quick", "plan-exec"] as const)("%s avisa fuentes sucias", async (flow) => {
    await seed(
      flow,
      flow === "quick" ? "quick.gate-choice" : "plan-exec.commit-authorization",
      flow === "quick"
        ? {}
        : {
            scope: { plan: "docs/plans/051-plan-ciclo.md", sources: ["workspace", "cli"] },
            batches: [
              {
                id: "batch-2",
                iteration: 2,
                mode: "continuous",
                phases: [2],
                tasks: ["T2.1"],
                plan_digest: "a".repeat(64),
                stage: "closed",
              },
            ],
          },
    );
    await mkdir(join(workdir, "cli"));
    await writeFile(
      join(workdir, "AGENTS.md"),
      [
        paths.blockMarkers().start,
        "## Fuentes",
        "| Alias | Path | Rama principal |",
        "|---|---|---|",
        `| cli | ${workdir}/cli | main |`,
        paths.blockMarkers().end,
      ].join("\n"),
    );
    const result = await chooseClose(new RecordingGit({ dirty: true }));
    expect(result.error).toBeNull();
    expect(result.next_action).toContain("cli: cambios sin commitear");
    expect(result.next_action).toContain("workspace: cambios sin commitear");
    if (flow === "plan-exec") {
      expect(result.next_action).toContain("lote 2 (batch-2): cli: cambios sin commitear");
      expect(result.next_action).toContain("lote 2 (batch-2): workspace: cambios sin commitear");
    }
    expect(closed()).toBe(true);
  });

  it.each(["Cerrar", "session-close"])("%s conserva y publica la reserva", async (method) => {
    const path = "docs/specs/051-spec-ciclo.md";
    const reserved = reservationMarker(SESSION);
    await mkdir(join(workdir, "docs/specs"), { recursive: true });
    await writeFile(join(workdir, path), reserved);
    await writeFile(join(workdir, "docs/specs/052-spec-descartada.md"), reserved);
    const proposal = sealProposal({
      operation: "flow.spec-refine.content-authoring",
      artifacts: [
        { path, content: "# Spec 051 — propuesta pendiente\n", overwrite: false, reserved: true },
      ],
      bases: [{ path, digest: semanticDigest(reserved) }],
      effects: ["local_additive"],
      requiresApproval: [],
    });
    await seed("spec-refine", "spec-refine.save-confirmation", { proposal });
    if (method === "Cerrar") expect((await chooseClose()).error).toBeNull();
    else expect((await close()).ok).toBe(true);
    // Retrying an already settled close must not discard the retained base.
    expect((await close()).ok).toBe(true);
    expect(await readFile(join(workdir, path), "utf8")).toBe(reserved);
    expect(existsSync(join(workdir, "docs/specs/052-spec-descartada.md"))).toBe(false);
    expect((await run()).proposal).toEqual(proposal);
    await runSessionResume(fs, ctx.env, paths, { code: "051", reopen: true });
    expect((await run()).proposal).toEqual(proposal);
    const state = await run();
    const result = await submitFlow(fs, paths, {
      code: "051",
      approval: null,
      raw: JSON.stringify({
        input_digest: resolveBoundary(state, journeyForRun(state)).seal,
        choice: "Aprobar y guardar",
      }),
      executor: testExecutor(fs, paths),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.directive.error).toBeNull();
    expect(await readFile(join(workdir, path), "utf8")).toBe(proposal.artifacts[0]?.content);
  });

  it("una negativa conserva la sesión abierta en finalize y advance reintenta una sola copia", async () => {
    await seed("quick", "quick.gate-choice");
    const checkpoint = join(paths.cwdSessionsDir(), SESSION, "CHECKPOINT.md");
    await writeFile(
      checkpoint,
      "# CHECKPOINT\n\n## Completed\n\nTrabajo previo.\n\n## Pending / Next\n\nNota propia.\n",
    );
    const backlog = join(paths.cwdSessionsDir(), SESSION, "BACKLOG.md");
    class BacklogFailure extends NodeFileSystem {
      override async writeText(path: string, text: string) {
        if (path === backlog) throw new Error("BACKLOG no escribible");
        return super.writeText(path, text);
      }
    }
    const refused = await chooseClose(new RecordingGit(), new BacklogFailure());
    expect(refused.error).not.toBeNull();
    expect(refused.boundary.transition).toBe("chassis.finalize");
    expect(closed()).toBe(false);
    const retry = await advanceFlow(fs, paths, { code: "051", executor: testExecutor(fs, paths) });
    if (!retry.ok) throw new Error(JSON.stringify(retry));
    expect(retry.directive.error).toBeNull();
    expect(closed()).toBe(true);
    const text = await readFile(checkpoint, "utf8");
    expect(text.match(/WORKLINE-CLOSE-START/g)).toHaveLength(1);
    expect(text).toContain("Trabajo previo.");
    expect(text).toContain("Nota propia.");
    expect((await run()).reentries).toHaveLength(1);
  });

  it("no cierra si no puede observar las unidades; después de repararlas se reintenta", async () => {
    await seed("quick", "quick.gate-choice");
    units.listed = { error: "git no responde" };
    const result = await chooseClose();
    expect(result.error?.message).toContain("aw worktree list");
    expect(closed()).toBe(false);
    units.listed = { units: [] };
    const retry = await advanceFlow(fs, paths, { code: "051", executor: testExecutor(fs, paths) });
    if (!retry.ok) throw new Error(JSON.stringify(retry));
    expect(retry.directive.outcome).toBe("completed");
    expect(closed()).toBe(true);
  });
});

describe("aw session-close sobre una corrida abierta", () => {
  it("rechaza un placeholder antes de escribir los artefactos del cierre en frontera", async () => {
    await runStandingOn(AMBIGUITY);
    const checkpoint = join(paths.cwdSessionsDir(), SESSION, "CHECKPOINT.md");
    const before = "# CHECKPOINT\n\n## Completed\n_[AI: pendiente]_\n";
    await writeFile(checkpoint, before, "utf8");
    const denied = await close();
    expect(denied.ok).toBe(false);
    expect(closed()).toBe(false);
    expect(await readFile(checkpoint, "utf8")).toBe(before);
    expect(existsSync(join(paths.cwdSessionsDir(), SESSION, "BACKLOG.md"))).toBe(false);
  });

  it("el flag de excepción del comando llega hasta la validación del CHECKPOINT", async () => {
    const checkpoint = join(paths.cwdSessionsDir(), SESSION, "CHECKPOINT.md");
    await writeFile(checkpoint, "# CHECKPOINT\n\n## Completed\n_[AI: pendiente]_\n", "utf8");
    const denied = await close();
    expect(denied.ok).toBe(false);
    expect(closed()).toBe(false);
    const approved = await sessionCloseCommand.execute(
      parseArgv(["session-close", "--code", "051", "--force"]),
      ctx,
    );
    expect(approved.ok).toBe(true);
    expect(closed()).toBe(true);
  });

  it("cierra la sesión y termina la corrida en la frontera en que estaba", async () => {
    await runStandingOn(AMBIGUITY);
    const result = await close();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ run: { closed_at: AMBIGUITY, finalize: "applied" } });
    expect(closed()).toBe(true);

    const state = await run();
    expect(state.reentries).toEqual([
      { kind: "close", transition: AMBIGUITY, occurrence: 1, from: null },
    ]);
    expect(state.applied.at(-1)).toBe("chassis.finalize");
    expect(state.applied).not.toContain(AMBIGUITY);
    const narrative = await readFile(join(paths.cwdSessionsDir(), SESSION, "SESSION.md"), "utf8");
    expect(narrative).toContain("**Siguiente paso:** ninguno");
    expect(narrative).not.toContain("**Siguiente paso:** pendiente");
    expect(resolveBoundary(state, journeyForRun(state)).stopped).toBeNull();
    // El cierre queda en la traza material, con lo que el cierre realmente hizo.
    expect(state.events.at(-1)).toMatchObject({
      kind: "executed",
      transition: "chassis.finalize",
      reentry_iteration: 1,
      operation: "session.close",
    });
  });

  it("con una unidad viva, el cierre la conserva y lo avisa", async () => {
    await runStandingOn(AMBIGUITY);
    const unit = { alias: "cli", session: SESSION, path: "/tmp/unidad", branch: `aw/${SESSION}` };
    units.listed = { units: [unit] };
    const result = await close();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      run: { closed_at: AMBIGUITY, finalize: "applied" },
      pending_integration: [{ alias: "cli", branch: `aw/${SESSION}` }],
      reopen: `aw session-resume --code ${SESSION} --reopen`,
    });
    expect((await run()).applied.at(-1)).toBe("chassis.finalize");
  });

  it("con el inventario de unidades ilegible, la negativa no cierra nada", async () => {
    const before = await runStandingOn(AMBIGUITY);
    const historyBefore = await history();
    units.listed = { error: "git no responde" };
    const result = await close();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("SESSION_UNITS_UNREADABLE");
    expect((result.data as { action?: string }).action).toContain("aw worktree list");
    expect(closed()).toBe(false);
    expect(await history()).toBe(historyBefore);
    // La intención registrada se retiró: la corrida quedó byte a byte como estaba.
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(before);
  });

  it("con la corrida tomada por otra invocación, se niega sin cerrar", async () => {
    const before = await runStandingOn(AMBIGUITY);
    const lock = { pid: process.pid, ts: new Date().toISOString(), token: "otro" };
    await writeFile(locateRun(paths, SESSION).lockPath, JSON.stringify(lock), "utf8");
    const result = await close();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FLOW_RUN_LOCKED");
    expect((result.data as { action?: string }).action).toContain("aw session-close --code 051");
    expect(closed()).toBe(false);
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(before);
  });

  it("una sesión sin corrida cierra como antes", async () => {
    const result = await close();
    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty("run");
    expect(closed()).toBe(true);
  });

  it("una corrida ya terminada no se toca: la sesión cierra como antes", async () => {
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null);
    const bytes = serializeRunState(state);
    await writeFile(locateRun(paths, SESSION).statePath, bytes, "utf8");
    const result = await close();
    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty("run");
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(bytes);
  });
});

describe("aw session-close: los caminos que no dejan nada a medias", () => {
  const PENDING = {
    transition: "spec-refine.publication",
    invocation_id: "sello",
    digest: "accion",
    attempted: true,
  };

  it("una negativa conserva la acción ya empezada: la corrida queda byte a byte igual", async () => {
    const before = await runStandingOn("spec-refine.publication", {
      pending_action: PENDING,
    } as Partial<FlowRunState>);
    units.listed = { error: "git no responde" };
    expect((await close()).error?.code).toBe("SESSION_UNITS_UNREADABLE");
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(before);
  });

  it("un cierre rechazado retira la intención y no cierra nada", async () => {
    const before = await runStandingOn(AMBIGUITY);
    // Dos carpetas con el mismo número: el cierre se niega antes de escribir.
    await mkdir(join(paths.cwdSessionsDir(), "051-otra-quick"), { recursive: true });
    const result = await sessionCloseCommand.execute(
      parseArgv(["session-close", "--code", SESSION]),
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(closed()).toBe(false);
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(before);
  });

  it("después de un intento cortado tras la intención, volver a cerrar lo completa", async () => {
    await runStandingOn(AMBIGUITY);
    expect((await markCloseAtBoundary(fs, locateRun(paths, SESSION))).kind).toBe("marked");
    const result = await close();
    expect(result.data).toMatchObject({ run: { closed_at: AMBIGUITY, finalize: "applied" } });
    const state = await run();
    expect(state.reentries).toHaveLength(1);
    expect(state.applied.at(-1)).toBe("chassis.finalize");
  });

  it("un reintento que se niega no retira la intención que dejó el intento anterior", async () => {
    await runStandingOn(AMBIGUITY);
    expect((await markCloseAtBoundary(fs, locateRun(paths, SESSION))).kind).toBe("marked");
    const marked = await readFile(locateRun(paths, SESSION).statePath, "utf8");
    units.listed = { error: "git no responde" };
    expect((await close()).error?.code).toBe("SESSION_UNITS_UNREADABLE");
    // La intención no era de este intento: sigue en pie para que el próximo la complete.
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(marked);
  });

  it("una corrida parada en su propio finalize lo aplica, sin reentrada", async () => {
    await runStandingOn("chassis.finalize");
    const result = await close();
    expect(result.data).toMatchObject({
      run: { closed_at: "chassis.finalize", finalize: "applied" },
    });
    const state = await run();
    expect(state.reentries).toBeUndefined();
    expect(state.applied.at(-1)).toBe("chassis.finalize");
  });

  it("una corrida entregada a otro flujo no se toca: la sesión cierra como antes", async () => {
    const pkg = { plan: null, observations: [], decisions: {}, selection: "Volver a plan-refine" };
    const handoff = {
      destination: "plan-refine" as const,
      command: "/w:plan-refine",
      package: pkg,
      package_digest: semanticDigest(pkg),
    };
    const before = await runStandingOn(AMBIGUITY, { handoff });
    const result = await close();
    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty("run");
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(before);
  });

  it("una corrida legacy terminada cierra como antes; una que sigue se niega con su remedio", async () => {
    const legacy = (applied: string[], boundary: string | null) =>
      serializeRunState(stateWrittenAt(10, "spec-refine", SESSION, applied, boundary));
    const statePath = locateRun(paths, SESSION).statePath;
    await writeFile(statePath, legacy(IDS.slice(0, 5), IDS[5] ?? null), "utf8");
    const walking = await close();
    expect(walking.error?.code).toBe("FLOW_RUN_LEGACY_ADOPTION_REQUIRED");
    expect(closed()).toBe(false);

    await writeFile(statePath, legacy(IDS, null), "utf8");
    const done = await close();
    expect(done.ok).toBe(true);
    expect(done.data).not.toHaveProperty("run");
    expect(closed()).toBe(true);
  });

  it("plan-exec cerrado en una inferencia sin trabajo termina en su finalize", async () => {
    const ids = journeyOfFlow("plan-exec").map((decision) => decision.id);
    const at = ids.indexOf("plan-exec.batch-inference");
    const state = stateWrittenAt(
      FLOW_RUN_STATE_VERSION,
      "plan-exec",
      SESSION,
      ids.slice(0, at),
      "plan-exec.batch-inference",
      { batches: [], batch_loop: { pending: false, iteration: null } },
    );
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    const result = await close();
    expect(result.data).toMatchObject({
      run: { closed_at: "plan-exec.batch-inference", finalize: "applied" },
    });
    const after = await run();
    expect(after.applied.at(-1)).toBe("chassis.finalize");
    expect(resolveBoundary(after, journeyForRun(after)).stopped).toBeNull();
  });
});

describe("aw session-resume --reopen reabre también la corrida", () => {
  const CONFIRMATION = "spec-refine.save-confirmation";
  // What made the run stand on the ambiguity in the first place: without it the
  // conditional row is passed over, reopened or not.
  const observations = [
    { transition: "spec-refine.gap-recognition", signals: ["spec.functional-ambiguity"] },
  ];
  const answered = (transition: string) => ({
    invocation_id: `sello-${transition}`,
    attempt: 1,
    request_digest: `respuesta-${transition}`,
    parent_request_digest: null,
    transition,
  });

  async function reopen() {
    const result = await runSessionResume(fs, ctx.env, paths, { code: "051", reopen: true });
    if (!("folder" in result)) throw new Error(JSON.stringify(result));
    return result;
  }

  async function advance() {
    const advanced = await advanceFlow(fs, paths, { code: "051" });
    if (!advanced.ok) throw new Error(JSON.stringify(advanced));
    return advanced.directive;
  }

  it("cerrar a mano a mitad del recorrido y retomar: vuelve a la frontera del cierre", async () => {
    await runStandingOn(AMBIGUITY, { observations });
    expect((await close()).ok).toBe(true);

    const reopened = await reopen();
    expect(reopened.state).toBe("active");
    expect(reopened.run).toEqual({ resumes_at: AMBIGUITY });
    const directive = await advance();
    expect(directive.boundary.transition).toBe(AMBIGUITY);
    // La corrida registra las dos reentradas: el cierre y la reapertura.
    const state = await run();
    expect(state.reentries?.map((reentry) => reentry.kind)).toEqual(["close", "reopen"]);
  });

  it("una corrida terminada retoma en su última frontera humana respondida", async () => {
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null, {
      attempts: [answered(AMBIGUITY), answered(CONFIRMATION)],
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");

    expect((await reopen()).run).toEqual({ resumes_at: CONFIRMATION });
    const directive = await advance();
    expect(directive.boundary.transition).toBe(CONFIRMATION);
    expect(directive.next_action).not.toContain("recorrido terminado");
  });

  it("si la última humana del cursor quedó omitida, retoma en la anterior", async () => {
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null, {
      attempts: [answered(AMBIGUITY)],
      skipped: [CONFIRMATION],
      observations,
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");

    expect((await reopen()).run).toEqual({ resumes_at: AMBIGUITY });
    expect((await advance()).boundary.transition).toBe(AMBIGUITY);
  });

  it("en el tramo reabierto se responde como en cualquier frontera", async () => {
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null, {
      attempts: [answered(CONFIRMATION)],
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    await reopen();
    const directive = await advance();
    const submitted = await submitFlow(fs, paths, {
      code: "051",
      raw: JSON.stringify({ input_digest: directive.state_digest, choice: "Refinar" }),
    });
    if (!submitted.ok) throw new Error(JSON.stringify(submitted));
    expect(submitted.directive.error).toBeNull();
    expect(submitted.directive.boundary.transition).toBe("spec-refine.content-authoring");
  });

  it("un cierre que nunca se asentó se retira al reabrir, y retoma donde estaba", async () => {
    await runStandingOn(AMBIGUITY, { observations });
    expect((await markCloseAtBoundary(fs, locateRun(paths, SESSION))).kind).toBe("marked");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    expect((await reopen()).run).toEqual({ resumes_at: AMBIGUITY });
    expect((await run()).reentries).toBeUndefined();
    expect((await advance()).boundary.transition).toBe(AMBIGUITY);
  });

  it("una humana degradada no cuenta: retoma en la anterior", async () => {
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null, {
      attempts: [answered(AMBIGUITY), answered(CONFIRMATION)],
      skipped: [CONFIRMATION],
      degraded: [{ transition: CONFIRMATION, cause: "nadie la resolvió" }],
      observations,
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    expect((await reopen()).run).toEqual({ resumes_at: AMBIGUITY });
  });

  it("sin intentos que la nombren, decide la regla por id", async () => {
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null);
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    expect((await reopen()).run).toEqual({ resumes_at: "chassis.commit-choice" });
  });

  it("sin ninguna humana aplicada se niega y conserva la sesión cerrada", async () => {
    const humans = journeyOfFlow("spec-refine")
      .filter((decision) => decision.authority === "human")
      .map((decision) => decision.id);
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "spec-refine", SESSION, IDS, null, {
      skipped: humans,
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    const reopened = await runSessionResume(fs, ctx.env, paths, { code: "051", reopen: true });
    expect(reopened).toMatchObject({ code: "FLOW_REOPEN_NO_HUMAN" });
    expect(closed()).toBe(true);
  });

  it("una corrida legacy terminada no se puede reabrir: lo dice con su remedio", async () => {
    const legacy = stateWrittenAt(10, "spec-refine", SESSION, IDS, null);
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(legacy), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    const reopened = await runSessionResume(fs, ctx.env, paths, { code: "051", reopen: true });
    expect(reopened).toMatchObject({ code: "FLOW_RUN_LEGACY_ADOPTION_REQUIRED" });
    expect(closed()).toBe(true);
  });

  it("con el candado de corrida ocupado falla, conserva sesión y corrida, y permite reintentar", async () => {
    await runStandingOn(AMBIGUITY, { observations });
    expect((await close()).ok).toBe(true);
    const statePath = locateRun(paths, SESSION).statePath;
    const before = await readFile(statePath, "utf8");
    const lockPath = locateRun(paths, SESSION).lockPath;
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));

    const failed = await sessionResumeCommand.execute(
      parseArgv(["session-resume", "--code", "051", "--reopen"]),
      ctx,
    );
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.error?.code).toBe("FLOW_RUN_LOCKED");
    expect(closed()).toBe(true);
    expect(await readFile(statePath, "utf8")).toBe(before);

    await rm(lockPath);
    expect((await reopen()).run).toEqual({ resumes_at: AMBIGUITY });
    expect((await advance()).boundary.transition).toBe(AMBIGUITY);
  });

  it("si la escritura de la corrida lanza una excepción, restaura .closed y falla", async () => {
    await runStandingOn(AMBIGUITY, { observations });
    expect((await close()).ok).toBe(true);
    const statePath = locateRun(paths, SESSION).statePath;
    const before = await readFile(statePath, "utf8");
    class RunWriteFailureFs extends NodeFileSystem {
      override async writeText(path: string, content: string): Promise<void> {
        if (path === statePath) throw new Error("falló la escritura de corrida");
        return super.writeText(path, content);
      }
    }
    const failed = await sessionResumeCommand.execute(
      parseArgv(["session-resume", "--code", "051", "--reopen"]),
      { ...ctx, fs: new RunWriteFailureFs() },
    );
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.error?.message).toContain("falló la escritura de corrida");
    expect(closed()).toBe(true);
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("si falla también restaurar .closed, devuelve ambos errores y exit no cero", async () => {
    await runStandingOn(AMBIGUITY, { observations });
    expect((await close()).ok).toBe(true);
    await writeFile(
      locateRun(paths, SESSION).lockPath,
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    const marker = join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER);
    class RestoreFailureFs extends NodeFileSystem {
      override async writeText(path: string, content: string): Promise<void> {
        if (path === marker) throw new Error("disco sin espacio al restaurar");
        return super.writeText(path, content);
      }
    }
    const failed = await sessionResumeCommand.execute(
      parseArgv(["session-resume", "--code", "051", "--reopen"]),
      { ...ctx, fs: new RestoreFailureFs() },
    );
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.error?.message).toContain("FLOW_RUN_LOCKED");
    expect(failed.error?.message).toContain("disco sin espacio al restaurar");
    expect(failed.data).toMatchObject({
      run_error: { code: "FLOW_RUN_LOCKED" },
      restore_error: expect.stringContaining("disco sin espacio al restaurar"),
    });
  });

  it("plan-exec terminado retoma en el gate de commit del workspace", async () => {
    const fresh = stateWrittenAt(FLOW_RUN_STATE_VERSION, "plan-exec", SESSION, [], null, {
      batch_loop: { pending: false, iteration: null },
    });
    const walked = journeyForRun(fresh).map((decision) => decision.id);
    const human = walked.filter(
      (id) => journeyOfFlow("plan-exec").find((row) => row.id === id)?.authority === "human",
    );
    const lastHuman = human.at(-1) ?? "";
    const state = stateWrittenAt(FLOW_RUN_STATE_VERSION, "plan-exec", SESSION, walked, null, {
      batch_loop: { pending: false, iteration: null },
      attempts: [answered(lastHuman)],
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state), "utf8");
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    expect((await reopen()).run).toEqual({ resumes_at: lastHuman });
    expect(lastHuman).toBe("chassis.commit-choice");
  });

  it("una corrida que sigue caminando no se toca al reabrir", async () => {
    const before = await runStandingOn(AMBIGUITY);
    await writeFile(join(paths.cwdSessionsDir(), SESSION, CLOSED_MARKER), "", "utf8");
    const reopened = await reopen();
    expect(reopened.run).toBeUndefined();
    expect(await readFile(locateRun(paths, SESSION).statePath, "utf8")).toBe(before);
  });
});
