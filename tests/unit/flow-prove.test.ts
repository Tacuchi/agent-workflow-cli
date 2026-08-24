import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { proveFlowBoundary } from "../../src/application/flow/prove.js";
import { PathsService } from "../../src/application/paths-service.js";
import { validateCheckoutProof } from "../../src/application/source-boundary-policy.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { FLOW_RUN_STATE_FILE } from "../../src/domain/flow/run-state.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../src/domain/source-boundary.js";
import type { GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * `aw flow prove` — the sanctioned way to obtain a proof the submit will accept.
 *
 * Before it, the only known route was importing the CLI's own modules and
 * rebuilding the digest formula by hand. That made the formula a de facto public
 * API and charged every executor the same tuition, paid in a boundary's attempts.
 */

vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  const journey: FlowDecision[] = [
    {
      id: "fixture.source-bounded",
      scope: "quick",
      title: "correr la invocación sellada y probar el checkout",
      // `cli` because an EXECUTION boundary is a cli row: an `agent` row is a
      // semantic boundary and emits no invocation at all. Every real
      // source-bounded gate in the product is shaped this way.
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      // `read_only` on purpose: an effect awaiting approval parks the run at an
      // AUTHORIZATION boundary, where no invocation is sealed yet and there is
      // genuinely nothing to prove. What is under test is the capture itself.
      effects: ["read_only"],
      action: {
        invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
        execution: { kind: "external", reason: "el juicio es sobre lo que devuelve" },
        evidence: ["prueba.tablero", "workline.source-bounded"],
        idempotent: true,
        recovery: "volvé a correrla y devolvé su salida real",
      },
    },
  ];
  return { ...real, journeyOfFlow: () => journey };
});

const SESSION = "001-prueba-quick";
const fs = new NodeFileSystem();

/** A git double whose fingerprint can be made to disagree with itself. */
function gitDouble(
  options: { fingerprints?: string[]; isRepo?: boolean; throws?: boolean } = {},
): GitPort {
  const queue = [...(options.fingerprints ?? [])];
  return {
    async isGitRepo() {
      return options.isRepo ?? true;
    },
    async head() {
      if (options.throws === true) throw new Error("git no está disponible");
      return "abc1234";
    },
    async isDirty() {
      return false;
    },
    async changedFiles() {
      return [];
    },
    async checkoutFingerprint() {
      return queue.shift() ?? "huella-estable";
    },
  } as unknown as GitPort;
}

describe("aw flow prove", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-prove-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    await mkdir(join(workdir, `.${paths.namespace}`), { recursive: true });
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);

  it("produce un proof que la política del submit acepta, y nombra la raíz que midió", async () => {
    const result = await proveFlowBoundary(fs, paths, { code: "001", git: gitDouble() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("esperaba una captura");
    const { receipt } = result;
    expect(receipt.checkout).toEqual({ source: "workspace", root: workdir });
    expect(receipt.evidence).toContain(SOURCE_BOUNDED_EVIDENCE);
    expect(receipt.proof.kind).toBe("command");
    // The sealed program and args, and NOT `target`/`input`: carrying the whole
    // invocation object is the natural mistake, because it is right there.
    expect(receipt.proof.invocation).toEqual({ program: "aw", args: ["status", "--json"] });
    expect(receipt.proof.source).toBe("workspace");
    // Dónde va, con el id EXACTO: el validador no busca, lee el ítem que se llama
    // así. Colgar la prueba de otro ítem de la lista se lee como una prueba que no
    // llegó, y eso cobra un intento.
    expect(receipt.usage).toContain(SOURCE_BOUNDED_EVIDENCE);

    // The real check: the very policy the submit runs accepts it against a state
    // observed the same way. A capture this surface blessed must not be rejected
    // downstream for shape or ownership.
    const rejection = validateCheckoutProof(receipt.proof, [
      { source: "workspace", digest: receipt.proof.checkout_digest, reproducible: true },
    ]);
    expect(rejection).toBeNull();
  });

  it("no escribe nada: el estado de la corrida queda byte por byte igual", async () => {
    const before = await readFile(statePath(), "utf8");

    const result = await proveFlowBoundary(fs, paths, { code: "001", git: gitDouble() });
    expect(result.ok).toBe(true);

    // A capture that wrote to the tree it measures would expire its own digest.
    expect(await readFile(statePath(), "utf8")).toBe(before);
  });

  it("con --artifact produce una prueba inspection sobre esa ruta", async () => {
    const result = await proveFlowBoundary(fs, paths, {
      code: "001",
      artifact: "docs/plans/035-plan-checkout-proof-observable.md",
      git: gitDouble(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("esperaba una captura");
    expect(result.receipt.proof.kind).toBe("inspection");
    expect(result.receipt.proof.invocation).toEqual({
      artifact: "docs/plans/035-plan-checkout-proof-observable.md",
    });
  });

  it("falla cerrada cuando la huella no es estable, y lo dice", async () => {
    const result = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble({ fingerprints: ["una", "otra"] }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un fallo cerrado");
    if ("session" in result) throw new Error("esperaba un fallo de capacidad");
    expect(result.failure.code).toBe("FLOW_PROVE_FINGERPRINT_UNSTABLE");
    expect(result.failure.message).toContain(workdir);
    expect(result.failure.action).toContain("estabilizala");
  });

  it("falla cerrada cuando la raíz no es un checkout observable", async () => {
    const result = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble({ isRepo: false }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un fallo cerrado");
    if ("session" in result) throw new Error("esperaba un fallo de capacidad");
    expect(result.failure.code).toBe("FLOW_PROVE_CHECKOUT_UNOBSERVABLE");
    expect(result.failure.message).toContain(workdir);
  });

  it("un git que falla no revienta la captura: falla cerrada", async () => {
    // Antes de compartir la observación con `submit`, un error de git se escapaba
    // sin atrapar y tiraba el comando entero. Una superficie que existe para NO
    // gastar intentos no puede contestar con una excepción.
    const result = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble({ throws: true }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un fallo cerrado");
    if ("session" in result) throw new Error("esperaba un fallo de capacidad");
    expect(result.failure.code).toBe("FLOW_PROVE_CHECKOUT_UNOBSERVABLE");
  });

  it("una fuente que no es elegible se rechaza nombrando las que sí", async () => {
    const result = await proveFlowBoundary(fs, paths, {
      code: "001",
      source: "un-alias-ajeno",
      git: gitDouble(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("esperaba un rechazo");
    if ("session" in result) throw new Error("esperaba un fallo de capacidad");
    expect(result.failure.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(result.failure.message).toContain("workspace");
  });
});
