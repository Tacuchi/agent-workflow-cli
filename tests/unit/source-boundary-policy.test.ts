import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTasks } from "../../src/application/parsers/tasks.js";
import {
  finalValidationOverrides,
  parsePlanSourceBoundary,
  validatePlanSourceBoundary,
  validateSourceBoundedSemantics,
} from "../../src/application/source-boundary-policy.js";

const validPlan = [
  "# Plan 031 — checkout",
  "",
  "> Límite de ejecución: checkout",
  "",
  "## Tasks",
  "",
  "### F1 — Política",
  "> Fuentes: hub, cli",
  "",
  "- [ ] T1.1 — Implementar. _(fuentes: cli)_",
  "- [ ] T1.2 — Documentar. _(fuentes: hub)_",
].join("\n");

describe("SourceBoundaryPolicy — estructura de plan", () => {
  it.each(["\n", "\r\n"])(
    "lee la validación final con terminadores %j sin rechazar la fuente",
    (newline) => {
      const plan = [
        validPlan,
        "",
        "## Validations",
        "",
        "- Validación final · `cli` · build `npm run build`",
        "",
      ]
        .join("\n")
        .replace(/\n/g, newline);

      expect(finalValidationOverrides(plan)).toEqual([
        { alias: "cli", build: "npm run build", line: 15 },
      ]);
      expect(validatePlanSourceBoundary(plan, ["cli"])).toEqual([]);
    },
  );

  it("lee la relación fase → tarea sin inferir fuentes de la prosa", () => {
    expect(parsePlanSourceBoundary(validPlan)).toEqual({
      execution_surface: "checkout",
      phases: [
        {
          n: 1,
          line: 7,
          sources: ["hub", "cli"],
          tasks: [
            { n: 1, line: 10, sources: ["cli"] },
            { n: 2, line: 11, sources: ["hub"] },
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
      .replace("> Fuentes: hub, cli", "> Fuentes: hub")
      .replace("_(fuentes: cli)_", "_(fuentes: desconocida)_")
      .replace("_(fuentes: hub)_", "");
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

describe("SourceBoundaryPolicy — referente de checkout en la evidencia de cierre", () => {
  // El incidente que originó la regla: un plan de migración de otro proyecto,
  // cuyas validaciones nombran SUS directorios. Ninguna de las frases de abajo
  // contiene los términos que hoy habilitan el cierre, y eso es a propósito.
  const planWith = (validation: string, planValidation?: string) =>
    [
      "# Plan 001 — migración",
      "",
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — Columnas nuevas",
      "> Fuentes: cli",
      "",
      "- [ ] T1.1 — Agregar las columnas. _(fuentes: cli)_",
      "",
      `**Validación de fase:** ${validation}`,
      ...(planValidation === undefined ? [] : ["", "## Validations", "", `- ${planValidation}`]),
    ].join("\n");

  it("acepta la ruta relativa de un proyecto cuyos directorios no son los de este repo", () => {
    const plan = planWith(
      "las tres columnas aparecen al aplicar `migraciones/003_add_columns.sql` sobre una base de trabajo y la salida coincide con `db/esperado/003.txt`.",
      "el catálogo queda igual al aplicar `migraciones/` completo dos veces seguidas.",
    );
    expect(validatePlanSourceBoundary(plan, ["cli"])).toEqual([]);
  });

  it("acepta una invocación local escrita como código, sin ruta y sin palabra habilitante", () => {
    const plan = planWith(
      "`make verificar-catalogo` termina en cero y su salida no reporta ninguna columna faltante.",
    );
    expect(validatePlanSourceBoundary(plan, ["cli"])).toEqual([]);
  });

  it("es el referente y no el vocabulario lo que acepta: sin la ruta, la misma frase se rechaza", () => {
    const plan = planWith(
      "las tres columnas aparecen al aplicar la migración sobre una base de trabajo.",
    );
    expect(validatePlanSourceBoundary(plan, ["cli"]).map((failure) => failure.code)).toEqual([
      "PLAN_SOURCE_LOCAL_PROOF_MISSING",
    ]);
  });

  it("sigue rechazando la superficie externa con el mismo código y el mismo detalle", () => {
    const plan = planWith("el endpoint responde en https://example.test/health después de migrar.");
    expect(validatePlanSourceBoundary(plan, ["cli"])[0]).toMatchObject({
      code: "PLAN_SOURCE_EXTERNAL_CLOSURE",
      line: 12,
      message:
        "la validación de fase de línea 12 depende de la superficie externa 'https://example.test/health'",
    });
  });

  it("a la cláusula que no comprueba nada le pide una comprobación observable, no una prueba", () => {
    const plan = planWith(
      "el equipo queda conforme con el resultado.",
      "la aceptación final del área.",
    );
    const failures = validatePlanSourceBoundary(plan, ["cli"]);
    expect(failures.map((failure) => failure.code)).toEqual([
      "PLAN_SOURCE_LOCAL_PROOF_MISSING",
      "PLAN_SOURCE_LOCAL_PROOF_MISSING",
    ]);
    expect(failures[0]?.message).toBe(
      "la validación de fase de línea 12 no nombra ninguna comprobación observable en el checkout: citá el comando con sus argumentos entre comillas invertidas (`./mvnw test`) o nombrá el archivo (pom.xml), la ruta (tests/unit/x.test.ts) o el test (UsuarioServiceTest) que la produce",
    );
    expect(failures[1]?.line).toBe(16);
    for (const failure of failures) {
      expect(failure.message).not.toMatch(/prueba local|declar[aá] las fuentes|plan-refine/);
    }
  });

  it("no cambia el veredicto de lo que hoy pasa: el término solo sigue alcanzando", () => {
    const plan = planWith(
      "inspección del catálogo tras migrar.",
      "revisión por inspección del resultado.",
    );
    expect(validatePlanSourceBoundary(plan, ["cli"])).toEqual([]);
  });

  it("una barra que no es una ruta no acredita nada, ni siquiera entre comillas invertidas", () => {
    const plan = planWith("cobertura `N/A`, reparto 60/40 entre los dos equipos.");
    expect(validatePlanSourceBoundary(plan, ["cli"]).map((failure) => failure.code)).toEqual([
      "PLAN_SOURCE_LOCAL_PROOF_MISSING",
    ]);
  });

  it("una ruta local pero fuera del checkout tampoco es referente", () => {
    const plan = planWith("el operador corre ~/scripts/deploy.sh y revisa /etc/app/estado.conf.");
    expect(validatePlanSourceBoundary(plan, ["cli"]).map((failure) => failure.code)).toEqual([
      "PLAN_SOURCE_LOCAL_PROOF_MISSING",
    ]);
  });
});

describe("SourceBoundaryPolicy — la cláusula se juzga por lo que nombra", () => {
  const phaseWith = (...lines: string[]) =>
    [
      "# Plan 001 — x",
      "",
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — x",
      "> Fuentes: cli",
      "",
      "- [ ] T1.1 — Hacer. _(fuentes: cli)_",
      "",
      ...lines,
    ].join("\n");
  const codes = (text: string) =>
    validatePlanSourceBoundary(text, ["cli"]).map((failure) => failure.code);

  it("acepta un archivo citado o en prosa, un ejecutable relativo citado y un nombre de test", () => {
    for (const clause of [
      "**Validación de fase:** `pom.xml` declara la dependencia nueva.",
      "**Validación de fase:** pom.xml declara la dependencia nueva.",
      "**Validación de fase:** corre `./mvnw` sin errores.",
      "**Validación de fase:** UsuarioServiceLoginMensajesTest pasa.",
      "**Validación de fase:** test_login_bloquea pasa.",
    ]) {
      expect(codes(phaseWith(clause)), clause).toEqual([]);
    }
  });

  it("no toma por referente una palabra suelta, una abreviatura ni un programa sin argumentos", () => {
    for (const clause of [
      "**Validación de fase:** la spec queda cubierta.",
      "**Validación de fase:** la rúbrica queda verde.",
      "**Validación de fase:** corre `mvnw` y listo.",
      "**Validación de fase:** EXIT y AUDIT quedan en cero.",
      "**Validación de fase:** p.ej. el caso vacío, o la versión 25.6.1.",
      "**Validación de fase:** RR.HH. y EE.UU. aprueban el cambio.",
    ]) {
      const failures = validatePlanSourceBoundary(phaseWith(clause), ["cli"]);
      expect(
        failures.map((failure) => failure.code),
        clause,
      ).toEqual(["PLAN_SOURCE_LOCAL_PROOF_MISSING"]);
      expect(failures[0]?.message).toContain("citá el comando con sus argumentos");
    }
  });

  it("lee entera una cláusula partida en columna 0 y corta en el bloque siguiente", () => {
    expect(
      codes(
        phaseWith(
          "**Validación de fase:** la cláusula sigue en la línea de abajo, que",
          "nombra `tests/unit/corte.test.ts`.",
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        phaseWith(
          "**Validación de fase:** la cláusula termina acá.",
          "- un ítem nombra `tests/unit/corte.test.ts`, pero es otro bloque.",
        ),
      ),
    ).toEqual(["PLAN_SOURCE_LOCAL_PROOF_MISSING"]);
  });

  it("lee la declaración de fuentes de una tarea partida en columna 0", () => {
    const plan = validPlan.replace(
      "- [ ] T1.1 — Implementar. _(fuentes: cli)_",
      "- [ ] T1.1 — Implementar la pieza\ny dejar su prueba local. _(fuentes: cli)_",
    );
    expect(parsePlanSourceBoundary(plan).phases[0]?.tasks[0]?.sources).toEqual(["cli"]);

    // A block the reader consumes on its own also ends the column-0 fold.
    for (const block of ["```\ncódigo\n```", "> Fuentes: cli"]) {
      const cut = [
        "## Tasks",
        "",
        "### F1 — x",
        "- [ ] T1.1 — Hacer",
        block,
        "y seguir _(fuentes: cli)_",
      ].join("\n");
      expect(parsePlanSourceBoundary(cut).phases[0]?.tasks[0]?.sources, block).toBeNull();
    }
  });

  it("recorre la tabla de superficie remota de una cláusula, fila por fila", () => {
    const local = [
      "`src/flow/answer.ts:74` y `docker/Makefile:120`",
      "`pom.xml:277` y `Producto.java:24`",
      "a las 10:30",
      "la imagen `node:20` y `redis:7`",
      "el formato `esquema://host[:puerto]` y `scheme://<host>/x`",
    ];
    const remote = [
      "<https://api.prod.com>",
      "[https://api.prod.com]",
      "http://[fe80::1]:8080/health",
      "`responde ...db:5432`",
      "`//db.prod.internal:5432`",
      "`db.io:5432/x`",
      "`localhost:8080`",
      "`127.0.0.1:5432`",
      "`db.prod.internal:5432`",
      "`api.example.com:443/health`",
      "`db:5432`",
      "https://api.test/usuarios/{id}",
    ];
    for (const fragment of local) {
      expect(
        codes(phaseWith(`**Validación de fase:** ${fragment} con \`npm test\`.`)),
        fragment,
      ).toEqual([]);
    }
    for (const fragment of remote) {
      expect(
        codes(phaseWith(`**Validación de fase:** ${fragment} con \`npm test\`.`)),
        fragment,
      ).toEqual(["PLAN_SOURCE_EXTERNAL_CLOSURE"]);
    }
  });

  it("acepta el límite con una aclaración entre paréntesis y nombra cualquier otro agregado", () => {
    const withSurface = (value: string) =>
      validPlan.replace("> Límite de ejecución: checkout", `> Límite de ejecución: ${value}`);
    expect(validatePlanSourceBoundary(withSurface("checkout (sin remoto)"), ["cli"])).toEqual([]);
    expect(validatePlanSourceBoundary(withSurface("checkout ()"), ["cli"])[0]?.code).toBe(
      "PLAN_SOURCE_BOUNDARY_MISSING",
    );

    const extra = validatePlanSourceBoundary(withSurface("checkout sin remoto"), ["cli"])[0];
    expect(extra?.code).toBe("PLAN_SOURCE_BOUNDARY_MISSING");
    expect(extra?.message).toContain("sobra 'sin remoto'");

    const other = validatePlanSourceBoundary(withSurface("remoto"), ["cli"])[0];
    expect(other?.message).toContain("leyó 'remoto', que no es 'checkout'");
  });
});

/**
 * Real closing clauses of the agent-workflow hub's plans, plus the incident shapes of
 * spec 053, each with the verdict v25.6.1 gave it (`was`). A clause whose verdict
 * this policy changes declares `now` and the rule that moves it; any other
 * change is a regression of the corpus.
 */
describe("SourceBoundaryPolicy — corpus de cláusulas reales", () => {
  interface CorpusEntry {
    from: string;
    kind: "task" | "phase-validation" | "phase-exit" | "plan-validation";
    lines: string[];
    was: string;
    now?: string;
    rule?: string;
  }
  const RULES = new Set([
    "archivo-sin-ruta",
    "nombre-de-test",
    "continuacion-en-columna-0",
    "archivo-con-linea",
    "ruta-con-linea",
    "hora-o-razon",
    "tag-de-imagen",
    "esquema-generico",
  ]);
  const corpus = JSON.parse(
    readFileSync(new URL("../fixtures/plan-clauses/clauses.json", import.meta.url), "utf8"),
  ) as CorpusEntry[];
  const compose = ({ kind, lines }: CorpusEntry): string => {
    const [first = "", ...rest] = lines;
    if (kind === "plan-validation")
      return ["# P", "", "## Validations", "", `- ${first}`, ...rest].join("\n");
    const head = ["# P", "", "## Tasks", "", "### F1 — x", "> Fuentes: cli", ""];
    if (kind === "task")
      return [...head, `- [ ] T1.1 — ${first} _(fuentes: cli)_`, ...rest].join("\n");
    return [...head, ...lines].join("\n");
  };
  const verdictOf = (entry: CorpusEntry): string =>
    validateSourceBoundedSemantics(compose(entry))[0]?.code ?? "ok";

  it("cubre comandos, rutas, términos del compat, prosa en columna 0, citas con línea y remotos", () => {
    const kinds = new Set(corpus.map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual([
      "phase-exit",
      "phase-validation",
      "plan-validation",
      "task",
    ]);
    expect(
      corpus.some(
        (entry) => entry.was === "PLAN_SOURCE_EXTERNAL_CLOSURE" && entry.now === undefined,
      ),
    ).toBe(true);
    expect(
      new Set(corpus.flatMap((entry) => (entry.rule === undefined ? [] : [entry.rule]))),
    ).toEqual(RULES);
  });

  it("cambia sólo los veredictos que declara, cada uno por una regla de esta política", () => {
    const drift = corpus
      .filter((entry) => verdictOf(entry) !== (entry.now ?? entry.was))
      .map((entry) => ({
        from: entry.from,
        clause: entry.lines[0],
        expected: entry.now ?? entry.was,
        actual: verdictOf(entry),
      }));
    expect(drift).toEqual([]);
  });
});
