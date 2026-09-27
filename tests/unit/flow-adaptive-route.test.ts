import { describe, expect, it } from "vitest";
import { advanceFlowRun } from "../../src/application/flow/advance.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { FLOW_DECISIONS, routeControlOf } from "../../src/domain/flow/authority.js";
import {
  ROUTE_ACCEPT_LABEL,
  ROUTE_ADJUST_LABEL,
  assuranceForRoute,
} from "../../src/domain/flow/route.js";
import {
  applyTransition,
  newRunState,
  parseRunState,
  serializeRunState,
  withBoundary,
  withRouteDecisions,
  withRouteProposal,
} from "../../src/domain/flow/run-state.js";

const routeGate: FlowDecision = {
  id: "fixture.route",
  scope: "quick",
  title: "proponer ruta",
  authority: "agent",
  ownership: "cli-owned",
  document: "loops/CHASSIS.md",
  route_evaluation: true,
};

const validation: FlowDecision = {
  id: "fixture.validation",
  scope: "quick",
  title: "ejecutar la validación",
  authority: "cli",
  ownership: "cli-owned",
  document: "loops/quick-loop/LOOP.md",
  route_control: {
    recommendation: "apply",
    consequences: {
      apply: "corre la prueba",
      omit: "omite la prueba con riesgo aceptado",
      substitute: "declara otra validación",
    },
    risk: "la evidencia puede faltar",
  },
};

const hardGate: FlowDecision = {
  id: "fixture.hard",
  scope: "quick",
  title: "autorizar un efecto",
  authority: "human",
  ownership: "cli-owned",
  document: "loops/CODE-POLICIES.md",
};

const proposal = {
  summary: {
    finding: "la página no necesita infraestructura adicional",
    diagnosis:
      "agregar un framework o una suite nueva ampliaría el trabajo sin mejorar el resultado",
    solution:
      "resolverla con HTML, CSS y JavaScript y validar el resultado con un smoke proporcional",
  },
  basis: {
    intention: "una página estática sin dependencias",
    checkout: "checkout limpio y aislado",
    conventions: "sin framework",
    adopted_decisions: "HTML, CSS y JavaScript puros",
  },
  controls: [
    {
      transition: validation.id,
      title: validation.title,
      disposition: "omit" as const,
      recommendation: "apply" as const,
      alternatives: validation.route_control.consequences,
      consequence: validation.route_control.consequences.omit,
      risk: validation.route_control.risk,
      reason: "la persona aceptó no crear pruebas nuevas",
      substitution: null,
    },
  ],
};

describe("ruta adaptativa", () => {
  it("sella una propuesta, pide aceptación humana y ajustar no mueve el cursor", () => {
    expect(ROUTE_ACCEPT_LABEL).toBe("Aceptar propuesta");
    expect(ROUTE_ADJUST_LABEL).toBe("Pedir ajustes");
    const journey = [routeGate, validation, hardGate];
    const initial = advanceFlowRun({ state: newRunState("quick", "001-ruta-quick"), journey });
    if (!initial.ok) throw new Error(initial.failure.code);
    expect(initial.directive.boundary.kind).toBe("semantic");
    expect(initial.directive.request?.contract).toContain(
      "summary { finding, diagnosis, solution }",
    );

    const review = advanceFlowRun({ state: withRouteProposal(initial.state, proposal), journey });
    if (!review.ok) throw new Error(review.failure.code);
    expect(review.directive.boundary.kind).toBe("human");
    expect(review.directive.choices.map((choice) => choice.label)).toContain(ROUTE_ACCEPT_LABEL);
    expect(review.directive.choices.map((choice) => choice.label)).toContain(ROUTE_ADJUST_LABEL);

    const adjusted = advanceFlowRun({ state: withRouteProposal(review.state, null), journey });
    if (!adjusted.ok) throw new Error(adjusted.failure.code);
    expect(adjusted.state.applied).toEqual([]);
    expect(adjusted.directive.boundary.kind).toBe("semantic");
  });

  it("omite sólo el control registrado y nunca convierte su falta de evidencia en verde", () => {
    const journey = [routeGate, validation, hardGate];
    const seeded = withRouteProposal(newRunState("quick", "001-ruta-quick"), proposal);
    const accepted = withRouteDecisions(seeded, proposal.controls);
    const atValidation = withBoundary(applyTransition(accepted, routeGate.id), validation.id);
    const advanced = advanceFlowRun({ state: atValidation, journey });
    if (!advanced.ok) throw new Error(advanced.failure.code);
    expect(advanced.state.skipped).toEqual([validation.id]);
    expect(advanced.directive.boundary.transition).toBe(hardGate.id);
    expect(advanced.directive.route.assurance).toBe("unverified_accepted");
    expect(routeControlOf(hardGate)).toBeNull();
  });

  it("exige que una sustitución cruce su control antes de acreditarla", () => {
    const substitute = {
      ...proposal,
      controls: [
        {
          ...proposal.controls[0],
          disposition: "substitute" as const,
          consequence: validation.route_control.consequences.substitute,
          substitution: { validation: "smoke de navegador", risk: "cobertura parcial" },
        },
      ],
    };
    const accepted = withRouteDecisions(
      withRouteProposal(newRunState("quick", "001-ruta-quick"), substitute),
      substitute.controls,
    );
    expect(accepted.assurance).toBe("partially_verified");

    const completed = applyTransition(accepted, validation.id);
    expect(completed.assurance).toBe("verified");
  });

  it("mantiene los estados v10 legibles para adopción y deriva assurance conservador", () => {
    const current = newRunState("quick", "001-ruta-quick");
    const {
      route_proposal: _proposal,
      route_decisions: _decisions,
      assurance: _assurance,
      digest: _digest,
      ...v10
    } = current;
    const unsigned = { ...v10, version: 10 };
    const legacy = { ...unsigned, digest: semanticDigest(unsigned) };
    const parsed = parseRunState(JSON.stringify(legacy));
    if (!parsed.ok) throw new Error(parsed.failure.code);
    expect(parsed.state.version).toBe(10);
    expect(
      assuranceForRoute([
        {
          transition: validation.id,
          disposition: "substitute",
          substitution: { validation: "smoke", risk: "cobertura parcial" },
        },
      ]),
    ).toBe("partially_verified");
  });

  it("mantiene legible una propuesta v11 en vuelo anterior al resumen explícito", () => {
    const { summary: _summary, ...previousProposal } = proposal;
    const state = withRouteProposal(newRunState("quick", "001-ruta-quick"), previousProposal);
    const parsed = parseRunState(serializeRunState(state));
    if (!parsed.ok) throw new Error(parsed.failure.code);
    expect(parsed.state.route_proposal?.summary).toBeUndefined();
  });
});

/**
 * La validación de fase de plan-exec no se omite (plan 049, F2 · spec 052 AC-01).
 *
 * Omitirla acreditaría un lote sin ninguna prueba de su checkout. Tiene su propio
 * control, sin `omit`; las otras dos filas que comparten el control de validación
 * lo conservan tal cual.
 */
describe("ruta adaptativa — la validación de fase de plan-exec", () => {
  const byId = (id: string): FlowDecision => {
    const row = FLOW_DECISIONS.find((decision) => decision.id === id);
    if (row === undefined) throw new Error(`el registro no tiene ${id}`);
    return row;
  };
  const phase = byId("plan-exec.validation-execution");

  it("su control no ofrece omitirla, y las otras dos filas de validación siguen igual", () => {
    expect(routeControlOf(phase)?.consequences.omit).toBeUndefined();
    expect(routeControlOf(phase)?.consequences.apply).toBeDefined();
    expect(routeControlOf(phase)?.consequences.substitute).toBeDefined();
    for (const id of ["plan-refine.executability-gate", "plan-exec.final-validation"]) {
      expect(routeControlOf(byId(id))?.consequences.omit, id).toBeDefined();
    }
  });

  it("una propuesta con su control sin `omit` se persiste y se sigue leyendo", () => {
    const journey = [routeGate, phase];
    const initial = advanceFlowRun({
      state: newRunState("plan-exec", "001-ruta-plan-exec"),
      journey,
    });
    if (!initial.ok) throw new Error(initial.failure.code);
    const control = routeControlOf(phase);
    const withProposal = withRouteProposal(initial.state, {
      ...proposal,
      controls: [
        {
          ...proposal.controls[0],
          transition: phase.id,
          title: phase.title,
          disposition: "apply" as const,
          alternatives: control?.consequences ?? { apply: "", substitute: "" },
          consequence: control?.consequences.apply ?? "",
          risk: control?.risk ?? "",
        },
      ],
    });
    expect(parseRunState(serializeRunState(withProposal)).ok).toBe(true);
  });

  it("una omisión ya aceptada en una corrida en curso deja de saltarla, con traza", () => {
    const journey = [routeGate, phase, hardGate];
    const seeded = newRunState("plan-exec", "001-ruta-plan-exec");
    const accepted = withRouteDecisions(seeded, [
      { transition: phase.id, disposition: "omit", substitution: null },
    ]);
    const atValidation = withBoundary(applyTransition(accepted, routeGate.id), phase.id);
    const advanced = advanceFlowRun({ state: atValidation, journey });
    if (!advanced.ok) throw new Error(advanced.failure.code);
    expect(advanced.state.skipped).not.toContain(phase.id);
    expect(advanced.directive.boundary.transition).toBe(phase.id);
    const refused = advanced.state.events.filter((event) => event.kind === "route-refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ transition: phase.id, disposition: "omit" });
    // La validación se va a correr: la ruta ya no la declara omitida.
    expect(advanced.state.route_decisions).toEqual([
      { transition: phase.id, disposition: "apply", substitution: null },
    ]);
    expect(advanced.state.assurance).toBe("verified");
    // Volver a avanzar sobre la misma frontera no repite la traza.
    const again = advanceFlowRun({ state: advanced.state, journey });
    if (!again.ok) throw new Error(again.failure.code);
    expect(again.state.events.filter((event) => event.kind === "route-refused")).toHaveLength(1);
    expect(parseRunState(serializeRunState(again.state)).ok).toBe(true);
  });
});
