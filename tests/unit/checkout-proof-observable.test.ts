import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCheckoutCandidates } from "../../src/application/flow/checkout-observation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { parseFlowAnswer, spendsAttempt } from "../../src/domain/flow/answer.js";
import type { DelegatedAction, FlowDecision } from "../../src/domain/flow/authority.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../src/domain/source-boundary.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Making the proved checkout observable, and blaming the right half when it is wrong.
 *
 * The two defects behind this were expensive in the one currency a boundary cannot
 * regenerate: attempts. One said the checkout had "changed" while the tree was
 * provably intact, because the alias never revealed WHICH directory was measured.
 * The other blamed a well-formed `validations` list for a malformed nested proof.
 */

const fs = new NodeFileSystem();

describe("identidad del checkout observado", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-checkout-identity-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("resuelve el ancestro con marcador y NO la raíz git que está por encima", async () => {
    // The nested hub, which is the case that cost the attempts: the git root is
    // above, the marker is below, and the digest is computed over the marker's
    // directory. A resolution that climbed to the repo would measure another tree.
    const gitRoot = join(workdir, "repo");
    const hub = join(gitRoot, "proyectos", "hub");
    await mkdir(join(gitRoot, ".git"), { recursive: true });
    await mkdir(hub, { recursive: true });
    const paths = new PathsService(normalizeNamespace("agent-workflow"), hub, hub);
    await mkdir(join(hub, `.${paths.namespace}`), { recursive: true });

    const candidates = await resolveCheckoutCandidates(fs, paths, "001-prueba");

    expect(candidates[0]).toEqual({ source: "workspace", root: hub });
    expect(candidates[0]?.root).not.toBe(gitRoot);
  });
});

describe("atribución del defecto de forma", () => {
  const invocation = { program: "aw", args: ["status", "--json"], target: ".", input: null };
  const action: DelegatedAction = {
    invocation,
    execution: { kind: "external", reason: "una prueba" },
    evidence: ["prueba.evidencia", SOURCE_BOUNDED_EVIDENCE],
    idempotent: true,
    recovery: "volvé a correrla",
  };
  const decision: FlowDecision = {
    id: "fixture.ejecucion",
    scope: "quick",
    title: "correr la invocación sellada",
    authority: "agent",
    ownership: "cli-owned",
    document: "loops/quick-loop/LOOP.md",
    action,
  };
  const parse = (proof: unknown) =>
    parseFlowAnswer({
      raw: JSON.stringify({
        input_digest: "el-sello",
        outcome: "completed",
        invocation,
        validations: [{ id: "prueba.evidencia", passed: true, detail: "la salida real", proof }],
        effects: { planned: [], approved: [], applied: [] },
      }),
      boundary: "execution",
      decision,
      seal: "el-sello",
      choices: [],
      approval: null,
      expectedApproval: null,
      action,
    });

  it("un proof inspection con campos de command culpa al proof, no a validations", () => {
    // The exact shape the report isolated: the directive's own `invocation` object
    // pasted whole into an `inspection` proof. It is the natural mistake, because
    // that object is the one the boundary just sealed.
    const result = parse({
      kind: "inspection",
      source: "workspace",
      relative_cwd: ".",
      checkout_digest: "un-digest",
      invocation,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un rechazo");
    expect(result.failure.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(result.failure.message).toContain("inspection");
    expect(result.failure.message).toContain("artifact");
    expect(result.failure.message).toContain("program");
    expect(result.failure.message).not.toContain("'validations' tiene que ser");
  });

  it("un proof command sin sus campos también se atribuye al proof", () => {
    const result = parse({
      kind: "command",
      source: "workspace",
      relative_cwd: ".",
      checkout_digest: "un-digest",
      invocation: { artifact: "docs/algo.md" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un rechazo");
    expect(result.failure.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(result.failure.message).toContain("command");
    expect(result.failure.message).toContain("artifact");
  });

  it("un kind mal escrito nombra los kinds válidos, no repite lo que llegó", () => {
    const result = parse({
      kind: "inspeccion",
      source: "workspace",
      relative_cwd: ".",
      checkout_digest: "un-digest",
      invocation: { artifact: "docs/algo.md" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un rechazo");
    expect(result.failure.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(result.failure.message).toContain("inspeccion");
    // El typo es la forma más probable de llegar acá, así que es el caso que más
    // necesita una frase usable: antes decía «espera X (trae: X)», con las dos
    // listas idénticas, y encima cobra un intento.
    expect(result.failure.message).toContain("no existe");
    expect(result.failure.message).toContain("'command'");
    expect(result.failure.message).toContain("'inspection'");
    expect(result.failure.message).not.toMatch(/espera ([^(]+) \(trae: \1\)/);
  });

  it("un contenedor 'validations' realmente mal formado SIGUE siendo FLOW_RESULT_INVALID", () => {
    const result = parseFlowAnswer({
      raw: JSON.stringify({
        input_digest: "el-sello",
        outcome: "completed",
        invocation,
        // The container itself breaks its own shape: `id` is not a string.
        validations: [{ nombre: "prueba.evidencia", passed: true }],
        effects: { planned: [], approved: [], applied: [] },
      }),
      boundary: "execution",
      decision,
      seal: "el-sello",
      choices: [],
      approval: null,
      expectedApproval: null,
      action,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un rechazo");
    expect(result.failure.code).toBe("FLOW_RESULT_INVALID");
  });

  it("el cargo por intento acompaña a la atribución, y no al revés", () => {
    // Esta reatribución MUEVE el costo: antes la forma mal armada salía como
    // FLOW_RESULT_INVALID, que es clase `envelope` y no cobra. Ahora sale con el
    // código del proof, que es `evaluated` y sí cobra. Es coherente —MISSING y
    // STALE ya cobraban, y una prueba leída y reprobada es una decisión que no
    // resolvió el hueco—, pero el guardián de la tabla sólo comprueba pertenencia
    // y es ciego a una reclasificación. Sin este caso, revertirla sería silencioso.
    const nested = parse({
      kind: "inspection",
      source: "workspace",
      relative_cwd: ".",
      checkout_digest: "un-digest",
      invocation,
    });
    if (nested.ok) throw new Error("esperaba un rechazo");
    expect(nested.failure.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(spendsAttempt(nested.failure.code)).toBe(true);

    // Y el contenedor mal formado sigue siendo gratis: es el sobre, no una decisión.
    expect(spendsAttempt("FLOW_RESULT_INVALID")).toBe(false);
  });

  it("un proof bien formado no estorba: la lista se lee entera", () => {
    const result = parse({
      kind: "command",
      source: "workspace",
      relative_cwd: ".",
      checkout_digest: "un-digest",
      invocation: { program: "aw", args: ["status", "--json"] },
    });

    expect(result.ok).toBe(true);
  });
});
