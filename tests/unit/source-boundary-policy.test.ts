import { describe, expect, it } from "vitest";
import { parseTasks } from "../../src/application/parsers/tasks.js";
import {
  checkoutDigest,
  parsePlanSourceBoundary,
  validateCheckoutProof,
  validatePlanSourceBoundary,
  validateRemoteContextSnapshot,
} from "../../src/application/source-boundary-policy.js";

const validPlan = [
  "# Plan 031 — checkout",
  "",
  "> Límite de ejecución: checkout",
  "",
  "## Tasks",
  "",
  "### F1 — Política",
  "> Fuentes: workspace, cli",
  "",
  "- [ ] T1.1 — Implementar. _(fuentes: cli)_",
  "- [ ] T1.2 — Documentar. _(fuentes: workspace)_",
].join("\n");

describe("SourceBoundaryPolicy — estructura de plan", () => {
  it("lee la relación fase → tarea sin inferir fuentes de la prosa", () => {
    expect(parsePlanSourceBoundary(validPlan)).toEqual({
      execution_surface: "checkout",
      phases: [
        {
          n: 1,
          line: 7,
          sources: ["workspace", "cli"],
          tasks: [
            { n: 1, line: 10, sources: ["cli"] },
            { n: 2, line: 11, sources: ["workspace"] },
          ],
        },
      ],
    });
  });

  it("conserva la fuente cuando la tarea se parte en líneas Markdown", () => {
    const wrapped = validPlan.replace(
      "- [ ] T1.1 — Implementar. _(fuentes: cli)_",
      "- [ ] T1.1 — Implementar la pieza\n  y dejar su prueba local. _(fuentes: cli)_",
    );
    expect(parsePlanSourceBoundary(wrapped).phases[0]?.tasks[0]?.sources).toEqual(["cli"]);
  });

  it("expone fuentes y fase sólo en tareas bajo el contrato, sin alterar proyecciones legacy", () => {
    const declared = parseTasks(validPlan).items[0];
    expect(declared).toMatchObject({ phase: 1, sources: ["cli"] });
    expect(parseTasks("- [ ] T1.1 — Legacy").items[0]).toEqual({
      n: 1,
      status: "open",
      text: "T1.1 — Legacy",
    });
  });

  it("falla cerrado por límite/fuentes ausentes, alias desconocido y tarea fuera de fase", () => {
    const malformed = validPlan
      .replace("> Límite de ejecución: checkout\n\n", "")
      .replace("> Fuentes: workspace, cli", "> Fuentes: workspace")
      .replace("_(fuentes: cli)_", "_(fuentes: desconocida)_")
      .replace("_(fuentes: workspace)_", "");
    expect(validatePlanSourceBoundary(malformed, ["cli"]).map((failure) => failure.code)).toEqual([
      "PLAN_SOURCE_BOUNDARY_MISSING",
      "PLAN_SOURCE_UNKNOWN",
      "PLAN_TASK_SOURCE_OUTSIDE_PHASE",
      "PLAN_SOURCE_BOUNDARY_MISSING",
    ]);
  });

  it("rechaza una clausura con locator remoto y exige prueba local en una validación", () => {
    const remoteClosure = `${validPlan}\n\n**Validación de fase:** consultar https://example.test/health antes de cerrar.`;
    expect(validatePlanSourceBoundary(remoteClosure, ["cli"])[0]).toMatchObject({
      code: "PLAN_SOURCE_EXTERNAL_CLOSURE",
      line: 13,
    });

    const unboundedValidation = `${validPlan}\n\n## Validations\n\n- Verificar la aceptación final.`;
    expect(validatePlanSourceBoundary(unboundedValidation, ["cli"])[0]).toMatchObject({
      code: "PLAN_SOURCE_LOCAL_PROOF_MISSING",
      line: 15,
    });
  });

  it("deja el contexto remoto dentro de Handoff operativo fuera de la ruta de cierre", () => {
    const handoff = `${validPlan}\n\n## Handoff operativo\n\n- Entregable: consultar https://example.test/health.`;
    expect(validatePlanSourceBoundary(handoff, ["cli"])).toEqual([]);
  });
});

describe("SourceBoundaryPolicy — CheckoutProof", () => {
  const digest = checkoutDigest({
    source: "cli",
    head: "abc",
    dirty: false,
    changed_files: [],
    worktree_fingerprint: "sha256:clean",
  });
  const proof = {
    kind: "command" as const,
    source: "cli",
    relative_cwd: "src",
    checkout_digest: digest,
    invocation: { program: "npm", args: ["test"] },
  };

  it("acepta una prueba del checkout vigente y rechaza stale o rutas que escapan", () => {
    expect(validateCheckoutProof(proof, [{ source: "cli", digest }])).toBeNull();
    expect(validateCheckoutProof(proof, [{ source: "cli", digest: "moved" }])?.code).toBe(
      "WORKLINE_CHECKOUT_PROOF_STALE",
    );
    expect(
      validateCheckoutProof({ ...proof, relative_cwd: "../outside" }, [{ source: "cli", digest }])
        ?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
  });

  it("no acepta una forma de invocación que contradice el tipo de prueba", () => {
    const mismatched = {
      ...proof,
      invocation: { artifact: "docs/resultado.md" },
    } as unknown as typeof proof;
    expect(validateCheckoutProof(mismatched, [{ source: "cli", digest }])?.code).toBe(
      "WORKLINE_CHECKOUT_PROOF_INVALID",
    );
  });

  it("rechaza artefactos y comandos que localizan una superficie fuera del checkout", () => {
    expect(
      validateCheckoutProof(
        { ...proof, kind: "inspection", invocation: { artifact: "../outside/result.md" } },
        [{ source: "cli", digest }],
      )?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(
      validateCheckoutProof(
        {
          ...proof,
          kind: "inspection",
          invocation: { artifact: "https://example.test/result.md" },
        },
        [{ source: "cli", digest }],
      )?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(
      validateCheckoutProof(
        {
          ...proof,
          invocation: { program: "npm", args: ["run", "test", "https://example.test"] },
        },
        [{ source: "cli", digest }],
      )?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(
      validateCheckoutProof(
        { ...proof, invocation: { program: "https://example.test", args: [] } },
        [{ source: "cli", digest }],
      )?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(
      validateCheckoutProof(
        { ...proof, invocation: { program: "node", args: ["scripts/check.mjs", "alpha:5432"] } },
        [{ source: "cli", digest }],
      )?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(
      validateCheckoutProof({ ...proof, invocation: { program: "npm", args: ["run", "test"] } }, [
        { source: "cli", digest },
      ]),
    ).toBeNull();
  });

  it("vence una prueba cuando cambian los bytes de un archivo ya sucio", () => {
    const before = checkoutDigest({
      source: "cli",
      head: "abc",
      dirty: true,
      changed_files: ["src/policy.ts"],
      worktree_fingerprint: "sha256:bytes-a",
    });
    const after = checkoutDigest({
      source: "cli",
      head: "abc",
      dirty: true,
      changed_files: ["src/policy.ts"],
      worktree_fingerprint: "sha256:bytes-b",
    });
    expect(after).not.toBe(before);
    expect(
      validateCheckoutProof({ ...proof, checkout_digest: before }, [
        { source: "cli", digest: after },
      ])?.code,
    ).toBe("WORKLINE_CHECKOUT_PROOF_STALE");
  });

  it("nombra las fuentes elegibles cuando la prueba declara una que no lo es", () => {
    const failure = validateCheckoutProof(proof, [
      { source: "workspace", digest },
      { source: "ui", digest },
    ]);
    expect(failure?.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
    expect(failure?.message).toContain("workspace, ui");
  });

  it("dice que no hay ninguna elegible cuando no se pudo observar checkout alguno", () => {
    expect(validateCheckoutProof(proof, [])?.message).toContain("ninguna");
  });

  it("separa un checkout que cambió de una huella que no es reproducible", () => {
    const changed = validateCheckoutProof(proof, [{ source: "cli", digest: "moved" }]);
    expect(changed?.code).toBe("WORKLINE_CHECKOUT_PROOF_STALE");
    expect(changed?.message).toContain("cambió desde que se capturó la prueba");

    const unstable = validateCheckoutProof(proof, [
      { source: "cli", digest: "moved", reproducible: false },
    ]);
    expect(unstable?.code).toBe("WORKLINE_CHECKOUT_PROOF_STALE");
    expect(unstable?.message).toContain("NO es estable");
  });

  it("nombra la raíz que midió y la acción que corresponde a cada causa", () => {
    // El alias solo era activamente engañoso en un hub anidado: afirmaba que el
    // árbol se movió cuando el árbol estaba intacto y lo único distinto era el
    // directorio medido, así que mandaba a buscar un cambio que no existía.
    const root = "/hosts/este/proyectos/hub";

    const changed = validateCheckoutProof(proof, [{ source: "cli", digest: "moved", root }]);
    expect(changed?.message).toContain(root);
    expect(changed?.message).toContain("recapturala");

    const unstable = validateCheckoutProof(proof, [
      { source: "cli", digest: "moved", reproducible: false, root },
    ]);
    expect(unstable?.message).toContain(root);
    expect(unstable?.message).toContain("estabilizá");
    // Estabilizar y recapturar no son el mismo arreglo, y confundirlos es el costo.
    expect(unstable?.message).not.toContain("cambió desde que se capturó");
  });

  it("sin raíz observada el mensaje sigue siendo válido, sólo con el alias", () => {
    const failure = validateCheckoutProof(proof, [{ source: "cli", digest: "moved" }]);
    expect(failure?.code).toBe("WORKLINE_CHECKOUT_PROOF_STALE");
    expect(failure?.message).toContain("'cli'");
    expect(failure?.message).not.toContain("undefined");
  });
});

describe("SourceBoundaryPolicy — contexto remoto", () => {
  it("admite sólo el snapshot read-only como contexto, no como prueba de checkout", () => {
    expect(
      validateRemoteContextSnapshot({
        kind: "remote-read",
        connection: "alpha",
        readonly: true,
        query_artifact: "SCRIPTS.sql#consulta-1",
        captured_at: "2026-08-15T10:00:00Z",
        result_digest: "abc",
      }),
    ).toMatchObject({ kind: "remote-read", connection: "alpha", readonly: true });
    expect(
      validateRemoteContextSnapshot({
        kind: "remote-read",
        connection: "alpha",
        readonly: false,
        query_artifact: "SCRIPTS.sql#consulta-1",
        captured_at: "2026-08-15T10:00:00Z",
        result_digest: "abc",
      }),
    ).toBeNull();
  });
});
