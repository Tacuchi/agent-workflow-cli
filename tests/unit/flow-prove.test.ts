import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { proveFlowBoundary } from "../../src/application/flow/prove.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { validateCheckoutProof } from "../../src/application/source-boundary-policy.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_FILE,
  attemptAccountingAt,
  newRunState,
  serializeRunState,
  withScope,
} from "../../src/domain/flow/run-state.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../src/domain/source-boundary.js";
import type { GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
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
  options: {
    fingerprints?: string[];
    isRepo?: boolean;
    throws?: boolean;
    config?: string | null;
  } = {},
): GitPort {
  const queue = [...(options.fingerprints ?? [])];
  return {
    async isGitRepo() {
      return options.isRepo ?? true;
    },
    async head() {
      if (options.throws === true) throw new Error("fatal: índice ilegible en checkout");
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
    async readConfig() {
      return options.config ?? null;
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

  it("plan-exec in-place acredita la fuente en su checkout y no en una unidad", async () => {
    const source = join(workdir, "codigo");
    await mkdir(source);
    await writeFile(
      join(workdir, "CLAUDE.md"),
      `<!-- AGENT-WORKFLOW-HUB-START -->\n## Hub\nPrueba\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| codigo | ${source} | main |\n## Status\n- Modo de edición: in-place\n<!-- AGENT-WORKFLOW-HUB-END -->`,
    );
    const state = withScope(newRunState("plan-exec", SESSION), {
      plan: "docs/plans/072-plan-test.md",
      sources: ["codigo"],
      isolation: "in-place",
    });
    await writeFile(statePath(), serializeRunState(state));
    const result = await proveFlowBoundary(fs, paths, {
      code: "001",
      source: "codigo",
      git: gitDouble(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.receipt.checkout).toEqual({ source: "codigo", root: source });
  });

  it("produce un proof que la política del submit acepta, y nombra la raíz que midió", async () => {
    const result = await proveFlowBoundary(fs, paths, { code: "001", git: gitDouble() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("esperaba una captura");
    const { receipt } = result;
    expect(receipt.checkout).toEqual({ source: "hub", root: workdir });
    expect(receipt.evidence).toContain(SOURCE_BOUNDED_EVIDENCE);
    expect(receipt.proof.kind).toBe("command");
    // The sealed program and args, and NOT `target`/`input`: carrying the whole
    // invocation object is the natural mistake, because it is right there.
    expect(receipt.proof.invocation).toEqual({ program: "aw", args: ["status", "--json"] });
    expect(receipt.proof.source).toBe("hub");
    expect(receipt.proof.root).toBe(workdir);
    // Dónde va, con el id EXACTO: el validador no busca, lee el ítem que se llama
    // así. Colgar la prueba de otro ítem de la lista se lee como una prueba que no
    // llegó, y eso cobra un intento.
    expect(receipt.usage).toContain(SOURCE_BOUNDED_EVIDENCE);

    // The real check: the very policy the submit runs accepts it against a state
    // observed the same way. A capture this surface blessed must not be rejected
    // downstream for shape or ownership.
    const rejection = validateCheckoutProof(receipt.proof, [
      { source: "hub", digest: receipt.proof.checkout_digest, reproducible: true },
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
    expect(result.failure.message).toContain("fatal: índice ilegible");
  });

  it("submit muestra el stderr de git sin decir elegibles: ninguna ni gastar intento", async () => {
    const before = await readFile(statePath(), "utf8");
    const run = await advanceFlow(fs, paths, { code: "001", adopt: false });
    if (!run.ok) throw new Error("no se pudo leer la frontera");
    const result = await submitFlow(fs, paths, {
      code: "001",
      approval: null,
      git: gitDouble({ throws: true }),
      raw: JSON.stringify({ input_digest: run.directive.state_digest, outcome: "completed" }),
      executor: async () => ({ ok: true, summary: "", output: "", effects: [] }),
    });
    if (!result.ok) throw new Error("el rechazo no volvió dentro de la directiva");
    expect(result.directive.error?.message).toContain("fatal: índice ilegible");
    expect(result.directive.error?.message).not.toContain("elegibles: ninguna");
    expect(await readFile(statePath(), "utf8")).toBe(before);
  });

  it("en Windows avisa por core.longpaths ausente y calla cuando está activo", async () => {
    const missing = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble(),
      platform: "win32",
    });
    if (!missing.ok) throw new Error("sin prueba de Windows");
    expect(missing.receipt.warnings).toEqual([expect.stringContaining("core.longpaths")]);
    const ready = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble({ config: "true" }),
      platform: "win32",
    });
    if (!ready.ok) throw new Error("sin prueba de Windows configurado");
    expect(ready.receipt.warnings).toEqual([]);
  });

  it("una prueba vencida por otro árbol deja el intento en uno y una nueva acredita", async () => {
    const boundary = await advanceFlow(fs, paths, { code: "001", adopt: false });
    if (!boundary.ok) throw new Error("sin frontera");
    const executor = async () => ({ ok: true, summary: "", output: "", effects: [] });
    const one = await submitFlow(fs, paths, {
      code: "001",
      approval: null,
      executor,
      git: gitDouble(),
      raw: JSON.stringify({
        input_digest: boundary.directive.state_digest,
        outcome: "failed",
        invocation: boundary.directive.action?.invocation,
        validations: [],
        effects: { planned: ["read_only"], approved: [], applied: [] },
      }),
    });
    if (!one.ok) throw new Error("no quedó el primer intento");
    expect(one.directive.error?.code).toBe("FLOW_EXECUTION_NOT_COMPLETED");

    const captured = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble({ fingerprints: ["antes", "antes"] }),
    });
    if (!captured.ok) throw new Error("no se capturó la prueba anterior");
    const envelope = (proof: typeof captured.receipt.proof) =>
      JSON.stringify({
        input_digest: boundary.directive.state_digest,
        outcome: "completed",
        invocation: boundary.directive.action?.invocation,
        validations: [
          { id: "prueba.tablero", passed: true, detail: "resultado real" },
          { id: SOURCE_BOUNDED_EVIDENCE, passed: true, detail: "checkout observado", proof },
        ],
        effects: { planned: ["read_only"], approved: [], applied: ["read_only"] },
      });
    const stale = await submitFlow(fs, paths, {
      code: "001",
      approval: null,
      executor,
      git: gitDouble({ fingerprints: ["después", "después"] }),
      raw: envelope(captured.receipt.proof),
    });
    if (!stale.ok) throw new Error("el rechazo stale salió de la directiva");
    expect(stale.directive.error?.code).toBe("WORKLINE_CHECKOUT_PROOF_STALE");
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("sin estado");
    expect(attemptAccountingAt(read.state, "fixture.source-bounded").spent).toBe(1);

    const fresh = await proveFlowBoundary(fs, paths, {
      code: "001",
      git: gitDouble({ fingerprints: ["después", "después"] }),
    });
    if (!fresh.ok) throw new Error("no se recapturó");
    const accepted = await submitFlow(fs, paths, {
      code: "001",
      approval: null,
      executor,
      git: gitDouble({ fingerprints: ["después", "después"] }),
      raw: envelope(fresh.receipt.proof),
    });
    if (!accepted.ok) throw new Error("la prueba nueva no entró");
    expect(accepted.directive.error).toBeNull();
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
    expect(result.failure.message).toContain("hub");
  });

  it("el comando despacha --source desde valuesMulti; no prueba workspace por accidente", async () => {
    const ctx = {
      fs,
      paths,
      env: new FakeEnv(workdir),
      git: gitDouble(),
    } as unknown as CliContext;
    const result = await flowCommand.execute(
      parseArgv(["flow", "prove", "--session", "001", "--source", "un-alias-ajeno"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
  });
});
