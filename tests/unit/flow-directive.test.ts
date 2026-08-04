import { describe, expect, it } from "vitest";
import { WORKLINE_FLOWS } from "../../src/application/capability/compose.js";
import {
  type SemanticRequest,
  buildSemanticRequest,
} from "../../src/application/semantic-operation/protocol.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  CAPABILITY_OUTCOMES,
  type CapabilityReceipt,
  type CapabilityRequest,
} from "../../src/domain/capability/protocol.js";
import {
  FLOW_BOUNDARY_KINDS,
  FLOW_DIRECTIVE_KEYS,
  FLOW_DIRECTIVE_REUSED_KEYS,
  type FlowBoundary,
  buildFlowDirective,
  renderDirectiveHuman,
} from "../../src/domain/flow/directive.js";

/**
 * The directive: every combination that would let a run lie is refused, and no
 * field parallel to something the Specs 012 and 014 already deliver ever shows
 * up here.
 */

function boundary(overrides: Partial<FlowBoundary> = {}): FlowBoundary {
  return {
    kind: "semantic",
    transition: "quick.entry-gate-signal",
    authority: "agent",
    // A semantic, human or authorization boundary only exists for a transition
    // this CLI owns: on a `legacy` row the engine returns the `legacy` boundary
    // instead of asking about a step doctrine decides.
    ownership: "cli-owned",
    title: "reconocer cada señal de tamaño en el objetivo recibido",
    document: "loops/quick-loop/LOOP.md",
    ...overrides,
  };
}

function request(): SemanticRequest {
  return buildSemanticRequest({
    operation: "flow.quick.entry-gate-signal",
    inputs: { state: "abc" },
    contract: "devolvé las señales que observás",
    inventory: {},
    allowedDestinations: [],
    limits: { max_artifacts: 0, max_artifact_bytes: 0 },
    readSet: ["loops/quick-loop/LOOP.md"],
    readSetBytes: 0,
  });
}

const BASE = {
  flow: "quick" as const,
  session: "001-prueba-quick",
  stateDigest: "sello",
  applied: [
    {
      transition: "quick.session-create",
      authority: "cli" as const,
      ownership: "cli-owned" as const,
    },
  ],
  pending: ["quick.entry-gate-signal"],
  nextAction: "respondé con 'aw flow submit'",
};

describe("directiva de frontera — la forma válida", () => {
  it("una frontera semántica trae su pedido acotado y su continuación", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary(),
      outcome: "needs_input",
      request: request(),
    });
    if (!built.ok) throw new Error(`esperaba una directiva: ${built.failure.code}`);
    expect(built.directive.tranche).toBe("quick");
    expect(built.directive.boundary.ownership).toBe("cli-owned");
    expect(built.directive.next_action.length).toBeGreaterThan(0);
    expect(Object.keys(built.directive).sort()).toEqual([...FLOW_DIRECTIVE_KEYS].sort());
  });

  it("una finalización declara que no queda trabajo pendiente", () => {
    const built = buildFlowDirective({
      ...BASE,
      pending: [],
      boundary: {
        kind: "final",
        transition: null,
        authority: null,
        ownership: null,
        title: null,
        document: null,
      },
      outcome: "completed",
      nextAction: "no queda trabajo pendiente en este recorrido",
    });
    expect(built.ok).toBe(true);
  });

  it("la proyección humana se deriva de los mismos campos", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary(),
      outcome: "needs_input",
      request: request(),
    });
    if (!built.ok) throw new Error("esperaba una directiva");
    const human = renderDirectiveHuman(built.directive);
    expect(human).toContain("quick.entry-gate-signal");
    expect(human).toContain(built.directive.next_action);
    expect(human).toContain(built.directive.state_digest);
  });

  it("los motivos de frontera son el vocabulario cerrado de la spec", () => {
    expect([...FLOW_BOUNDARY_KINDS]).toEqual([
      "semantic",
      "human",
      "authorization",
      "legacy",
      "blocked",
      "final",
    ]);
  });

  it("una frontera legacy declara el fallback y no ofrece nada que elegir", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary({
        kind: "legacy",
        authority: "cli",
        ownership: "legacy",
        transition: "quick.dedup-check",
        title: "comprobar si ya existe trabajo equivalente",
      }),
      outcome: "needs_input",
      nextAction: "aplicá la regla vigente de loops/quick-loop/LOOP.md",
    });
    if (!built.ok) throw new Error(`esperaba una directiva: ${built.failure.code}`);
    expect(built.directive.boundary.document).toBe("loops/quick-loop/LOOP.md");
    expect(built.directive.choices).toEqual([]);
    expect(built.directive.request).toBeNull();
    expect(renderDirectiveHuman(built.directive)).toContain(
      "fallback declarado: la regla vigente de loops/quick-loop/LOOP.md",
    );
  });
});

describe("directiva de frontera — cada combinación mentirosa se rechaza", () => {
  const cases: Array<[string, Parameters<typeof buildFlowDirective>[0], string]> = [
    [
      "una frontera sin acción siguiente",
      {
        ...BASE,
        boundary: boundary(),
        outcome: "needs_input",
        request: request(),
        nextAction: "  ",
      },
      "FLOW_DIRECTIVE_NO_NEXT_ACTION",
    ],
    [
      "una finalización con trabajo pendiente",
      {
        ...BASE,
        boundary: {
          kind: "final",
          transition: null,
          authority: null,
          ownership: null,
          title: null,
          document: null,
        },
        outcome: "completed",
      },
      "FLOW_DIRECTIVE_FINAL_WITH_PENDING",
    ],
    [
      "una finalización que dice haberse detenido en una transición",
      {
        ...BASE,
        pending: [],
        boundary: {
          kind: "final",
          transition: "quick.session-create",
          authority: "cli",
          ownership: "legacy",
          title: "crear la sesión liviana de la tarea",
          document: "loops/quick-loop/LOOP.md",
        },
        outcome: "completed",
      },
      "FLOW_DIRECTIVE_FINAL_WITH_TRANSITION",
    ],
    [
      "una frontera que no dice dónde se detuvo",
      {
        ...BASE,
        boundary: boundary({ transition: null }),
        outcome: "needs_input",
        request: request(),
      },
      "FLOW_DIRECTIVE_BOUNDARY_WITHOUT_TRANSITION",
    ],
    [
      "una frontera semántica sin pedido",
      { ...BASE, boundary: boundary(), outcome: "needs_input" },
      "FLOW_DIRECTIVE_SEMANTIC_WITHOUT_REQUEST",
    ],
    [
      "un pedido semántico fuera de su frontera",
      {
        ...BASE,
        boundary: boundary({ kind: "human", authority: "human" }),
        outcome: "needs_input",
        request: request(),
        choices: [
          { label: "Sí", consequence: "sigue", recommended: true },
          { label: "No", consequence: "para", recommended: false },
        ],
      },
      "FLOW_DIRECTIVE_REQUEST_WITHOUT_SEMANTIC",
    ],
    [
      "alternativas fuera de una frontera que elige",
      {
        ...BASE,
        boundary: boundary(),
        outcome: "needs_input",
        request: request(),
        choices: [{ label: "Sí", consequence: "sigue", recommended: true }],
      },
      "FLOW_DIRECTIVE_CHOICES_WITHOUT_BOUNDARY",
    ],
    [
      "una frontera humana con una sola alternativa",
      {
        ...BASE,
        boundary: boundary({ kind: "human", authority: "human" }),
        outcome: "needs_input",
        choices: [{ label: "Sí", consequence: "sigue", recommended: true }],
      },
      "FLOW_DIRECTIVE_CHOICE_SET_TOO_SMALL",
    ],
    [
      "una alternativa sin consecuencia",
      {
        ...BASE,
        boundary: boundary({ kind: "human", authority: "human" }),
        outcome: "needs_input",
        choices: [
          { label: "Sí", consequence: "   ", recommended: true },
          { label: "No", consequence: "para", recommended: false },
        ],
      },
      "FLOW_DIRECTIVE_CHOICE_WITHOUT_CONSEQUENCE",
    ],
    [
      "un conjunto sin recomendación única",
      {
        ...BASE,
        boundary: boundary({ kind: "human", authority: "human" }),
        outcome: "needs_input",
        choices: [
          { label: "Sí", consequence: "sigue", recommended: true },
          { label: "No", consequence: "para", recommended: true },
        ],
      },
      "FLOW_DIRECTIVE_RECOMMENDATION_AMBIGUOUS",
    ],
    [
      "un bloqueo sin causa",
      {
        ...BASE,
        boundary: boundary({ kind: "blocked", authority: "cli" }),
        outcome: "blocked",
      },
      "FLOW_DIRECTIVE_BLOCKED_WITHOUT_CAUSE",
    ],
    [
      "una frontera de autorización que no le falta nada",
      {
        ...BASE,
        boundary: boundary({ kind: "authorization", authority: "human" }),
        outcome: "needs_input",
        choices: [
          { label: "Autorizar", consequence: "aplica el efecto", recommended: true },
          { label: "Cerrar", consequence: "no aplica nada", recommended: false },
        ],
        effects: { planned: ["read_only"] },
        authorizations: ["read_only"],
      },
      "FLOW_DIRECTIVE_AUTHORIZATION_WITHOUT_GAP",
    ],
    [
      "un efecto aplicado que nadie planeó",
      {
        ...BASE,
        boundary: boundary(),
        outcome: "needs_input",
        request: request(),
        effects: { planned: [], applied: ["mutate_overwrite"] },
      },
      "FLOW_DIRECTIVE_EFFECT_UNPLANNED",
    ],
    [
      "un efecto aprobado que ninguna autorización cubre",
      {
        ...BASE,
        boundary: boundary(),
        outcome: "needs_input",
        request: request(),
        effects: { planned: ["network_external"], approved: ["network_external"] },
        authorizations: [],
      },
      "FLOW_DIRECTIVE_EFFECT_UNAUTHORIZED",
    ],
    [
      "una frontera legacy que no declara su fallback",
      {
        ...BASE,
        boundary: boundary({
          kind: "legacy",
          authority: "cli",
          ownership: "legacy",
          document: null,
        }),
        outcome: "needs_input",
      },
      "FLOW_DIRECTIVE_LEGACY_WITHOUT_FALLBACK",
    ],
    [
      "una frontera semántica sobre una transición que la doctrina todavía decide",
      {
        ...BASE,
        boundary: boundary({ ownership: "legacy" }),
        outcome: "needs_input",
        request: request(),
      },
      "FLOW_DIRECTIVE_OWNERSHIP_CONTRADICTED",
    ],
    [
      "una frontera legacy sobre una transición ya migrada",
      {
        ...BASE,
        boundary: boundary({ kind: "legacy", authority: "cli", ownership: "cli-owned" }),
        outcome: "needs_input",
      },
      "FLOW_DIRECTIVE_OWNERSHIP_CONTRADICTED",
    ],
    [
      "una traza que repite una transición",
      {
        ...BASE,
        applied: [
          {
            transition: "quick.session-create",
            authority: "cli" as const,
            ownership: "cli-owned" as const,
          },
          {
            transition: "quick.session-create",
            authority: "cli" as const,
            ownership: "cli-owned" as const,
          },
        ],
        boundary: boundary(),
        outcome: "needs_input",
        request: request(),
      },
      "FLOW_DIRECTIVE_APPLIED_REPEATED",
    ],
  ];

  it.each(cases)("%s se rechaza con código y acción", (_name, input, code) => {
    const built = buildFlowDirective(input);
    if (built.ok) throw new Error(`esperaba el rechazo ${code}`);
    expect(built.failure.code).toBe(code);
    expect(built.failure.message.length).toBeGreaterThan(0);
    expect(built.failure.action.length).toBeGreaterThan(0);
  });
});

describe("sin tercer protocolo paralelo (AC-COMP-01)", () => {
  /** A receipt written out in full: adding a field to the contract breaks here. */
  const receiptKeys = (): string[] => {
    const receipt: CapabilityReceipt = {
      protocol_version: 1,
      invocation_id: "00000000-0000-0000-0000-000000000000",
      attempt: 1,
      capability: "design",
      operation: "validate",
      request_digest: "a",
      semantic_inputs_digest: "b",
      parent_request_digest: null,
      outcome: "completed",
      floor: true,
      selection: [],
      inputs: [],
      output: null,
      validations: [],
      effects: { planned: [], approved: [], applied: [] },
      degradations: [],
      gaps: [],
      error: null,
      next_action: "seguir",
    };
    return Object.keys(receipt);
  };

  /** The capability envelope, likewise written out in full. */
  const requestKeys = (): string[] => {
    const envelope: CapabilityRequest = {
      protocol_version: 1,
      invocation_id: "00000000-0000-0000-0000-000000000000",
      attempt: 1,
      capability: "design",
      contract_version: 1,
      operation: "validate",
      caller: { route: "direct", host: "claude-code", flow: null },
      context: { workspace: null, target: null, base: null, profile: null },
      inputs: [],
      policy: { sensitive_sources: false, external_transmission: false },
      authorizations: [],
      parent_request_digest: null,
      request_digest: "a",
      semantic_inputs_digest: "b",
    };
    return Object.keys(envelope);
  };

  it("ningún campo de la directiva duplica uno ya entregado, salvo la reutilización declarada", () => {
    const delivered = new Set([...receiptKeys(), ...requestKeys(), ...Object.keys(request())]);
    const reused = new Set(Object.keys(FLOW_DIRECTIVE_REUSED_KEYS));
    const parallel = [...FLOW_DIRECTIVE_KEYS].filter(
      (key) => delivered.has(key) && !reused.has(key),
    );
    expect(parallel).toEqual([]);
  });

  it("cada reutilización declarada existe de verdad en la directiva y trae su motivo", () => {
    for (const [key, why] of Object.entries(FLOW_DIRECTIVE_REUSED_KEYS)) {
      expect([...FLOW_DIRECTIVE_KEYS], key).toContain(key);
      expect(why.trim().length, key).toBeGreaterThan(10);
    }
  });

  it("un solo sello por frontera, llevado donde cada contrato lo pide", () => {
    // The directive names it once; the nested semantic request carries the SAME
    // value in its own `input_digest`, because that protocol demands it there.
    // Two different seals would be two staleness questions and a caller guessing.
    expect([...FLOW_DIRECTIVE_KEYS]).not.toContain("input_digest");
    expect([...FLOW_DIRECTIVE_KEYS]).toContain("state_digest");
    expect(Object.keys(request())).toContain("input_digest");
  });

  it("el outcome de la directiva es el vocabulario del receipt, sin ampliarlo", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary(),
      outcome: "needs_input",
      request: request(),
    });
    if (!built.ok) throw new Error("esperaba una directiva");
    expect(CAPABILITY_OUTCOMES).toContain(built.directive.outcome);
  });

  it("los nombres e invocaciones públicas siguen intactos y 'flow' es uno más", () => {
    expect([...WORKLINE_FLOWS]).toEqual([
      "spec-refine",
      "plan-new",
      "plan-refine",
      "plan-exec",
      "quick",
    ]);
    const names = ALL_COMMANDS.map((command) => command.name);
    expect(names).toContain("capability");
    expect(names).toContain("flow");
    expect(new Set(names).size).toBe(names.length);
  });
});
