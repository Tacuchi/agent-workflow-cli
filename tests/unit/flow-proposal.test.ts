import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorklineFlow } from "../../src/application/capability/compose.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../src/application/flow/internal-actions.js";
import { journeyForRun } from "../../src/application/flow/run-journey.js";
import {
  applyUnderLock,
  locateRun,
  readRun,
} from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { CLOSED_MARKER } from "../../src/application/session-resolver.js";
import { SELF_AUTHORIZABLE_CLASSES } from "../../src/domain/capability/effects.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  effectsOf,
  journeyOfFlow,
  proposalContractOf,
  publishApprovalOf,
  reentryOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { attemptAccountingAt, withProposal } from "../../src/domain/flow/run-state.js";
import { sealProposal } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { acceptAdaptiveRoute } from "../helpers/accept-adaptive-route.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Una propuesta local exacta: una vista previa, una pregunta, una escritura.
 *
 * Lo que estas pruebas fijan no es que el guardado funcione, sino DÓNDE está la
 * línea. El sello cubre bytes, destinos, base, alcance y clases de efecto, así que
 * un reintento idéntico no vuelve a preguntar y cualquier cambio material sí. El
 * grant se otorga sobre ese sello y sobre ningún otro, así que aprobar una
 * escritura no compra la siguiente. Y la publicación es todo-o-nada, con una
 * reentrada que reconoce lo ya aplicado en vez de reportarlo como conflicto.
 */

const SESSION = "031-propuesta-spec-refine";
const CODE = "031";
const SPEC = "docs/specs/031-spec-propuesta.md";
const BYTES = "---\nstatus: ready-for-plan\n---\n\n# Spec 031\n";
const fs = new NodeFileSystem();
const JOURNEY = journeyOfFlow("spec-refine");

describe("el sello de una propuesta cubre todo lo que la vuelve otra propuesta", () => {
  const base = {
    operation: "flow.spec-refine.save-proposal",
    artifacts: [{ path: SPEC, content: BYTES, overwrite: false }],
    effects: ["local_additive" as const],
    requiresApproval: [],
  };

  it("lo idéntico sella igual: eso es lo que permite reintentar sin preguntar", () => {
    expect(sealProposal(base).digest).toBe(sealProposal(base).digest);
    // Y el orden de enumeración no es contenido: el sello describe el CONJUNTO.
    const two = {
      ...base,
      artifacts: [...base.artifacts, { path: "docs/specs/b.md", content: "b", overwrite: false }],
    };
    const flipped = { ...two, artifacts: [...two.artifacts].reverse() };
    expect(sealProposal(two).digest).toBe(sealProposal(flipped).digest);
  });

  it.each([
    [
      "contenido",
      { artifacts: [{ path: SPEC, content: `${BYTES}otra línea\n`, overwrite: false }] },
    ],
    ["destino", { artifacts: [{ path: "docs/specs/otra.md", content: BYTES, overwrite: false }] }],
    ["reemplazo", { artifacts: [{ path: SPEC, content: BYTES, overwrite: true }] }],
    ["base", { bases: [{ path: SPEC, digest: "otra-revisión" }] }],
    ["alcance", { scope: { sensitive_sources: true, scope_expanded: false } }],
    ["ampliación", { scope: { sensitive_sources: false, scope_expanded: true } }],
    ["clase de efecto", { effects: ["local_additive" as const, "mutate_overwrite" as const] }],
    ["lo que exige aprobación", { requiresApproval: ["mutate_overwrite" as const] }],
    [
      "la reserva propia",
      { artifacts: [{ path: SPEC, content: BYTES, overwrite: false, reserved: true as const }] },
    ],
  ])("cambiar %s invalida la aprobación", (_campo, over) => {
    expect(sealProposal({ ...base, ...over }).digest).not.toBe(sealProposal(base).digest);
  });

  it("una propuesta sin reserva sella lo mismo que antes de existir la marca", () => {
    // La forma del sello antes del campo `reserved`, calculada acá a mano: una
    // propuesta en vuelo sellada con esa forma sigue valiendo.
    const legacy = semanticDigest({
      operation: base.operation,
      artifacts: [{ path: SPEC, content_digest: semanticDigest(BYTES), overwrite: false }],
      bases: [],
      scope: { sensitive_sources: false, scope_expanded: false },
      effects: ["local_additive"],
      requires_approval: [],
    });
    expect(sealProposal(base).digest).toBe(legacy);
    expect(sealProposal(base).preview).toEqual([
      { path: SPEC, bytes: Buffer.byteLength(BYTES, "utf8"), overwrite: false },
    ]);
  });
});

describe("una propuesta se aprueba una vez y se publica entera", () => {
  let workdir: string;
  let paths: PathsService;
  let executor: InternalActionExecutor;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-propuesta-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — propuesta\n\n## Objective\nguardar una spec\n",
      "utf8",
    );
    executor = internalActionExecutor({
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
      git: new RecordingGit(),
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return { state: read.state, resolved: resolveBoundary(read.state, JOURNEY) };
  }

  async function answer(body: unknown, approval: string | null = null): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify(body),
      approval,
      executor,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  }

  /** Lo que cada frontera admite, con los bytes donde el contrato los pide. */
  function bodyFor(
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
    content: string,
  ): Record<string, unknown> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") {
      const action = resolved.action;
      if (action === null) throw new Error("una frontera de ejecución sin invocación");
      const declared = resolved.proposal?.effects ?? ["read_only"];
      return {
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: action.invocation,
        validations: action.evidence.map((id) => ({
          id,
          passed: true,
          detail: `salida de ${id}`,
          ...(id === "workline.source-bounded"
            ? {
                proof: {
                  kind: "inspection" as const,
                  source: "workspace",
                  relative_cwd: ".",
                  checkout_digest: "test-checkout",
                  invocation: { artifact: "tests/unit/flow-proposal.test.ts" },
                },
              }
            : {}),
        })),
        effects: { planned: [...declared], approved: [], applied: [...declared] },
        output: null,
      };
    }
    if (resolved.kind === "semantic") {
      const proposes = proposalContractOf(stopped);
      if (proposes !== null) {
        return { input_digest: resolved.seal, artifacts: [{ path: SPEC, content }] };
      }
      return { input_digest: resolved.seal, signals: [], decisions: { paso: stopped.id } };
    }
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }

  /** Contesta la frontera vigente, con su aprobación cuando la pide. */
  async function answerBoundary(
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
    content: string,
  ): Promise<void> {
    if (resolved.kind !== "authorization") {
      await answer(bodyFor(resolved, content));
      return;
    }
    const stopped = resolved.stopped as FlowDecision;
    await answer(
      { input_digest: resolved.seal, choice: "Autorizar el efecto" },
      effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? []),
    );
  }

  /** Avanza hasta la confirmación del guardado, con el ejecutor interno corriendo. */
  async function walkToConfirmation(content = BYTES): Promise<void> {
    const adopted = await advanceFlow(fs, paths, {
      code: CODE,
      flow: "spec-refine",
      adopt: true,
      executor,
    });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    await acceptAdaptiveRoute(fs, paths, SESSION, { executor });
    for (let step = 0; step < 30; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped === null) throw new Error("el recorrido terminó sin pedir confirmación");
      if (publishApprovalOf(resolved.stopped) !== null && resolved.proposal !== null) return;
      await answerBoundary(resolved, content);
    }
    throw new Error("el recorrido nunca llegó a la confirmación");
  }

  it("aprobar escribe los bytes exactos, y el CLI lo hace sin devolver trabajo", async () => {
    await walkToConfirmation();
    const gate = await current();
    expect(gate.resolved.proposal?.preview).toEqual([
      { path: SPEC, bytes: Buffer.byteLength(BYTES, "utf8"), overwrite: false },
    ]);

    const published = await answer({
      input_digest: gate.resolved.seal,
      choice: "Aprobar y guardar",
    });
    // Con ejecutor interno la publicación corre en la MISMA invocación: la persona
    // contestó una vez y el archivo está.
    expect(published.error).toBeNull();
    expect(await readFile(join(workdir, SPEC), "utf8")).toBe(BYTES);
    // Y no quedó ninguna acción pendiente que alguien tenga que correr.
    expect(published.boundary.transition).not.toBe("spec-refine.publication");
  });

  it("una base que se movió detiene la publicación con causa, sin escribir a medias", async () => {
    // La spec ya existe: la propuesta la reemplaza, así que sella su base.
    await mkdir(join(workdir, "docs/specs"), { recursive: true });
    await writeFile(join(workdir, SPEC), "# original\n", "utf8");
    await walkToConfirmation();
    const gate = await current();
    expect(gate.resolved.proposal?.preview[0]?.overwrite).toBe(true);
    expect(gate.resolved.proposal?.effects).toContain("mutate_overwrite");

    // Alguien más edita el documento entre la vista previa y la aprobación.
    await writeFile(join(workdir, SPEC), "# lo cambió otra persona\n", "utf8");
    const blocked = await answer({
      input_digest: gate.resolved.seal,
      choice: "Aprobar y guardar",
    });
    // El rechazo es de la operación interna, no de una evidencia que alguien tenga
    // que devolver: la causa material viaja en el mensaje y la recuperación de la
    // fila en la próxima acción, que es donde alguien puede hacer algo con ellas.
    expect(blocked.error?.code).toBe("FLOW_INTERNAL_ACTION_REFUSED");
    expect(blocked.error?.message).toContain("cambió después de preparar la propuesta");
    expect(blocked.next_action).toContain("volvé a preparar");
    // Nada se pisó: lo que hay en disco sigue siendo lo del tercero.
    expect(await readFile(join(workdir, SPEC), "utf8")).toBe("# lo cambió otra persona\n");
  });

  it("reintentar lo idéntico conserva la aprobación y reconoce lo ya aplicado", async () => {
    await walkToConfirmation();
    const gate = await current();
    const sealed = gate.resolved.proposal?.digest;
    await answer({ input_digest: gate.resolved.seal, choice: "Aprobar y guardar" });
    expect(existsSync(join(workdir, SPEC))).toBe(true);

    // El grant quedó sobre ese sello exacto, y sobre ninguna otra cosa.
    const after = await current();
    const grants = after.state.authorizations;
    expect(grants.map((grant) => grant.digest)).toEqual([sealed]);
    expect(grants[0]?.destinations).toEqual([SPEC]);
  });

  it("un efecto especial conserva su propia frontera: el grant de la propuesta no lo cubre", () => {
    // La propuesta sella `local_additive`/`mutate_overwrite` y nada más. Ejecutar,
    // salir de la máquina o destruir no viajan en ninguna vista previa, así que
    // ningún grant sobre bytes puede alcanzarlos.
    const proposal = sealProposal({
      operation: "flow.x",
      artifacts: [{ path: SPEC, content: BYTES, overwrite: false }],
      effects: ["local_additive"],
      requiresApproval: [],
    });
    for (const special of ["execute", "network_external", "destructive"] as const) {
      expect(proposal.effects).not.toContain(special);
      expect(SELF_AUTHORIZABLE_CLASSES).not.toContain(special);
    }
  });
});

describe("los tres guardados hablan el mismo contrato", () => {
  it("spec, plan y plan refinado ofrecen las mismas dos alternativas y la misma decisión", () => {
    const rows = FLOW_DECISIONS.filter((row) => publishApprovalOf(row) !== null);
    expect(rows.map((row) => row.id)).toEqual([
      "spec-refine.save-confirmation",
      "plan-new.save-confirmation",
      "plan-refine.save-confirmation",
    ]);
    for (const row of rows) {
      // Mismas etiquetas, en el mismo orden, con la misma recomendada: un host
      // puede presentarlas como quiera, pero la decisión que ve la persona es una
      // sola y es la misma en los tres.
      expect(
        row.alternatives?.map((choice) => choice.label),
        row.id,
      ).toEqual(["Aprobar y guardar", "Refinar"]);
      expect(row.alternatives?.[0]?.recommended, row.id).toBe(true);
      expect(publishApprovalOf(row), row.id).toBe("Aprobar y guardar");
      // Y `Refinar` vuelve a una fila de redacción que su recorrido tiene antes.
      const redraft = reentryOf(row);
      const ids = journeyOfFlow(row.scope as WorklineFlow).map((decision) => decision.id);
      expect(redraft?.label, row.id).toBe("Refinar");
      expect(ids.indexOf(redraft?.from ?? ""), row.id).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(redraft?.from ?? ""), row.id).toBeLessThan(ids.indexOf(row.id));
    }
  });

  it("cada autoría declara sus destinos, sus efectos y su límite: nada implícito", () => {
    const authoring = FLOW_DECISIONS.filter((row) => proposalContractOf(row) !== null);
    expect(authoring.map((row) => row.id)).toEqual([
      "spec-refine.save-proposal",
      "plan-new.save-proposal",
      "plan-refine.save-proposal",
    ]);
    for (const row of authoring) {
      const contract = proposalContractOf(row);
      expect(contract?.destinations.length, row.id).toBeGreaterThan(0);
      expect(contract?.effects.length, row.id).toBeGreaterThan(0);
      expect(contract?.limits.maxArtifacts, row.id).toBeGreaterThan(0);
      expect(contract?.limits.maxArtifactBytes, row.id).toBeGreaterThan(0);
      // Autoría es del agente; aprobar es de la persona; escribir es del CLI.
      expect(row.authority, row.id).toBe("agent");
    }
  });
});

describe("Refinar vuelve a la redacción en los tres flujos que lo ofrecen", () => {
  /**
   * AC-12 de la spec 052. `Refinar` descarta la propuesta sin escribir y deja la
   * corrida y la sesión abiertas: la siguiente `advance` para en la frontera de
   * redacción del flujo, el gate vuelve a correr sobre los bytes nuevos con sus
   * propios intentos, y lo aprobado en la segunda confirmación es lo publicado.
   */
  const PLAN_V = (version: string) =>
    [
      `# Plan 041 — refinado ${version}`,
      "",
      "> Standalone: prueba de Refinar",
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — algo",
      "> Fuentes: workspace",
      "",
      "- [ ] T1.1 — hacer algo _(fuentes: workspace)_",
      "",
      "**Validación de fase:** `npm test` pasa.",
      "**Condición de salida:** hecho.",
      "",
      "## Execution batches",
      "",
      "- B1 · isolated · F1",
      "",
      "## Validations",
      "",
      "- `npm test` pasa.",
      "",
    ].join("\n");
  const CASES = [
    {
      flow: "spec-refine",
      authoring: "spec-refine.content-authoring",
      gate: "spec-refine.ready-gate",
      doc: "docs/specs/041-spec-refinada.md",
      bytes: (version: string) => `---\nstatus: ready-for-plan\n---\n\n# Spec 041 — ${version}\n`,
    },
    {
      flow: "plan-new",
      authoring: "plan-new.phase-shaping",
      gate: "plan-new.coherence-gate",
      doc: "docs/plans/041-plan-refinado.md",
      bytes: PLAN_V,
    },
    {
      flow: "plan-refine",
      authoring: "plan-refine.journey-map",
      gate: "plan-refine.executability-gate",
      doc: "docs/plans/041-plan-refinado.md",
      bytes: PLAN_V,
    },
  ] as const;

  let workdir: string;
  let paths: PathsService;
  let executor: InternalActionExecutor;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-refinar-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    executor = internalActionExecutor({
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
      git: new RecordingGit(),
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  for (const scenario of CASES) {
    const session = `041-refinar-${scenario.flow}`;

    async function current() {
      const read = await readRun(fs, locateRun(paths, session));
      if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
      return {
        state: read.state,
        resolved: resolveBoundary(read.state, journeyForRun(read.state)),
      };
    }

    async function answer(body: unknown, approval: string | null = null): Promise<FlowDirective> {
      const result = await submitFlow(fs, paths, {
        code: "041",
        raw: JSON.stringify(body),
        approval,
        executor,
      });
      if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
      return result.directive;
    }

    function executionBody(
      resolved: Awaited<ReturnType<typeof current>>["resolved"],
      detail = "salida real",
    ): Record<string, unknown> {
      const action = resolved.action;
      if (action === null) throw new Error("una frontera de ejecución sin invocación");
      const declared = resolved.proposal?.effects ?? effectsOf(resolved.stopped as FlowDecision);
      return {
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: action.invocation,
        validations: action.evidence.map((id) => ({
          id,
          passed: true,
          detail,
          ...(id === "workline.source-bounded"
            ? {
                proof: {
                  kind: "inspection" as const,
                  source: "workspace",
                  relative_cwd: ".",
                  checkout_digest: "test-checkout",
                  invocation: { artifact: "tests/unit/flow-proposal.test.ts" },
                },
              }
            : {}),
        })),
        effects: { planned: [...declared], approved: [], applied: [...declared] },
        output: null,
      };
    }

    /** What the boundary in force admits, and the approval it asks for, if any. */
    function bodyFor(
      resolved: Awaited<ReturnType<typeof current>>["resolved"],
      content: string,
    ): { body: Record<string, unknown>; approval: string | null } {
      const stopped = resolved.stopped as FlowDecision;
      const seal = resolved.seal;
      if (resolved.kind === "authorization") {
        const planned = resolved.authorization?.planned ?? [];
        const approval = effectApprovalDigest(stopped.id, planned);
        return { body: { input_digest: seal, choice: "Autorizar el efecto" }, approval };
      }
      if (resolved.kind === "execution") return { body: executionBody(resolved), approval: null };
      if (resolved.kind !== "semantic") {
        return {
          body: { input_digest: seal, choice: resolved.choices[0]?.label ?? "" },
          approval: null,
        };
      }
      const body =
        proposalContractOf(stopped) !== null
          ? { input_digest: seal, artifacts: [{ path: scenario.doc, content }] }
          : { input_digest: seal, signals: [], decisions: { paso: stopped.id } };
      return { body, approval: null };
    }

    /**
     * Contesta hasta la confirmación. En el gate manda antes `refusals` veces la
     * misma evidencia sin salida real: cada vez se evalúa, se rechaza y gasta.
     */
    /** The same evidence without real output: evaluated, refused, and charged. */
    async function refuseAtGate(resolved: Awaited<ReturnType<typeof current>>["resolved"]) {
      const directive = await answer(executionBody(resolved, "  "));
      expect(directive.error?.code, scenario.flow).toBe("FLOW_EVIDENCE_MISSING");
    }

    /** Whether the run stands on the confirmation with a proposal to decide. */
    function atConfirmation(resolved: Awaited<ReturnType<typeof current>>["resolved"]): boolean {
      if (resolved.stopped === null) throw new Error("el recorrido terminó sin confirmación");
      return publishApprovalOf(resolved.stopped) !== null && resolved.proposal !== null;
    }

    /** Answers one boundary; `null` once at the confirmation, else the refusals left. */
    async function answerOne(content: string, pending: number): Promise<number | null> {
      const { resolved } = await current();
      if (atConfirmation(resolved)) return null;
      if (pending > 0 && resolved.stopped?.id === scenario.gate) {
        await refuseAtGate(resolved);
        return pending - 1;
      }
      const { body, approval } = bodyFor(resolved, content);
      await answer(body, approval);
      return pending;
    }

    /** Contesta hasta la confirmación, rechazando antes `refusals` veces en el gate. */
    async function walkToConfirmation(content: string, refusals: number): Promise<void> {
      let pending: number | null = refusals;
      for (let step = 0; step < 40 && pending !== null; step += 1) {
        pending = await answerOne(content, pending);
      }
      if (pending !== null) throw new Error("el recorrido nunca llegó a la confirmación");
    }

    async function adoptRun(): Promise<void> {
      await mkdir(join(paths.cwdSessionsDir(), session), { recursive: true });
      await writeFile(
        join(paths.cwdSessionsDir(), session, "SESSION.md"),
        "# SESSION — refinar\n\n## Objective\nrefinar y guardar\n",
        "utf8",
      );
      const adopted = await advanceFlow(fs, paths, {
        code: "041",
        flow: scenario.flow,
        adopt: true,
        executor,
      });
      if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
      await acceptAdaptiveRoute(fs, paths, session, { executor });
    }

    it(`${scenario.flow}: Refinar no escribe, deja la sesión abierta y vuelve a la redacción`, async () => {
      await adoptRun();
      await walkToConfirmation(scenario.bytes("v1"), 1);
      expect(attemptAccountingAt((await current()).state, scenario.gate).spent).toBe(2);

      const gate = await current();
      const choice = { input_digest: gate.resolved.seal, choice: "Refinar" };
      const refined = await answer(choice);
      expect(refined.error).toBeNull();
      expect(refined.boundary.transition).toBe(scenario.authoring);
      expect(existsSync(join(workdir, scenario.doc))).toBe(false);
      expect(existsSync(join(paths.cwdSessionsDir(), session, CLOSED_MARKER))).toBe(false);
      const after = await current();
      expect(after.state.proposal).toBeNull();
      expect(after.state.authorizations).toEqual([]);
      const reentry = {
        kind: "refine",
        transition: `${scenario.flow}.save-confirmation`,
        occurrence: 1,
        from: scenario.authoring,
      };
      expect(after.state.reentries).toEqual([reentry]);

      // Reenviar la misma elección no registra una segunda reentrada.
      expect((await answer(choice)).error?.code).toBe("FLOW_ANSWER_RESENT");
      expect((await current()).state.reentries).toEqual([reentry]);

      // La siguiente advance vuelve a parar en la redacción, no avanza sola.
      const resumed = await advanceFlow(fs, paths, { code: "041", executor });
      if (!resumed.ok) throw new Error("esperaba retomar la corrida");
      expect(resumed.directive.boundary.transition).toBe(scenario.authoring);

      // En la copia, reintentar la misma evidencia rechazada vuelve a diagnosticarse
      // y a cobrarse: la copia no hereda el «ya se aplicó» de la primera pasada.
      await walkToConfirmation(scenario.bytes("v2"), 2);
      const second = await current();
      expect(attemptAccountingAt(second.state, scenario.gate).spent).toBe(3);
      const published = await answer({
        input_digest: second.resolved.seal,
        choice: "Aprobar y guardar",
      });
      expect(published.error).toBeNull();
      expect(await readFile(join(workdir, scenario.doc), "utf8")).toBe(scenario.bytes("v2"));
    });

    it(`${scenario.flow}: sin propuesta en pie, Refinar también vuelve a la redacción`, async () => {
      await adoptRun();
      await walkToConfirmation(scenario.bytes("v1"), 0);
      // La propuesta que la corrida abandonó: la confirmación sigue en pie sin ella.
      const location = locateRun(paths, session);
      await applyUnderLock(fs, location, (state) =>
        state === null
          ? { ok: false as const, failure: { code: "X", message: "sin corrida", action: "-" } }
          : { ok: true as const, state: withProposal(state, null), value: null },
      );
      const gate = await current();
      expect(gate.resolved.stopped?.id).toBe(`${scenario.flow}.save-confirmation`);
      const refined = await answer({ input_digest: gate.resolved.seal, choice: "Refinar" });
      expect(refined.boundary.transition).toBe(scenario.authoring);
      expect(existsSync(join(paths.cwdSessionsDir(), session, CLOSED_MARKER))).toBe(false);
      expect((await current()).state.reentries).toHaveLength(1);
    });
  }
});
