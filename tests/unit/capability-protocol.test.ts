import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOperation } from "../../src/domain/capability/descriptor.js";
import type { CapabilityOperation } from "../../src/domain/capability/descriptor.js";
import {
  AttemptLedger,
  CAPABILITY_OUTCOMES,
  buildCapabilityRequest,
  buildReceipt,
  checkWorkspaceRequirement,
  continueInvocation,
  newInvocationId,
  receiptPersistence,
  renderReceiptHuman,
  satisfiesCompletenessGate,
} from "../../src/domain/capability/protocol.js";
import type {
  BuildCapabilityRequestInput,
  CapabilityInputValue,
  CapabilityRequest,
  InputDisposition,
} from "../../src/domain/capability/protocol.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";

const PACKAGE_INPUT: CapabilityInputValue = {
  name: "package",
  value: "DES-001",
  provenance: {
    kind: "reference",
    origin: "docs/designs/DES-001",
    seal: "sha256:aa",
    sensitivity: "public",
  },
};

const INPUTS: CapabilityInputValue[] = [PACKAGE_INPUT];

function baseInput(over: Partial<BuildCapabilityRequestInput> = {}): BuildCapabilityRequestInput {
  return {
    invocationId: newInvocationId(),
    attempt: 1,
    descriptor: DESIGN_DESCRIPTOR,
    operation: "validate",
    caller: { route: "direct", host: "claude", flow: null },
    context: { workspace: "/w", target: null, base: null, profile: null },
    inputs: INPUTS,
    policy: { sensitive_sources: false, external_transmission: false },
    authorizations: [],
    parentRequestDigest: null,
    ...over,
  };
}

function requestOf(over: Partial<BuildCapabilityRequestInput> = {}): CapabilityRequest {
  const built = buildCapabilityRequest(baseInput(over));
  if (!built.ok) throw new Error(built.failure.message);
  return built.request;
}

const dispositions = (request: CapabilityRequest): InputDisposition[] =>
  request.inputs.map((i) => ({
    name: i.name,
    used: true,
    reason: null,
    provenance: i.provenance,
  }));

describe("las dos rutas construyen el mismo request canónico", () => {
  it("wrapper y flow producen el mismo semantic_inputs_digest para el mismo trabajo", () => {
    const direct = requestOf({ caller: { route: "direct", host: "claude", flow: null } });
    const composed = requestOf({
      invocationId: newInvocationId(),
      caller: { route: "compose", host: "codex", flow: "spec-refine" },
    });

    expect(composed.semantic_inputs_digest).toBe(direct.semantic_inputs_digest);
    // Y los campos declaradamente variables sí cambian el sello del sobre: la
    // equivalencia es semántica, no byte a byte.
    expect(composed.request_digest).not.toBe(direct.request_digest);
  });

  it("un input distinto cambia el digest semántico", () => {
    const a = requestOf();
    const b = requestOf({
      inputs: [{ ...PACKAGE_INPUT, value: "DES-002" }],
    });
    expect(b.semantic_inputs_digest).not.toBe(a.semantic_inputs_digest);
  });

  it("el orden en que se pasan los inputs no cambia nada", () => {
    const two: CapabilityInputValue[] = [
      ...INPUTS,
      {
        name: "profile",
        value: "portable-html",
        provenance: { kind: "selection", origin: "caller", seal: null, sensitivity: "public" },
      },
    ];
    const a = requestOf({ inputs: two });
    const b = requestOf({ inputs: [...two].reverse() });
    expect(b.semantic_inputs_digest).toBe(a.semantic_inputs_digest);
  });

  it("una operación fuera del catálogo se rechaza con las válidas en la acción", () => {
    const built = buildCapabilityRequest(baseInput({ operation: "consume" }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_OPERATION_UNKNOWN");
    expect(built.failure.action).toContain("validate");
  });

  it("un input que la operación no declara se rechaza", () => {
    const built = buildCapabilityRequest(
      baseInput({
        inputs: [
          ...INPUTS,
          {
            name: "prompt",
            value: "…",
            provenance: { kind: "text", origin: "chat", seal: null, sensitivity: "public" },
          },
        ],
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_INPUT_UNDECLARED");
  });

  it("un input sin proveniencia se rechaza", () => {
    const built = buildCapabilityRequest(
      baseInput({
        inputs: [{ ...PACKAGE_INPUT, provenance: { ...PACKAGE_INPUT.provenance, origin: "  " } }],
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_INPUT_PROVENANCE_MISSING");
  });

  it("un input sensible sin política que lo permita se rechaza", () => {
    const built = buildCapabilityRequest(
      baseInput({
        inputs: [
          {
            ...PACKAGE_INPUT,
            provenance: { ...PACKAGE_INPUT.provenance, sensitivity: "sensitive" },
          },
        ],
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_SENSITIVE_INPUT_UNAUTHORIZED");
  });

  it("falta un input obligatorio y se dice cuál", () => {
    const built = buildCapabilityRequest(baseInput({ inputs: [] }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.message).toContain("package");
  });

  // El cierre del contexto invisible: el sobre no tiene un lugar donde esconder
  // semántica. Si apareciera un campo de prompt libre, este test lo dice.
  it("el sobre no tiene campo para prompt privado ni estado ambiental", () => {
    const request = requestOf();
    expect(Object.keys(request).sort()).toEqual([
      "attempt",
      "authorizations",
      "caller",
      "capability",
      "context",
      "contract_version",
      "inputs",
      "invocation_id",
      "operation",
      "parent_request_digest",
      "policy",
      "protocol_version",
      "request_digest",
      "semantic_inputs_digest",
    ]);
  });
});

describe("una continuación es un request nuevo, enlazado e inmutable", () => {
  const parent = requestOf({
    operation: "create",
    context: { workspace: "/w", target: "docs/designs", base: null, profile: null },
    inputs: createInputs(),
  });

  function createInputs(): CapabilityInputValue[] {
    return [
      {
        name: "title",
        value: "Alta de miembro",
        provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
      },
      {
        name: "sources",
        value: ["docs/specs/014-spec.md"],
        provenance: { kind: "reference", origin: "docs/specs", seal: null, sensitivity: "public" },
      },
      {
        name: "target",
        value: "docs/designs",
        provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
      },
    ];
  }

  it("conserva invocation_id, incrementa attempt y enlaza el digest padre", () => {
    const next = continueInvocation({
      parent,
      descriptor: DESIGN_DESCRIPTOR,
      inputs: [
        ...createInputs(),
        {
          name: "profile",
          value: "portable-html",
          provenance: { kind: "selection", origin: "respuesta", seal: null, sensitivity: "public" },
        },
      ],
      caller: parent.caller,
      context: parent.context,
      policy: parent.policy,
      authorizations: [],
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.request.invocation_id).toBe(parent.invocation_id);
    expect(next.request.attempt).toBe(2);
    expect(next.request.parent_request_digest).toBe(parent.request_digest);
    // Digests recalculados: el hijo no hereda ninguno de los dos.
    expect(next.request.request_digest).not.toBe(parent.request_digest);
    expect(next.request.semantic_inputs_digest).not.toBe(parent.semantic_inputs_digest);
  });

  it("un padre alterado se rechaza", () => {
    const tampered: CapabilityRequest = { ...parent, operation: "update" };
    const next = continueInvocation({
      parent: tampered,
      descriptor: DESIGN_DESCRIPTOR,
      inputs: createInputs(),
      caller: parent.caller,
      context: parent.context,
      policy: parent.policy,
      authorizations: [],
    });
    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.failure.code).toBe("CAPABILITY_PARENT_ALTERED");
  });

  it("el primer intento no puede declarar padre y una continuación no puede omitirlo", () => {
    const withParent = buildCapabilityRequest(baseInput({ parentRequestDigest: "sha" }));
    expect(withParent.ok).toBe(false);
    if (!withParent.ok) expect(withParent.failure.code).toBe("CAPABILITY_PARENT_UNEXPECTED");

    const orphan = buildCapabilityRequest(baseInput({ attempt: 2, parentRequestDigest: null }));
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.failure.code).toBe("CAPABILITY_PARENT_MISSING");
  });

  it("un salto de attempt se rechaza y un retry idéntico es idempotente", () => {
    const ledger = new AttemptLedger();
    const first = requestOf();
    expect(ledger.record(first)).toEqual({ ok: true, kind: "new" });
    // El mismo par invocation_id/attempt con los mismos bytes es un reenvío.
    expect(ledger.record(first)).toEqual({ ok: true, kind: "retry" });

    const jumped = requestOf({
      invocationId: first.invocation_id,
      attempt: 3,
      parentRequestDigest: first.request_digest,
    });
    const out = ledger.record(jumped);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe("CAPABILITY_ATTEMPT_OUT_OF_SEQUENCE");
  });

  it("el mismo attempt con bytes distintos es una divergencia, no un retry", () => {
    const ledger = new AttemptLedger();
    const first = requestOf();
    ledger.record(first);
    const diverged = requestOf({
      invocationId: first.invocation_id,
      attempt: 1,
      inputs: [{ ...PACKAGE_INPUT, value: "DES-999" }],
    });
    const out = ledger.record(diverged);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe("CAPABILITY_ATTEMPT_DIVERGED");
  });

  it("un padre que no es el intento inmediatamente anterior se rechaza", () => {
    const ledger = new AttemptLedger();
    const first = requestOf();
    ledger.record(first);
    const second = requestOf({
      invocationId: first.invocation_id,
      attempt: 2,
      parentRequestDigest: "sha256:otro",
    });
    const out = ledger.record(second);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe("CAPABILITY_PARENT_NOT_IMMEDIATE");
  });
});

describe("cada operación declara qué contexto necesita", () => {
  const validate = findOperation(DESIGN_DESCRIPTOR, "validate") as CapabilityOperation;

  /**
   * A `workspace: "required"` operation, built for this check.
   *
   * The rule belongs to the CONTRACT and has to be provable on its own: which
   * value a given capability declares is that capability's domain decision, and
   * `design` deliberately declares none — it accepts an explicit root instead
   * (`S013/AC-DIR-04`). Anchoring the contract's rule to design's value is what
   * made this test fail the day the domain changed its mind, which is a test
   * measuring the wrong thing.
   */
  const requiresWorkspace: CapabilityOperation = { ...validate, workspace: "required" };

  it("fuera de un workspace, una operación que lo exige devuelve un resultado explícito", () => {
    const check = checkWorkspaceRequirement(requiresWorkspace, {
      workspace: null,
      target: null,
      base: null,
      profile: null,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.failure.code).toBe("CAPABILITY_WORKSPACE_REQUIRED");
    expect(check.failure.action.length).toBeGreaterThan(0);
  });

  it("y no inicializa Workline por su cuenta", () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-capability-"));
    try {
      checkWorkspaceRequirement(requiresWorkspace, {
        workspace: null,
        target: dir,
        base: null,
        profile: null,
      });
      expect(readdirSync(dir), "la verificación no escribió nada").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("una operación 'optional' corre fuera de un workspace", () => {
    expect(
      checkWorkspaceRequirement(validate, {
        workspace: null,
        target: null,
        base: null,
        profile: null,
      }).ok,
    ).toBe(true);
  });

  // El valor que design declara es de dominio, y lo fija el plan 013 F10.
  it("design no exige workspace en ninguna operación: acepta raíz explícita", () => {
    const required = DESIGN_DESCRIPTOR.operations
      .filter((o) => o.workspace === "required")
      .map((o) => o.name);
    expect(required).toEqual([]);
  });
});

describe("cada intento devuelve outcome, output y receipt", () => {
  const request = requestOf();

  function receiptFor(outcome: (typeof CAPABILITY_OUTCOMES)[number]) {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome,
      floor: true,
      inputs: dispositions(request),
      output:
        outcome === "completed"
          ? { value: { verdict: "ok" }, reference: null, completeness: "complete" }
          : null,
      effects: { planned: ["read_only"], approved: [], applied: ["read_only"] },
      gaps: outcome === "needs_input" ? ["falta 'profile'"] : [],
      error:
        outcome === "failed" || outcome === "blocked"
          ? { code: "X", message: "algo", action: "hacé esto" }
          : null,
      nextAction: "seguí por acá",
    });
    if (!built.ok) throw new Error(built.failure.message);
    return built.receipt;
  }

  it.each(CAPABILITY_OUTCOMES)("'%s' devuelve receipt correlacionable", (outcome) => {
    const receipt = receiptFor(outcome);
    expect(receipt.outcome).toBe(outcome);
    expect(receipt.invocation_id).toBe(request.invocation_id);
    expect(receipt.request_digest).toBe(request.request_digest);
    expect(receipt.semantic_inputs_digest).toBe(request.semantic_inputs_digest);
    expect(receipt.next_action.length).toBeGreaterThan(0);
  });

  it("'completed' sin output es un falso éxito y se rechaza", () => {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "completed",
      floor: true,
      inputs: dispositions(request),
      output: null,
      nextAction: "x",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_COMPLETED_WITHOUT_OUTPUT");
  });

  it("'failed' sin error se rechaza", () => {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "failed",
      floor: true,
      inputs: dispositions(request),
      nextAction: "x",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_FAILURE_WITHOUT_ERROR");
  });

  it("un efecto aplicado que nadie planeó se rechaza", () => {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "completed",
      floor: true,
      inputs: dispositions(request),
      output: { value: 1, reference: null, completeness: "complete" },
      effects: { planned: ["read_only"], approved: [], applied: ["read_only", "destructive"] },
      nextAction: "x",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_EFFECT_UNPLANNED");
  });

  it("correr el floor y atribuir contribuyentes a la vez se rechaza", () => {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "completed",
      floor: true,
      selection: [
        { name: "acme", scope: "global", locator: "a", version: null, digest: "d", order: 1 },
      ],
      inputs: dispositions(request),
      output: { value: 1, reference: null, completeness: "complete" },
      nextAction: "x",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_FLOOR_WITH_SELECTION");
  });

  it("una degradación que el contrato no declara se rechaza", () => {
    const built = buildReceipt({
      request,
      descriptor: { ...DESIGN_DESCRIPTOR, degradations: [] },
      outcome: "completed",
      floor: true,
      inputs: dispositions(request),
      output: { value: 1, reference: null, completeness: "complete" },
      degradations: [{ cause: "opaque_selection", loss: "sin mejoras" }],
      nextAction: "x",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_DEGRADATION_UNDECLARED");
  });

  it("un input descartado en silencio se rechaza", () => {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "completed",
      floor: true,
      inputs: dispositions(request).map((d) => ({ ...d, used: false, reason: null })),
      output: { value: 1, reference: null, completeness: "complete" },
      nextAction: "x",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("CAPABILITY_INPUT_DISCARDED_SILENTLY");
  });

  it("una continuación produce dos receipts encadenados padre → hijo", () => {
    const parent = receiptFor("needs_input");
    const child = requestOf({
      invocationId: request.invocation_id,
      attempt: 2,
      parentRequestDigest: request.request_digest,
    });
    const built = buildReceipt({
      request: child,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "completed",
      floor: true,
      inputs: dispositions(child),
      output: { value: 1, reference: null, completeness: "complete" },
      nextAction: "listo",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.receipt.parent_request_digest).toBe(parent.request_digest);
    expect(built.receipt.invocation_id).toBe(parent.invocation_id);
    expect(built.receipt.attempt).toBe(parent.attempt + 1);
  });
});

describe("completitud y persistencia son proporcionales", () => {
  const request = requestOf();

  function completedWith(completeness: "complete" | "partial", durable: boolean) {
    const built = buildReceipt({
      request,
      descriptor: DESIGN_DESCRIPTOR,
      outcome: "completed",
      floor: true,
      inputs: dispositions(request),
      output: {
        value: null,
        reference: durable
          ? { id: "DES-001", revision: 1, digest: "sha256:aa", locator: "docs/designs/DES-001" }
          : null,
        completeness,
      },
      effects: {
        planned: durable ? ["read_only", "local_additive"] : ["read_only"],
        approved: [],
        applied: durable ? ["read_only", "local_additive"] : ["read_only"],
      },
      nextAction: "x",
    });
    if (!built.ok) throw new Error(built.failure.message);
    return built.receipt;
  }

  it("un output 'partial' no satisface un gate que exige completitud", () => {
    expect(satisfiesCompletenessGate(completedWith("partial", false))).toBe(false);
    expect(satisfiesCompletenessGate(completedWith("complete", false))).toBe(true);
  });

  it("read-only no persiste nada; una operación durable conserva su receipt", () => {
    expect(receiptPersistence(completedWith("complete", false))).toBe("none");
    expect(receiptPersistence(completedWith("complete", true))).toBe("registry");
  });

  it("la síntesis humana deriva campo a campo de la forma estructurada", () => {
    const receipt = completedWith("partial", true);
    const human = renderReceiptHuman(receipt);
    expect(human).toContain(`${receipt.capability}.${receipt.operation}`);
    expect(human).toContain(receipt.outcome);
    expect(human).toContain("partial");
    expect(human).toContain(receipt.output?.reference?.id as string);
    expect(human).toContain(receipt.output?.reference?.digest as string);
    expect(human).toContain(receipt.next_action);
    expect(human).toContain("floor");
    // No puede contradecir el dato: no anuncia contribuyentes que no hubo.
    expect(human).not.toContain("contribuyentes");
  });
});
