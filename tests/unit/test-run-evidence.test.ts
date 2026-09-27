import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePhases } from "../../src/application/parsers/phases.js";
import { executionVerdict } from "../../src/domain/flow/execution-result.js";
import {
  type TestFailure,
  type TestRunner,
  readTestFailures,
  testRunProblem,
} from "../../src/domain/flow/test-run-evidence.js";

const runners: TestRunner[] = ["vitest", "jest", "karma", "pytest", "maven-surefire", "gradle"];

/** Exercises the same verdict as submit, with an action that needs just its real output. */
function verdict(detail: string, id: string, prior: TestFailure[] = []) {
  const invocation = { program: "test", args: [], target: ".", input: null };
  return executionVerdict(
    {
      outcome: "completed",
      invocation,
      output: null,
      validations: [{ id, passed: true, detail }],
      effects: { planned: [], approved: [], applied: [] },
    },
    {
      invocation,
      execution: { kind: "external", reason: "test" },
      evidence: [id],
      idempotent: true,
      recovery: "run tests",
    },
    [],
    null,
    prior,
  );
}

describe.each(runners)("evidencia de %s", (runner) => {
  const fixture = JSON.parse(
    readFileSync(new URL(`../fixtures/test-runs/${runner}.json`, import.meta.url), "utf8"),
  ) as Record<string, string>;
  it("acepta la salida verde", () => {
    expect(testRunProblem(fixture.green ?? "")).toBeNull();
  });
  it.each(["empty", "load"])(
    "rechaza %s en validación de fase y final, citando ejecutor y línea",
    (kind) => {
      const detail = fixture[kind] ?? "";
      const problem = testRunProblem(detail);
      expect(problem).toMatchObject({ runner, kind: kind === "empty" ? "no-tests" : "load-error" });
      for (const id of ["plan.validaciones-de-fase-verdes", "plan.validacion-final-verde"]) {
        const result = verdict(detail, id);
        expect(result?.detail.code).toBe("PLAN_TEST_RUN_NOT_EXECUTED");
        expect(result?.message).toContain(problem?.line);
        expect(result?.message).toContain(runner);
      }
    },
  );
});

describe.each(runners)("rojos previos de %s", (runner) => {
  const fixture = JSON.parse(
    readFileSync(new URL(`../fixtures/test-runs/${runner}.json`, import.meta.url), "utf8"),
  ) as { failures: string; identities: TestFailure[] };
  it("lee archivo y caso, admite sólo los declarados y no los exime en validación final", () => {
    expect(readTestFailures(fixture.failures)).toEqual({
      failures: fixture.identities,
      unreadable: [],
    });
    expect(
      verdict(fixture.failures, "plan.validaciones-de-fase-verdes", fixture.identities),
    ).toBeNull();
    expect(
      verdict(fixture.failures, "plan.validaciones-de-fase-verdes", fixture.identities.slice(0, 1))
        ?.detail.code,
    ).toBe("PLAN_TEST_FAILURE_NEW");
    expect(
      verdict(fixture.failures, "plan.validacion-final-verde", fixture.identities)?.detail.code,
    ).toBe("PLAN_TEST_FAILURE_NEW");
  });
});

it("dos rojos declarados pasan, un tercero nuevo falla y una falla sin identidad no se esconde", () => {
  const prior = [
    { file: "test.ts", case: "one" },
    { file: "test.ts", case: "two" },
  ];
  const old = "FAIL test.ts > one\nFAIL test.ts > two\nTests 2 failed (2)";
  expect(verdict(old, "plan.validaciones-de-fase-verdes", prior)).toBeNull();
  expect(
    verdict(`${old}\nFAIL test.ts > three`, "plan.validaciones-de-fase-verdes", prior)?.detail.code,
  ).toBe("PLAN_TEST_FAILURE_NEW");
  expect(
    verdict(`${old}\nTests 3 failed (3)`, "plan.validaciones-de-fase-verdes", prior)?.detail.code,
  ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
  expect(
    verdict(`${old}\nTests: 1 failed, 1 total`, "plan.validaciones-de-fase-verdes", prior)?.detail
      .code,
  ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
  expect(
    verdict(`${old}\n1 failure: opaque runner`, "plan.validaciones-de-fase-verdes", prior)?.detail
      .code,
  ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
});

it("el bloque de rojos sólo pertenece a su fase, excluye ejemplos y falla cerrado si está mal formado", () => {
  const parsed = parsePhases(
    [
      "# Plan",
      "## Tasks",
      "### F1 — uno",
      "> Estado: pendiente",
      '> Rojos previos: [{"file":"a.test.ts","case":"suite > one"}]',
      "```md",
      '> Rojos previos: [{"file":"ejemplo","case":"ignorar"}]',
      "```",
      "### F2 — dos",
      "> Estado: pendiente",
      "> Rojos previos: []",
      "### F3 — tres",
      "> Estado: pendiente",
      "## Solution",
      '> Rojos previos: [{"file":"fuera","case":"ignorar"}]',
    ].join("\n"),
  );
  expect(parsed.items[0]?.preexisting_failures).toEqual([
    { file: "a.test.ts", case: "suite > one" },
  ]);
  expect(parsed.items[1]?.preexisting_failures).toBeNull();
  expect(parsed.items[2]?.preexisting_failures).toBeUndefined();
});

it("una nueva ejecución no toma prestados los nombres del rojo viejo", () => {
  const prior = [{ file: "tests/old.test.ts", case: "old" }];
  const first = "RUN v2.1.9 /workspace\nFAIL tests/old.test.ts > old\nTests 1 failed (1)";
  for (const tail of ["RUN v2.1.9 /workspace\nTests 1 failed (1)", "Tests 1 failed (1)"]) {
    expect(
      verdict(`${first}\n${tail}`, "plan.validaciones-de-fase-verdes", prior)?.detail.code,
    ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
  }
  expect(verdict(`${first}\n${first}`, "plan.validaciones-de-fase-verdes", prior)).toBeNull();
});

it("resúmenes de falla sin identidad nunca acreditan", () => {
  for (const text of [
    "Chrome Headless 131.0.0.0 (Mac OS 10.15.7): Executed 1 of 1 (1 FAILED) (0.01 secs / 0.01 secs)",
    "Test Suites: 1 failed, 1 total",
    "Test Files 1 failed (1)",
    "1 failing",
  ]) {
    expect(verdict(text, "plan.validacion-final-verde")?.detail.code).toBe(
      "PLAN_TEST_FAILURES_UNREADABLE",
    );
  }
});

it("pytest quiet tampoco presta identidades entre resúmenes sin frontera", () => {
  const detail =
    "FAILED tests/test_old.py::test_old - assert False\n1 failed in 0.10s\n1 failed in 0.20s";
  expect(
    verdict(detail, "plan.validaciones-de-fase-verdes", [
      { file: "tests/test_old.py", case: "test_old" },
    ])?.detail.code,
  ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
});

it.each([
  "FAIL tests/old.test.ts > old\nTest Files 2 failed (2)\nTest Files 1 failed (1)\nTests 1 failed (1)",
  "FAIL tests/old.test.ts\n● old\nTest Suites: 2 failed, 2 total\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 1 total",
])("un resumen de archivos posterior no borra fallas sin identidad", (detail) => {
  expect(
    verdict(detail, "plan.validaciones-de-fase-verdes", [
      { file: "tests/old.test.ts", case: "old" },
    ])?.detail.code,
  ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
});

it.each(["", "[ERROR] "])(
  "Surefire admite su resumen de clase y global con prefijo %s",
  (prefix) => {
    const detail = `[ERROR] com.example.ExampleTest.one -- Time elapsed: 0.01 s <<< FAILURE!\n${prefix}Tests run: 1, Failures: 1, Errors: 0, Skipped: 0 -- in com.example.ExampleTest\n${prefix}Tests run: 1, Failures: 1, Errors: 0, Skipped: 0`;
    expect(
      verdict(detail, "plan.validaciones-de-fase-verdes", [
        { file: "com.example.ExampleTest", case: "one" },
      ]),
    ).toBeNull();
  },
);

it("Karma compara ocurrencias por navegador y whitelist por archivo/caso", () => {
  const text = [
    "Chrome Headless 131.0.0.0 (Mac OS 10.15.7) suite one FAILED",
    "at UserContext.<anonymous> (src/example.spec.ts:12:3)",
    "Chrome Headless 131.0.0.0 (Mac OS 10.15.7): Executed 1 of 1 (1 FAILED) (0.01 secs / 0.01 secs)",
    "Firefox 131.0 (Mac OS 10.15.7) suite one FAILED",
    "at UserContext.<anonymous> (src/example.spec.ts:12:3)",
    "Firefox 131.0 (Mac OS 10.15.7): Executed 1 of 1 (1 FAILED) (0.01 secs / 0.01 secs)",
    "TOTAL: 2 FAILED, 0 SUCCESS",
  ].join("\n");
  const prior = [{ file: "src/example.spec.ts", case: "suite one" }];
  expect(verdict(text, "plan.validaciones-de-fase-verdes", prior)).toBeNull();
  expect(
    verdict(
      text.replace(
        "Firefox 131.0 (Mac OS 10.15.7) suite one FAILED\nat UserContext.<anonymous> (src/example.spec.ts:12:3)\n",
        "",
      ),
      "plan.validaciones-de-fase-verdes",
      prior,
    )?.detail.code,
  ).toBe("PLAN_TEST_FAILURES_UNREADABLE");
});

it.each([
  "0 failed",
  "Tests: 1 passed, 0 failed, 1 total",
  "1 test, 0 failed",
  "el caso verifica 0 tests",
  "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0",
])("no confunde un verde ni prosa con cero pruebas: %s", (line) => {
  expect(testRunProblem(line)).toBeNull();
});
it("lee SGR, CRLF y diagnósticos simples sin contexto", () => {
  expect(testRunProblem("\u001b[31mFound 1 load error\u001b[0m\r\n")?.runner).toBe("karma");
  expect(testRunProblem("0 tests")?.kind).toBe("no-tests");
});

it.each([
  ["pytest", "no tests ran in 0.00s"],
  ["gradle", "0 tests completed"],
  ["karma", "Chrome: Executed 0 of 12 SUCCESS\rFirefox: Executed 12 of 12 SUCCESS"],
])("rechaza el resultado vacío de %s sin confundir progreso ni ejecutor", (runner, line) => {
  expect(testRunProblem(line)).toMatchObject({ runner, kind: "no-tests" });
  for (const id of ["plan.validaciones-de-fase-verdes", "plan.validacion-final-verde"]) {
    expect(verdict(line, id)?.detail.code).toBe("PLAN_TEST_RUN_NOT_EXECUTED");
  }
});
