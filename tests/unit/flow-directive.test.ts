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
import type { DelegatedAction } from "../../src/domain/flow/authority.js";
import {
  FLOW_BOUNDARY_KINDS,
  FLOW_DIRECTIVE_KEYS,
  FLOW_DIRECTIVE_REUSED_KEYS,
  FLOW_STEP_OUTCOMES,
  type FlowBoundary,
  type FlowStep,
  buildFlowDirective,
  renderDirectiveHuman,
} from "../../src/domain/flow/directive.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../src/domain/source-boundary.js";

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
    // A boundary that asks anything only exists for a transition this CLI owns.
    // There is no longer a kind that means "doctrine decides this one", so an
    // unowned row does not get a different boundary — it gets no boundary at all.
    ownership: "cli-owned",
    title: "reconocer cada señal de tamaño en el objetivo recibido",
    document: "loops/quick-loop/LOOP.md",
    ...overrides,
  };
}

/** A boundary whose transition does not declare the CLI's ownership. */
function unownedBoundary(overrides: Partial<FlowBoundary> = {}): FlowBoundary {
  // The cast is the only way to express it: the vocabulary has one member since
  // the fallback was retired, so the compiler refuses the literal and this guard
  // is what checks the engine refuses it too.
  return { ...boundary(overrides), ownership: "sin-declarar" as never };
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

/** A delegated action, valid by default so each case breaks exactly one thing. */
function delegated(overrides: Partial<DelegatedAction> = {}): DelegatedAction {
  return {
    invocation: {
      program: "aw",
      args: ["session-create", "--type", "quick"],
      target: ".workflow/sessions",
      input: null,
    },
    evidence: ["sesion-creada"],
    idempotent: false,
    recovery: "borrá la carpeta a medias y volvé a sembrar",
    ...overrides,
  };
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

  it("una frontera de ejecución lleva la invocación y su evidencia, y la proyecta", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary({ kind: "execution", authority: "cli" }),
      outcome: "needs_input",
      action: delegated(),
      nextAction: "ejecutá 'aw session-create --type quick' y devolvé su resultado",
    });
    if (!built.ok) throw new Error(`esperaba una directiva: ${built.failure.code}`);
    expect(built.directive.action?.evidence).toEqual(["sesion-creada"]);
    expect(built.directive.request).toBeNull();
    expect(built.directive.choices).toEqual([]);
    const human = renderDirectiveHuman(built.directive);
    // The person sees what will run, what has to come back, and what to do if it
    // comes back half-done — the three things a confirmation would hide.
    expect(human).toContain("aw session-create --type quick");
    expect(human).toContain(".workflow/sessions");
    expect(human).toContain("sesion-creada");
    expect(human).toContain("volvé a sembrar");
  });

  it("publica la raíz observada cuando la evidencia exige un CheckoutProof", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary({ kind: "execution", authority: "cli" }),
      outcome: "needs_input",
      action: delegated({
        evidence: ["sesion-creada", SOURCE_BOUNDED_EVIDENCE],
        checkouts: [{ source: "workspace", root: "/hosts/este/proyectos/hub" }],
      }),
      nextAction: "corré la invocación y devolvé su resultado",
    });
    if (!built.ok) throw new Error(`esperaba una directiva: ${built.failure.code}`);
    const human = renderDirectiveHuman(built.directive);
    // El dato que quien prueba NO podía deducir: contra qué directorio se compara.
    expect(human).toContain("workspace → /hosts/este/proyectos/hub");
    expect(human).toContain("observación local de esta corrida");
    // Lo transferible es la regla, no la ruta, y el lector va a ella por nombre.
    expect(human).toContain("aw flow --help");
    expect(human).toContain("aw flow prove");
  });

  it("no inventa una raíz cuando nadie la observó", () => {
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary({ kind: "execution", authority: "cli" }),
      outcome: "needs_input",
      action: delegated({ evidence: ["sesion-creada", SOURCE_BOUNDED_EVIDENCE] }),
      nextAction: "corré la invocación y devolvé su resultado",
    });
    if (!built.ok) throw new Error(`esperaba una directiva: ${built.failure.code}`);
    const human = renderDirectiveHuman(built.directive);
    expect(human).toContain("evidencia exigida");
    expect(human).not.toContain("checkout que validará");
  });

  it("los motivos de frontera son el vocabulario cerrado de la spec", () => {
    // Six, not seven: `legacy` left with the mechanism it existed for. It was the
    // only kind whose next action sent the reader to a document instead of back to
    // the engine, and nothing decides from a document any more.
    expect([...FLOW_BOUNDARY_KINDS]).toEqual([
      "semantic",
      "human",
      "authorization",
      "execution",
      "blocked",
      "final",
    ]);
    // Y lo que un paso pudo hacer también es cerrado: aplicarse u omitirse. Un
    // tercer valor sería un estado que ninguna superficie sabe presentar.
    expect([...FLOW_STEP_OUTCOMES]).toEqual(["applied", "skipped"]);
  });

  it("un paso omitido declara su motivo y uno aplicado no lo lleva", () => {
    const step = { transition: "quick.gate-choice", authority: "human", ownership: "cli-owned" };
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary({ kind: "semantic", authority: "agent" }),
      request: request(),
      outcome: "needs_input",
      // La traza dice "omitida" sin decir por qué: eso es un paso que nadie puede
      // auditar, y se rechaza al construir la directiva.
      applied: [{ ...step, outcome: "skipped", reason: "" } as FlowStep],
      nextAction: "seguí",
    });
    if (built.ok) throw new Error("una omisión sin motivo no puede construirse");
    expect(built.failure.code).toBe("FLOW_DIRECTIVE_STEP_REASON_MISMATCH");

    const invented = buildFlowDirective({
      ...BASE,
      boundary: boundary({ kind: "semantic", authority: "agent" }),
      request: request(),
      outcome: "needs_input",
      applied: [{ ...step, outcome: "applied", reason: "porque sí" } as FlowStep],
      nextAction: "seguí",
    });
    if (invented.ok) throw new Error("un paso aplicado no lleva motivo de omisión");
    expect(invented.failure.code).toBe("FLOW_DIRECTIVE_STEP_REASON_MISMATCH");
  });

  it("la proyección humana ya no ofrece ningún documento como regla a aplicar", () => {
    // What this replaces: the same case used to build a `legacy` boundary and
    // demand the line "fallback declarado: la regla vigente de …". The document
    // still travels — whoever answers is entitled to know what explains the step —
    // but no rendering presents it as something to go apply.
    const built = buildFlowDirective({
      ...BASE,
      boundary: boundary({
        kind: "human",
        authority: "human",
        transition: "quick.gate-choice",
        title: "elegir si el trabajo entra por QUICK",
      }),
      outcome: "needs_input",
      choices: [
        { label: "Seguir", consequence: "el recorrido sigue", recommended: true },
        { label: "Cerrar", consequence: "la corrida termina acá", recommended: false },
      ],
      nextAction: "elegí una alternativa",
    });
    if (!built.ok) throw new Error(`esperaba una directiva: ${built.failure.code}`);
    expect(built.directive.boundary.document).toBe("loops/quick-loop/LOOP.md");
    const human = renderDirectiveHuman(built.directive);
    expect(human).not.toContain("fallback declarado");
    expect(human).not.toContain("regla vigente");
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
    // `approved ⊆ authorizations` ya no es una combinación mentirosa, porque
    // `authorizations` dejó de ser un permiso de corrida: reporta lo que cubre LA
    // FRONTERA VIGENTE. Una directiva parada en un paso posterior no dice nada del
    // grant que se dio para una propuesta anterior, y compararlos rechazaría
    // directivas honestas. El invariante vive donde se produce: `withApproval`
    // escribe el grant y el momento `approved` desde el mismo objeto.
    [
      "una frontera semántica sobre una transición sin propiedad declarada",
      {
        ...BASE,
        boundary: unownedBoundary(),
        outcome: "needs_input",
        request: request(),
      },
      "FLOW_DIRECTIVE_OWNERSHIP_CONTRADICTED",
    ],
    [
      "una frontera humana sobre una transición sin propiedad declarada",
      {
        ...BASE,
        boundary: unownedBoundary({ kind: "human", authority: "human" }),
        outcome: "needs_input",
        choices: [
          { label: "Seguir", consequence: "el recorrido sigue", recommended: true },
          { label: "Cerrar", consequence: "la corrida termina acá", recommended: false },
        ],
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
    [
      "una frontera de ejecución que no dice qué ejecutar",
      {
        ...BASE,
        boundary: boundary({ kind: "execution", authority: "cli" }),
        outcome: "needs_input",
      },
      "FLOW_DIRECTIVE_EXECUTION_WITHOUT_ACTION",
    ],
    [
      "una acción delegada en una frontera que no la espera",
      {
        ...BASE,
        boundary: boundary(),
        outcome: "needs_input",
        request: request(),
        action: delegated(),
      },
      "FLOW_DIRECTIVE_ACTION_WITHOUT_BOUNDARY",
    ],
    [
      "una invocación sin programa",
      {
        ...BASE,
        boundary: boundary({ kind: "execution", authority: "cli" }),
        outcome: "needs_input",
        action: delegated({ invocation: { ...delegated().invocation, program: " " } }),
      },
      "FLOW_DIRECTIVE_ACTION_INCOMPLETE",
    ],
    [
      "una acción que no exige evidencia de haber ocurrido",
      {
        ...BASE,
        boundary: boundary({ kind: "execution", authority: "cli" }),
        outcome: "needs_input",
        action: delegated({ evidence: [] }),
      },
      "FLOW_DIRECTIVE_ACTION_WITHOUT_EVIDENCE",
    ],
    [
      "una acción sin recuperación declarada",
      {
        ...BASE,
        boundary: boundary({ kind: "execution", authority: "cli" }),
        outcome: "needs_input",
        action: delegated({ recovery: "  " }),
      },
      "FLOW_DIRECTIVE_ACTION_WITHOUT_RECOVERY",
    ],
    [
      "una frontera de ejecución sobre una transición sin propiedad declarada",
      {
        ...BASE,
        boundary: unownedBoundary({ kind: "execution", authority: "cli" }),
        outcome: "needs_input",
        action: delegated(),
      },
      "FLOW_DIRECTIVE_OWNERSHIP_CONTRADICTED",
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
