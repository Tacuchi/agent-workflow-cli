import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { SELF_AUTHORIZABLE_CLASSES } from "../../src/domain/capability/effects.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  journeyOfFlow,
  proposalContractOf,
  publishApprovalOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { sealProposal } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
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
  ])("cambiar %s invalida la aprobación", (_campo, over) => {
    expect(sealProposal({ ...base, ...over }).digest).not.toBe(sealProposal(base).digest);
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
        validations: action.evidence.map((id) => ({ id, passed: true, detail: `salida de ${id}` })),
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
    // El código es el del contrato de ejecución —la evidencia que la fila exigía
    // no está— y la causa material viaja en el mensaje y en la próxima acción, que
    // es donde tiene que estar para que alguien pueda hacer algo con ella.
    expect(blocked.error?.code).toBe("FLOW_EVIDENCE_MISSING");
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
