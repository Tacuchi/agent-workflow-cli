import { describe, expect, it } from "vitest";
import { advanceFlowRun } from "../../src/application/flow/advance.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { routeControlOf } from "../../src/domain/flow/authority.js";
import {
  ROUTE_ACCEPT_LABEL,
  ROUTE_ADJUST_LABEL,
  assuranceForRoute,
} from "../../src/domain/flow/route.js";
import {
  applyTransition,
  newRunState,
  parseRunState,
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
    const journey = [routeGate, validation, hardGate];
    const initial = advanceFlowRun({ state: newRunState("quick", "001-ruta-quick"), journey });
    if (!initial.ok) throw new Error(initial.failure.code);
    expect(initial.directive.boundary.kind).toBe("semantic");

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
});
