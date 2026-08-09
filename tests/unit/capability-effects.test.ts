import { describe, expect, it } from "vitest";
import { prepareDurableEffect } from "../../src/application/capability/durable-effect.js";
import { applyLocalProposal, reconcileAfterFailure } from "../../src/application/local-proposal.js";
import { PathsService } from "../../src/application/paths-service.js";
import { baseDigest } from "../../src/domain/proposal.js";

import { findOperation } from "../../src/domain/capability/descriptor.js";
import type { CapabilityOperation } from "../../src/domain/capability/descriptor.js";
import {
  EFFECT_CLASSES,
  OPEN_EFFECT_POLICY,
  authorizeEffects,
} from "../../src/domain/capability/effects.js";
import type { EffectClass, EffectDeclaration } from "../../src/domain/capability/effects.js";
import { buildCapabilityRequest, newInvocationId } from "../../src/domain/capability/protocol.js";
import type {
  CapabilityInputValue,
  CapabilityRequest,
} from "../../src/domain/capability/protocol.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs } from "../helpers/mem-fs.js";

const NO_CONTEXT = { sensitiveSources: false, scopeExpanded: false };
const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/work");

const declaration = (
  cls: EffectClass,
  over: Partial<EffectDeclaration> = {},
): EffectDeclaration => ({
  class: cls,
  idempotent: true,
  authorization: cls === "read_only" || cls === "local_additive" ? "invocation" : "preflight",
  approval: cls === "read_only" || cls === "local_additive" ? "none" : "visible",
  ...over,
});

describe("cada clase de efecto se autoriza según lo que realmente pide", () => {
  it.each(EFFECT_CLASSES)("'%s' cae del lado correcto de la línea", (cls) => {
    const result = authorizeEffects([declaration(cls)], NO_CONTEXT);
    expect(result.planned).toEqual([cls]);
    const selfAuthorizable = cls === "read_only" || cls === "local_additive";
    expect(result.selfAuthorized).toEqual(selfAuthorizable ? [cls] : []);
    expect(result.needsPreflight).toEqual(selfAuthorizable ? [] : [cls]);
  });

  it("leer fuentes sensibles ya no es el read_only que la invocación autorizó", () => {
    const result = authorizeEffects([declaration("read_only")], {
      sensitiveSources: true,
      scopeExpanded: false,
    });
    expect(result.selfAuthorized).toEqual([]);
    expect(result.needsPreflight).toEqual(["read_only"]);
  });

  it("escribir fuera del target pedido ya no es una creación local aditiva", () => {
    const result = authorizeEffects([declaration("local_additive")], {
      sensitiveSources: false,
      scopeExpanded: true,
    });
    expect(result.needsPreflight).toEqual(["local_additive"]);
  });

  it("una política de host más estricta siempre prevalece", () => {
    const hardened = authorizeEffects([declaration("local_additive")], NO_CONTEXT, {
      denied: [],
      preflight: ["local_additive"],
    });
    expect(hardened.selfAuthorized).toEqual([]);

    const denied = authorizeEffects([declaration("network_external")], NO_CONTEXT, {
      denied: ["network_external"],
      preflight: [],
    });
    expect(denied.denied).toEqual([
      { class: "network_external", why: "la política del host no admite esta clase de efecto" },
    ]);
    expect(denied.needsPreflight).toEqual([]);
  });

  // Un descriptor no puede recomprar lo que el host quitó: la annotation es la
  // vía por donde alguien intentaría hacerlo.
  it("una annotation del host o de MCP se registra y no autoriza nada", () => {
    const result = authorizeEffects(
      [declaration("network_external")],
      NO_CONTEXT,
      OPEN_EFFECT_POLICY,
      [{ class: "read_only", source: "mcp" }],
    );
    expect(result.annotations).toEqual([{ class: "read_only", source: "mcp" }]);
    expect(result.selfAuthorized).toEqual([]);
    expect(result.needsPreflight).toEqual(["network_external"]);
  });

  it("design declara sus efectos por operación y render puede salir de la máquina", () => {
    const render = findOperation(DESIGN_DESCRIPTOR, "render") as CapabilityOperation;
    const validate = findOperation(DESIGN_DESCRIPTOR, "validate") as CapabilityOperation;
    expect(render.effects.map((e) => e.class)).toContain("network_external");
    expect(authorizeEffects(render.effects, NO_CONTEXT).needsPreflight).toEqual([
      "network_external",
    ]);
    expect(authorizeEffects(validate.effects, NO_CONTEXT).needsPreflight).toEqual([]);
  });
});

function requestFor(operation: string, inputs: CapabilityInputValue[]): CapabilityRequest {
  const built = buildCapabilityRequest({
    invocationId: newInvocationId(),
    attempt: 1,
    descriptor: DESIGN_DESCRIPTOR,
    operation,
    caller: { route: "direct", host: "claude", flow: null },
    context: { workspace: "/work", target: "docs/designs", base: null, profile: null },
    inputs,
    policy: { sensitive_sources: false, external_transmission: false },
    authorizations: [],
    parentRequestDigest: null,
  });
  if (!built.ok) throw new Error(built.failure.message);
  return built.request;
}

const CREATE_INPUTS: CapabilityInputValue[] = [
  {
    name: "title",
    value: "Alta",
    provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
  },
  {
    name: "sources",
    value: ["docs/specs/014.md"],
    provenance: { kind: "reference", origin: "docs/specs", seal: null, sensitivity: "public" },
  },
  {
    name: "target",
    value: "docs/designs",
    provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
  },
];

const ARTIFACTS = [{ path: "docs/designs/DES-001/manifest.json", content: "{}\n" }];

describe("nada durable se aplica sin request, output, autorización y base validados", () => {
  const create = findOperation(DESIGN_DESCRIPTOR, "create") as CapabilityOperation;
  const validate = findOperation(DESIGN_DESCRIPTOR, "validate") as CapabilityOperation;

  it("una operación read-only no atraviesa el handshake durable", () => {
    const request = requestFor("validate", [
      {
        name: "package",
        value: "DES-001",
        provenance: {
          kind: "reference",
          origin: "docs/designs",
          seal: null,
          sensitivity: "public",
        },
      },
    ]);
    const prepared = prepareDurableEffect({
      request,
      authorization: authorizeEffects(validate.effects, NO_CONTEXT),
      artifacts: ARTIFACTS,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.failure.code).toBe("CAPABILITY_EFFECT_NOT_DURABLE");
  });

  it("un solo sello cubre bytes, base y alcance: cambiar cualquiera lo invalida", () => {
    const request = requestFor("create", CREATE_INPUTS);
    const prepare = (over: Partial<Parameters<typeof prepareDurableEffect>[0]> = {}) => {
      const prepared = prepareDurableEffect({
        request,
        authorization: authorizeEffects(create.effects, NO_CONTEXT),
        artifacts: ARTIFACTS,
        ...over,
      });
      if (!prepared.ok) throw new Error("prepare falló");
      return prepared.plan.proposal;
    };

    const plain = prepare();
    expect(plain.preview).toEqual([{ path: ARTIFACTS[0]?.path, bytes: 3, overwrite: false }]);
    // Idéntico: mismo sello. Es lo que permite reintentar sin volver a preguntar.
    expect(prepare().digest).toBe(plain.digest);

    // La base entra en el sello: publicar sobre otra revisión NO es la misma
    // propuesta aunque los bytes coincidan.
    const based = prepare({
      base: { path: "docs/designs/DES-001/x.json", digest: baseDigest("a") },
    });
    expect(based.digest).not.toBe(plain.digest);
    expect(
      prepare({ base: { path: "docs/designs/DES-001/x.json", digest: baseDigest("b") } }).digest,
    ).not.toBe(based.digest);

    // Y los bytes, obviamente.
    expect(
      prepare({ artifacts: [{ path: ARTIFACTS[0]?.path ?? "", content: "otro" }] }).digest,
    ).not.toBe(plain.digest);
  });

  it("un efecto externo sin aprobación no llega a llamar y dice datos, destino y efecto", async () => {
    const request = requestFor("create", CREATE_INPUTS);
    const external = authorizeEffects(
      [declaration("local_additive"), declaration("network_external")],
      NO_CONTEXT,
    );
    const prepared = prepareDurableEffect({
      request,
      authorization: external,
      artifacts: ARTIFACTS,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.plan.proposal.requires_approval).toEqual(["network_external"]);
    // Datos y destino visibles ANTES de cualquier llamada.
    expect(prepared.plan.proposal.preview[0]?.path).toBe(ARTIFACTS[0]?.path);

    const fs = new MemFs();
    const applied = await applyLocalProposal(fs, paths, {
      root: "/work",
      proposal: prepared.plan.proposal,
      approval: { digest: prepared.plan.proposal.digest, granted: [] },
      selfAuthorized: external.selfAuthorized,
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.failure.code).toBe("PROPOSAL_APPROVAL_MISSING");
    expect(applied.failure.message).toContain("network_external");
    expect(applied.applied, "nada se aplicó").toEqual([]);
    expect(fs.writes.size).toBe(0);
  });

  it("aprobar otros bytes que los que se van a escribir detiene el apply", async () => {
    const request = requestFor("create", CREATE_INPUTS);
    const prepared = prepareDurableEffect({
      request,
      authorization: authorizeEffects(create.effects, NO_CONTEXT),
      artifacts: ARTIFACTS,
    });
    if (!prepared.ok) throw new Error("prepare falló");
    const applied = await applyLocalProposal(new MemFs(), paths, {
      root: "/work",
      proposal: prepared.plan.proposal,
      approval: { digest: "otro", granted: [] },
      selfAuthorized: ["local_additive"],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.failure.code).toBe("PROPOSAL_APPROVAL_MISMATCH");
  });

  it("publicar contra una base que se movió se detiene antes de escribir", async () => {
    const request = requestFor("create", CREATE_INPUTS);
    const prepared = prepareDurableEffect({
      request,
      authorization: authorizeEffects(create.effects, NO_CONTEXT),
      artifacts: ARTIFACTS,
      base: { path: "docs/designs/DES-001/baseline.json", digest: baseDigest("viejo") },
    });
    if (!prepared.ok) throw new Error("prepare falló");

    const fs = new MemFs().file("/work/docs/designs/DES-001/baseline.json", "nuevo");
    const applied = await applyLocalProposal(fs, paths, {
      root: "/work",
      proposal: prepared.plan.proposal,
      approval: { digest: prepared.plan.proposal.digest, granted: [] },
      selfAuthorized: ["local_additive"],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.failure.code).toBe("PROPOSAL_BASE_STALE");
    expect(fs.writes.has("/work/docs/designs/DES-001/manifest.json")).toBe(false);
  });

  it("con todo en regla, escribe y declara qué clases aplicó", async () => {
    const request = requestFor("create", CREATE_INPUTS);
    const authorization = authorizeEffects(create.effects, NO_CONTEXT);
    const prepared = prepareDurableEffect({ request, authorization, artifacts: ARTIFACTS });
    if (!prepared.ok) throw new Error("prepare falló");

    const fs = new MemFs();
    const applied = await applyLocalProposal(fs, paths, {
      root: "/work",
      proposal: prepared.plan.proposal,
      approval: { digest: prepared.plan.proposal.digest, granted: [] },
      selfAuthorized: authorization.selfAuthorized,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.result.written).toEqual([ARTIFACTS[0]?.path]);
    expect(applied.result.applied).toEqual(["local_additive"]);
    expect(fs.writes.get("/work/docs/designs/DES-001/manifest.json")).toBe("{}\n");
  });
});

describe("un fallo o una cancelación no se reportan como éxito", () => {
  it("sin efectos aplicados, la acción siguiente es reintentar", () => {
    expect(reconcileAfterFailure("cancelled", []).applied).toEqual([]);
    expect(reconcileAfterFailure("failed", []).next_action).toContain("corregí");
  });

  it("con un efecto externo parcial, enumera lo aplicado y devuelve reconciliación", () => {
    const out = reconcileAfterFailure("cancelled", [
      { class: "network_external", what: "el bundle ya se subió al proveedor" },
    ]);
    expect(out.applied).toEqual(["network_external"]);
    expect(out.next_action).toContain("reconciliar");
    expect(out.next_action).toContain("el bundle ya se subió al proveedor");
  });
});
