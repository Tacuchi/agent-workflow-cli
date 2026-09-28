import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import { composeCapability, composeGates } from "../../src/application/capability/compose.js";
import {
  type DispatchContext,
  type DispatchResult,
  dispatchCapability,
} from "../../src/application/capability/dispatcher.js";
import type { HostSelection } from "../../src/application/capability/resolution.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { satisfiesCompletenessGate } from "../../src/domain/capability/protocol.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const path = "docs/designs/001-design-alta-de-miembro/DESIGN.md";
const content = [
  "# Alta de miembro",
  "",
  "## Objetivo",
  "",
  "Registrar un familiar.",
  "",
  "## Diseño propuesto",
  "",
  "Formulario con nombre y vínculo.",
  "",
  "## Validación",
  "",
  "El alta figura en el listado.",
  "",
].join("\n");
const inputs: CapabilityInputValue[] = [
  {
    name: "title",
    value: "Alta de miembro",
    provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
  },
  {
    name: "sources",
    value: ["docs/requisitos.md"],
    provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
  },
];
const selection = (): HostSelection => ({
  token: "host-preselection-1",
  contributors: [
    {
      name: "skill-host-native",
      order: 1,
      digest: "b".repeat(64),
      metadata_source: "host",
      improves: { capability: "design", operations: ["create"], contract_version: 1 },
    },
  ],
});
function context(fs = new MemFs({ lenient: true }), denied = false): DispatchContext {
  return {
    fs,
    env: new FakeEnv("/home/u", "/work"),
    paths: new PathsService(normalizeNamespace("workflow"), "/home/u", "/work"),
    workspace: "/work",
    host: "claude-code",
    ...(denied ? { effectPolicy: { denied: ["local_additive"], preflight: [] } } : {}),
  };
}

function answer() {
  return JSON.stringify({
    version: 1,
    operation: "design.create",
    input_digest: semanticDigest(
      inputs
        .map(({ name, value }) => ({ name, value }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
    state: "proposed",
    artifacts: [{ path, content }],
  });
}

async function preselect(ctx: DispatchContext, route: "direct" | "compose" = "direct") {
  const base = { capability: "design", operation: "create", inputs, route } as const;
  const prepare =
    route === "direct"
      ? await dispatchCapability({ ...base, verb: "prepare" }, ctx)
      : await composeCapability({ ...base, verb: "prepare", flow: "spec-refine" }, ctx);
  if (!prepare.ok) throw new Error(prepare.failure.message);
  const next =
    route === "direct"
      ? await dispatchCapability(
          {
            ...base,
            verb: "continue",
            parent: prepare.attempt.request,
            hostSelection: selection(),
          },
          ctx,
        )
      : await composeCapability(
          {
            ...base,
            verb: "continue",
            flow: "spec-refine",
            parent: prepare.attempt.request,
            hostSelection: selection(),
          },
          ctx,
        );
  if (!next.ok) throw new Error(next.failure.message);
  return next.attempt;
}

async function validate(
  ctx: DispatchContext,
  preflight: Awaited<ReturnType<typeof preselect>>,
  over: Record<string, unknown> = {},
): Promise<DispatchResult> {
  return dispatchCapability(
    {
      verb: "validate",
      capability: "design",
      operation: "create",
      route: "direct",
      inputs,
      answer: answer(),
      pin: preflight.pin,
      request: preflight.request,
      hostSelection: selection(),
      ...over,
    },
    ctx,
  );
}

async function published(fs?: MemFs): Promise<DispatchContext> {
  const ctx = context(fs);
  const validated = await dispatchCapability(
    {
      verb: "validate",
      capability: "design",
      operation: "create",
      route: "direct",
      inputs,
      answer: answer(),
    },
    ctx,
  );
  if (!validated.ok || validated.attempt.plan === null)
    throw new Error("no se pudo preparar el package simple");
  const plan = validated.attempt.plan;
  const applied = await dispatchCapability(
    {
      verb: "apply",
      capability: "design",
      operation: "create",
      route: "direct",
      request: validated.attempt.request,
      plan,
      approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
    },
    ctx,
  );
  if (!applied.ok || applied.attempt.receipt.outcome !== "completed")
    throw new Error("no se publicó el package base");
  return ctx;
}

const validateInputs: CapabilityInputValue[] = [
  {
    name: "package",
    value: "DES-001",
    provenance: { kind: "reference", origin: "caller", seal: null, sensitivity: "public" },
  },
];

function selectedForValidation(): HostSelection {
  const selected = selection();
  const first = selected.contributors[0];
  if (!first) throw new Error("la fixture necesita un contribuyente");
  first.improves.operations = ["validate"];
  selected.preflight = {
    stage: "before_contribution",
    selection_digest: semanticDigest({
      token: selected.token,
      contributors: selected.contributors,
    }),
  };
  return selected;
}

async function hostValidation(
  ctx: DispatchContext,
  route: "direct" | "compose" = "direct",
  over: Record<string, unknown> = {},
) {
  const bytes = await ctx.fs.readBytes(`/work/${path}`);
  const observation = {
    id: "contenido-contrastado",
    path,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    detail: "Comprobación adicional del contenido del package por el host",
    passed: true,
  };
  const fields = {
    verb: "validate" as const,
    capability: "design",
    operation: "validate",
    inputs: validateInputs,
    answer: JSON.stringify({ host_observations: [observation] }),
    hostSelection: selectedForValidation(),
    contributions: [{ name: "skill-host-native", validation_ids: ["host:contenido-contrastado"] }],
  };
  return route === "direct"
    ? dispatchCapability({ ...fields, route, ...over }, ctx)
    : composeCapability({ ...fields, flow: "plan-exec", ...over }, ctx);
}

async function pinForValidation(ctx: DispatchContext, route: "direct" | "compose" = "direct") {
  const fields = {
    verb: "prepare" as const,
    capability: "design",
    operation: "validate",
    inputs: validateInputs,
    hostSelection: selectedForValidation(),
    route,
  };
  const result =
    route === "direct"
      ? await dispatchCapability(fields, ctx)
      : await composeCapability({ ...fields, flow: "plan-exec" }, ctx);
  if (!result.ok) throw new Error(result.failure.message);
  return result.attempt;
}

describe("crédito de design por intento sin catálogo ni instalación", () => {
  it("design.validate no acredita una observación declarada aunque su archivo y digest existan", async () => {
    const ctx = await published();
    for (const route of ["direct", "compose"] as const) {
      const early = await pinForValidation(ctx, route);
      const result = await hostValidation(ctx, route, { pin: early.pin, request: early.request });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.attempt.receipt.outcome).toBe("completed");
      expect(result.attempt.receipt.selection).toEqual([]);
      expect(result.attempt.receipt.floor).toBe(true);
      expect(result.attempt.receipt.degradations.some((d) => d.loss.includes("observación"))).toBe(
        true,
      );
      expect(
        result.attempt.receipt.validations.every((v) => v.id !== "host:contenido-contrastado"),
      ).toBe(true);
      expect(result.attempt.receipt.effects).toEqual({
        planned: ["read_only"],
        approved: ["read_only"],
        applied: ["read_only"],
      });
      expect(
        (result.attempt.output?.value as { host_observations: Array<{ passed: boolean }> })
          .host_observations[0]?.passed,
      ).toBe(false);
      expect(satisfiesCompletenessGate(result.attempt.receipt)).toBe(true);
      expect(composeGates(result, [], { requireCompleteness: true }).ok).toBe(true);
    }
  });

  it("el preflight construido en el mismo envío y un pin fabricado no acreditan", async () => {
    const ctx = await published();
    const forged = await hostValidation(ctx);
    expect(forged.ok).toBe(true);
    if (!forged.ok) return;
    expect(forged.attempt.receipt.floor).toBe(true);
    expect(forged.attempt.receipt.degradations[0]?.loss).toContain("intento previo");
    const invented = await hostValidation(ctx, "direct", {
      pin: forged.attempt.pin,
      request: forged.attempt.request,
    });
    expect(invented.ok).toBe(true);
    if (!invented.ok) return;
    expect(invented.attempt.receipt.selection).toEqual([]);
    expect(invented.attempt.receipt.degradations[0]?.loss).toContain("intento previo");
  });

  it("un continue que trae contenido no emite un pin anterior a ese contenido", async () => {
    const ctx = await published();
    const base = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: validateInputs,
      },
      ctx,
    );
    if (!base.ok) throw new Error(base.failure.message);
    const withContent = await dispatchCapability(
      {
        verb: "continue",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: validateInputs,
        parent: base.attempt.request,
        hostSelection: selectedForValidation(),
        answer: JSON.stringify({
          host_observations: [
            { id: "x", path, digest: `sha256:${"0".repeat(64)}`, passed: true, detail: "host" },
          ],
        }),
      },
      ctx,
    );
    if (!withContent.ok) throw new Error(withContent.failure.message);
    const replay = await hostValidation(ctx, "direct", {
      pin: withContent.attempt.pin,
      request: withContent.attempt.request,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.attempt.receipt.degradations.some((d) => d.loss.includes("intento previo"))).toBe(
      true,
    );
  });

  it("un pin que el CLI no pudo persistir se declara degradado", async () => {
    class UnwritablePinFs extends MemFs {
      override async publishTextExclusive(file: string, bytes: string) {
        if (file.includes("capability-selection")) throw new Error("sin permiso");
        return super.publishTextExclusive(file, bytes);
      }
    }
    const ctx = await published(new UnwritablePinFs({ lenient: true }));
    const early = await pinForValidation(ctx);
    expect(early.receipt.selection).toEqual([]);
    expect(early.receipt.degradations[0]?.loss).toContain("persistir");
    const result = await hostValidation(ctx, "direct", { pin: early.pin, request: early.request });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.selection).toEqual([]);
  });

  it("una observación cuyo archivo no se puede leer queda rechazada y el floor completa", async () => {
    class UnreadableObservationFs extends MemFs {
      override async readBytes(file: string): Promise<Uint8Array> {
        if (file.endsWith("/extra.txt")) throw new Error("sin permiso");
        return super.readBytes(file);
      }
    }
    const ctx = await published(new UnreadableObservationFs({ lenient: true }));
    const extra = path.replace("DESIGN.md", "extra.txt");
    await ctx.fs.writeText(`/work/${extra}`, "auxiliar");
    const result = await hostValidation(ctx, "direct", {
      answer: JSON.stringify({
        host_observations: [
          {
            id: "ilegible",
            path: extra,
            digest: `sha256:${"0".repeat(64)}`,
            passed: true,
            detail: "revisión",
          },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("completed");
    expect(result.attempt.receipt.floor).toBe(true);
    expect(
      result.attempt.receipt.degradations.some((d) => d.loss.includes("no se puede leer")),
    ).toBe(true);
    expect(composeGates(result, [], { requireCompleteness: true }).ok).toBe(true);
  });

  it("si tampoco valida el package propio, la observación inválida no hace verde el floor", async () => {
    const ctx = await published();
    await ctx.fs.writeText(`/work/${path}`, content.replace("## Validación", "## Otra sección"));
    const result = await hostValidation(ctx, "direct", {
      answer: JSON.stringify({
        host_observations: [
          {
            id: "erróneo",
            path,
            digest: `sha256:${"0".repeat(64)}`,
            passed: true,
            detail: "revisión",
          },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.message).toContain("observación host rechazada");
    expect(result.attempt.receipt.selection).toEqual([]);
    expect(composeGates(result, [], { requireCompleteness: true }).ok).toBe(false);
  });

  it("una declaración sin check, una versión incompatible o un digest inválido no ganan el gate", async () => {
    const ctx = await published();
    const missing = await hostValidation(ctx, "direct", { contributions: [] });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.attempt.receipt.selection).toEqual([]);
    expect(missing.attempt.receipt.degradations[0]?.cause).toBe("opaque_selection");
    const incompatible = selectedForValidation();
    const first = incompatible.contributors[0];
    if (!first || !incompatible.preflight) throw new Error("la fixture necesita selección previa");
    first.improves.contract_version = 9;
    incompatible.preflight.selection_digest = semanticDigest({
      token: incompatible.token,
      contributors: incompatible.contributors,
    });
    const wrongVersion = await hostValidation(ctx, "direct", { hostSelection: incompatible });
    expect(wrongVersion.ok).toBe(true);
    if (!wrongVersion.ok) return;
    expect(wrongVersion.attempt.receipt.selection).toEqual([]);
    const broken = await hostValidation(ctx, "direct", {
      answer: JSON.stringify({
        host_observations: [
          { id: "x", path, digest: `sha256:${"0".repeat(64)}`, detail: "wrong", passed: true },
        ],
      }),
    });
    expect(broken.ok).toBe(true);
    if (!broken.ok) return;
    expect(broken.attempt.receipt.outcome).toBe("completed");
    expect(broken.attempt.receipt.selection).toEqual([]);
    expect(broken.attempt.receipt.floor).toBe(true);
    expect(broken.attempt.receipt.degradations.some((d) => d.loss.includes("digest"))).toBe(true);
    expect(
      (broken.attempt.output?.value as { host_observations: Array<{ passed: boolean }> })
        .host_observations[0]?.passed,
    ).toBe(false);
    expect(composeGates(broken, [], { requireCompleteness: true }).ok).toBe(true);
    const escaped = await hostValidation(ctx, "direct", {
      answer: JSON.stringify({
        host_observations: [
          {
            id: "outside",
            path: "../../private.txt",
            digest: `sha256:${"0".repeat(64)}`,
            detail: "fuera del package",
            passed: true,
          },
        ],
      }),
    });
    expect(escaped.ok).toBe(true);
    if (!escaped.ok) return;
    expect(escaped.attempt.receipt.outcome).toBe("completed");
    expect(
      escaped.attempt.receipt.degradations.some((d) => d.loss.includes("fuera del package")),
    ).toBe(true);
  });

  it("una política que niega lectura bloquea antes del efecto y no acredita", async () => {
    const baseline = await published();
    const ctx = {
      ...baseline,
      effectPolicy: { denied: ["read_only"], preflight: [] },
    } as DispatchContext;
    const result = await hostValidation(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.error?.code).toBe("CAPABILITY_EFFECT_DENIED");
    expect(result.attempt.receipt.selection).toEqual([]);
  });
  it("una aportación identificada pero parcial no reclama mejora completa en el receipt", async () => {
    const ctx = context();
    const previous = await preselect(ctx);
    expect(previous.receipt.selection).toEqual([]);
    const result = await validate(ctx, previous);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.output?.completeness).toBe("partial");
    expect(result.attempt.receipt.selection).toEqual([]);
    expect(result.attempt.receipt.floor).toBe(true);
    expect(result.attempt.receipt.degradations[0]?.loss).toContain("candidato parcial");
    expect(satisfiesCompletenessGate(result.attempt.receipt)).toBe(false);
  });

  it("apply comprueba el pin del candidato parcial antes de cualquier escritura", async () => {
    const ctx = context();
    const previous = await preselect(ctx);
    const validated = await validate(ctx, previous);
    if (!validated.ok || !validated.attempt.plan) throw new Error("sin candidato parcial");
    const plan = validated.attempt.plan;
    expect(plan.selection_pin?.token).toBe(selection().token);
    const input = {
      verb: "apply" as const,
      capability: "design",
      operation: "create",
      route: "direct" as const,
      plan,
      request: validated.attempt.request,
      approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
    };
    const changed = await dispatchCapability(
      { ...input, hostSelection: { ...selection(), token: "otro" } },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.attempt.receipt.error?.code).toBe("CAPABILITY_SELECTION_CHANGED");
    expect(await ctx.fs.exists(`/work/${path}`)).toBe(false);
    const applied = await dispatchCapability({ ...input, hostSelection: selection() }, ctx);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");
    expect(applied.attempt.receipt.selection).toEqual([]);
  });

  it("compose no atribuye autoría sin el documento consumidor que su contrato exige", async () => {
    const ctx = context();
    const previous = await preselect(ctx, "compose");
    const result = await composeCapability(
      {
        verb: "validate",
        capability: "design",
        operation: "create",
        flow: "spec-refine",
        inputs,
        answer: answer(),
        request: previous.request,
        pin: previous.pin,
        hostSelection: selection(),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.selection).toEqual([]);
    expect(result.attempt.receipt.floor).toBe(true);
  });

  it("metadata de autoría sin pin previo no acredita nada", async () => {
    const ctx = context();
    const previous = await preselect(ctx);
    const noPreselection = await validate(ctx, previous, { pin: null, request: null });
    expect(noPreselection.ok).toBe(true);
    if (!noPreselection.ok) return;
    expect(noPreselection.attempt.receipt.selection).toEqual([]);
    expect(noPreselection.attempt.receipt.degradations[0]?.loss).toContain("no se fijó");
  });

  it("selección cambiante bloquea antes de publicar y efectos denegados nunca reciben crédito", async () => {
    const ctx = context();
    const previous = await preselect(ctx);
    const moved = await validate(ctx, previous, {
      hostSelection: { ...selection(), token: "different" },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.attempt.receipt.error?.code).toBe("CAPABILITY_SELECTION_CHANGED");
    const denied = await validate(context(new MemFs({ lenient: true }), true), previous);
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(denied.attempt.receipt.selection).toEqual([]);
    expect(denied.attempt.receipt.error?.code).toBe("CAPABILITY_EFFECT_DENIED");
  });

  it("un output inválido no satisface acreditación", async () => {
    const ctx = context();
    const previous = await preselect(ctx);
    const invalid = await validate(ctx, previous, {
      answer: answer().replace("## Validación", "## Inexistente"),
    });
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(invalid.attempt.receipt.selection).toEqual([]);
    expect(invalid.attempt.receipt.outcome).toBe("blocked");
  });
});
