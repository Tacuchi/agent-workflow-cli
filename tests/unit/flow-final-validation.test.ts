import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directiveFor, resolveBoundary } from "../../src/application/flow/advance.js";
import { validatePlanSourceBoundary } from "../../src/application/source-boundary-policy.js";
import {
  type SourcePipeline,
  resolveFinalValidation,
} from "../../src/application/source-pipeline.js";
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import { routeControlOf } from "../../src/domain/flow/authority.js";
import { renderDirectiveHuman } from "../../src/domain/flow/directive.js";
import { executionVerdict } from "../../src/domain/flow/execution-result.js";
import { newRunState, withScope } from "../../src/domain/flow/run-state.js";

const row = journeyOfFlow("plan-exec").find((item) => item.id === "plan-exec.final-validation");
if (row === undefined) throw new Error("final-validation missing");

const pipeline = (alias: string, build: string, test: string): SourcePipeline => ({
  alias,
  origin: "AGENTS.md",
  build: { kind: "command", command: build },
  test: { kind: "command", command: test },
});

function directive(plan: string, sources: string[], pipelines: SourcePipeline[]) {
  const final_validation = resolveFinalValidation(plan, sources, pipelines);
  const state = withScope(newRunState("plan-exec", "052-test-plan-exec"), {
    plan: "docs/plans/052-plan-test.md",
    sources,
    final_validation,
  });
  return resolveBoundary(state, [row]).action;
}

describe("validación final — comandos por fuente", () => {
  it("lee build y tests versionados cuando el plan no sobrescribe", () => {
    expect(
      directive("## Validations\n", ["cli"], [pipeline("cli", "npm run build", "npm test")])
        ?.requirements,
    ).toEqual(["cli · build: `npm run build` (fuente)", "cli · tests: `npm test` (fuente)"]);
  });

  it("la directiva legible nombra comando, fuente y procedencia", () => {
    const state = withScope(newRunState("plan-exec", "052-test-plan-exec"), {
      plan: "docs/plans/052-plan-test.md",
      sources: ["cli"],
      final_validation: resolveFinalValidation(
        "## Validations\n",
        ["cli"],
        [pipeline("cli", "npm run build", "npm test")],
      ),
    });
    const resolved = resolveBoundary(state, [row]);
    const built = directiveFor(state, resolved, []);
    if (!built.ok) throw new Error(built.failure.code);
    expect(renderDirectiveHuman(built.directive, true)).toContain(
      "validación final: cli · build: `npm run build` (fuente)",
    );
    expect(renderDirectiveHuman(built.directive, true)).toContain(
      "validación final: cli · tests: `npm test` (fuente)",
    );
  });

  it("sobrescribe sólo el comando nombrado para esa fuente", () => {
    const plan =
      "## Validations\n\n- Validación final · `cli` · tests `npx vitest run tests/unit`\n";
    expect(
      directive(plan, ["cli"], [pipeline("cli", "npm run build", "npm test")])?.requirements,
    ).toEqual([
      "cli · build: `npm run build` (fuente)",
      "cli · tests: `npx vitest run tests/unit` (plan)",
    ]);
  });

  it("sin declaración publica cada faltante y cómo declararlo", () => {
    const requirements = directive("## Validations\n", ["cli"], [])?.requirements ?? [];
    expect(requirements).toHaveLength(2);
    expect(requirements[0]).toContain("faltante — declará build para 'cli'");
    expect(requirements[1]).toContain("faltante — declará tests para 'cli'");
    expect(requirements[0]).toContain("## Validations");
  });

  it("en dos fuentes la sobrescritura de una no altera la otra", () => {
    const plan =
      "## Validations\n\n- Validación final · `cli` · build `npm run build:local` · tests `npm run test:local`\n";
    expect(
      directive(
        plan,
        ["cli", "web"],
        [pipeline("cli", "npm run build", "npm test"), pipeline("web", "make build", "make test")],
      )?.requirements,
    ).toEqual([
      "cli · build: `npm run build:local` (plan)",
      "cli · tests: `npm run test:local` (plan)",
      "web · build: `make build` (fuente)",
      "web · tests: `make test` (fuente)",
    ]);
  });

  it("rechaza al guardar un alias ajeno al alcance y una cláusula mal formada", () => {
    const base = [
      "> Límite de ejecución: checkout",
      "## Tasks",
      "### F1 — Código",
      "> Fuentes: cli",
      "- [ ] T1.1 — Implementar. _(fuentes: cli)_",
      "## Validations",
    ].join("\n");
    expect(
      validatePlanSourceBoundary(
        `${base}\n- Validación final · \`web\` · build \`npm run build\``,
        ["cli", "web"],
      ).map((failure) => failure.code),
    ).toContain("PLAN_SOURCE_UNKNOWN");
    expect(
      validatePlanSourceBoundary(`${base}\n- Validación final · web · build \`npm run build\``, [
        "cli",
        "web",
      ]).map((failure) => failure.code),
    ).toContain("PLAN_SOURCE_UNKNOWN");
  });
});

describe("validación final — acreditación de todos los comandos", () => {
  const vitest = JSON.parse(
    readFileSync(new URL("../fixtures/test-runs/vitest.json", import.meta.url), "utf8"),
  ) as { green: string; empty: string };
  const sources = ["cli", "web"];
  const action = directive("## Validations\n", sources, [
    pipeline("cli", "npm run build", "npm test"),
    pipeline("web", "make build", "make test"),
  ]);
  if (action === null) throw new Error("final-validation action missing");
  const validations = action.evidence.map((id) => ({
    id,
    passed: true,
    detail: id.endsWith(".tests") ? vitest.green : "Build completed successfully",
  }));
  const result = (items = validations) => ({
    outcome: "completed" as const,
    invocation: action.invocation,
    output: null,
    validations: items,
    effects: { planned: [], approved: [], applied: [] },
  });

  it("sella cuatro ids distintos y sólo acredita cuatro salidas reales", () => {
    expect(action.evidence).toEqual([
      "plan.final-validation.cli.build",
      "plan.final-validation.cli.tests",
      "plan.final-validation.web.build",
      "plan.final-validation.web.tests",
    ]);
    expect(executionVerdict(result(), action, [])).toBeNull();
  });

  it("la validación final no declara control de ruta para omitirla", () => {
    expect(routeControlOf(row)).toBeNull();
    expect(
      routeControlOf(
        journeyOfFlow("plan-refine").find((item) => item.id === "plan-refine.executability-gate") ??
          row,
      )?.consequences.omit,
    ).toBeDefined();
  });

  it("sin los tests de una fuente o con una validación fallida no acredita", () => {
    expect(
      executionVerdict(
        result(validations.filter((item) => item.id !== "plan.final-validation.web.tests")),
        action,
        [],
      )?.detail.code,
    ).toBe("FLOW_EVIDENCE_MISSING");
    expect(
      executionVerdict(
        result(
          validations.map((item) =>
            item.id.endsWith(".cli.build") ? { ...item, passed: false } : item,
          ),
        ),
        action,
        [],
      )?.detail.code,
    ).toBe("FLOW_EVIDENCE_MISSING");
  });

  it("una suite que no ejecutó pruebas no acredita los tests de una fuente", () => {
    const invalid = validations.map((item) =>
      item.id === "plan.final-validation.web.tests" ? { ...item, detail: vitest.empty } : item,
    );
    expect(executionVerdict(result(invalid), action, [])?.detail.code).toBe(
      "PLAN_TEST_RUN_NOT_EXECUTED",
    );
  });

  it("un build no declarado impide acreditar aun si se envía evidencia inventada", () => {
    const incomplete = directive(
      "## Validations\n",
      ["web"],
      [
        {
          ...pipeline("web", "make build", "make test"),
          build: { kind: "none", value: "ninguno" },
        },
      ],
    );
    if (incomplete === null) throw new Error("missing action");
    const forged = result(
      incomplete.evidence.map((id) => ({ id, passed: true, detail: vitest.green })),
    );
    expect(executionVerdict(forged, incomplete, [])?.detail.code).toBe(
      "PLAN_FINAL_PIPELINE_MISSING",
    );
  });
});
