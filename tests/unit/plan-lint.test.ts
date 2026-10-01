// `aw plan lint`: la gramática entera de un plan, sin sesión y sin intento.
//
// Lo que se fija acá es el escenario «prevalidar un plan» de la spec 053: un plan
// de siete cláusulas de cierre con dos sin prueba local devuelve exactamente esas
// dos, con su línea y su regla, y sale con 2 — sin crear sesión ni tocar corrida.
// Y que el lint no puede discrepar de los gates: llama a las mismas funciones que
// la publicación y la entrada a ejecución, con y sin bloque WORKSPACE.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  lintPlan,
  planGrammarAtEntry,
  planGrammarAtPublication,
} from "../../src/application/plan-lint-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { planCommand } from "../../src/cli/commands/plan.js";
import { groupCommands } from "../../src/cli/help-groups.js";
import { parseArgv } from "../../src/cli/parser.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const fs = new NodeFileSystem();
const SPEC = "docs/specs/053-spec-lint.md";
const PLAN = "docs/plans/055-plan-lint.md";
const RUN = ".workflow/sessions/210-otra-plan-exec/.flow-run.json";

const WORKSPACE_BLOCK = [
  "<!-- AGENT-WORKFLOW-HUB-START -->",
  "## Hub",
  "",
  "El lint.",
  "",
  "## Fuentes",
  "",
  "| Alias | Path | Rama principal |",
  "|---|---|---|",
  "| cli | /tmp/cli | main |",
  "",
  "## Pipeline",
  "",
  "- cli: build `npm run build` · test `npm test`",
  "",
  "<!-- AGENT-WORKFLOW-HUB-END -->",
  "",
].join("\n");

/** Siete cláusulas de cierre; las de las líneas 20 y 30 no nombran ninguna comprobación. */
const PLAN_TEXT = [
  "# Plan 055 — lint",
  "",
  `> Derived from ${SPEC}`,
  "> Estado: open",
  "> Límite de ejecución: checkout",
  "",
  "## Tasks",
  "",
  "### F1 — referentes",
  "> Fuentes: cli",
  "",
  "- [ ] T1.1 — ampliar el referente _(fuentes: cli)_",
  "",
  "**Validación de fase:** `npx vitest run tests/unit/a.test.ts` pasa.",
  "**Condición de salida:** el corpus no cambia de veredicto.",
  "",
  "### F2 — linaje",
  "> Fuentes: cli",
  "",
  "**Validación de fase:** la rúbrica queda verde.",
  "**Condición de salida:** ningún plan sale sin sello.",
  "",
  "- [ ] T2.1 — sellar _(fuentes: cli)_",
  "",
  "## Validations",
  "",
  "- AC-15: `npx vitest run tests/unit/a.test.ts` cubre los referentes.",
  "- AC-18: `npx vitest run tests/unit/b.test.ts` cubre el linaje.",
  "",
  "- AC-04: la spec queda cubierta.",
  "",
].join("\n");

describe("aw plan lint — la gramática entera de un plan, sin corrida", () => {
  it("rechaza una cabecera de aislamiento mal escrita antes de ejecutarla", () => {
    const invalid = PLAN_TEXT.replace(
      "> Límite de ejecución: checkout",
      "> Límite de ejecución: checkout\n> Aislamiento: unidadd",
    );
    expect(planGrammarAtEntry(invalid, ["cli"]).map((failure) => failure.code)).toContain(
      "PLAN_ISOLATION_INVALID",
    );
    expect(
      planGrammarAtEntry(invalid.replace("unidadd", "unidad"), ["cli"]).map(
        (failure) => failure.code,
      ),
    ).not.toContain("PLAN_ISOLATION_INVALID");
  });
  let root: string;
  let paths: PathsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-plan-lint-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    await mkdir(join(root, "docs/specs"), { recursive: true });
    await mkdir(join(root, "docs/plans"), { recursive: true });
    await mkdir(join(root, ".workflow/sessions/210-otra-plan-exec"), { recursive: true });
    await writeFile(join(root, SPEC), "# Spec 053 — lint\n\n## Requirement\n\nlint\n", "utf8");
    await writeFile(join(root, PLAN), PLAN_TEXT, "utf8");
    await writeFile(join(root, RUN), '{"version":2}\n', "utf8");
    await writeFile(join(root, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = (target: string) =>
    planCommand.execute(parseArgv(["plan", "lint", target]), {
      fs,
      env: new FakeEnv(root, root),
      paths,
      git: undefined,
      runtime: undefined,
    } as unknown as Parameters<typeof planCommand.execute>[1]);

  it("devuelve exactamente las dos cláusulas sin prueba local, con su regla, y sale con 2", async () => {
    const sessionsBefore = await readdir(join(root, ".workflow/sessions"));
    const result = await run(PLAN);

    expect(result.exitCode).toBe(2);
    const violations = result.data?.violations ?? [];
    expect(violations.map((v) => [v.code, v.line, v.moment])).toEqual([
      ["PLAN_SOURCE_LOCAL_PROOF_MISSING", 20, "both"],
      ["PLAN_SOURCE_LOCAL_PROOF_MISSING", 30, "both"],
    ]);
    for (const violation of violations) {
      expect(violation.message).toContain("citá el comando con sus argumentos");
      expect(violation.rule).toContain("nombrá en esa cláusula el comando");
    }
    // Ni sesión nueva ni corrida tocada.
    expect(await readdir(join(root, ".workflow/sessions"))).toEqual(sessionsBefore);
    expect(await readFile(join(root, RUN), "utf8")).toBe('{"version":2}\n');
  });

  it("por correlativo lee el mismo plan, y un plan limpio sale con 0", async () => {
    const clean = PLAN_TEXT.replace(
      "**Validación de fase:** la rúbrica queda verde.",
      "**Validación de fase:** `npx vitest run tests/unit/b.test.ts` pasa.",
    ).replace(
      "- AC-04: la spec queda cubierta.",
      "- AC-04: `npx vitest run tests/unit/c.test.ts`.",
    );
    await writeFile(join(root, PLAN), clean, "utf8");
    const result = await run("055");
    expect(result.data?.plan).toBe(PLAN);
    expect(result.data?.violations).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(planCommand.renderHuman?.(result, { detail: false })).toContain(
      "sin violaciones de la gramática",
    );
  });

  it("rechaza tests sin build en lint y en la publicación, con línea y fuente", async () => {
    await writeFile(
      join(root, "CLAUDE.md"),
      WORKSPACE_BLOCK.replace("build `npm run build`", "build ninguno"),
    );
    const text = `${PLAN_TEXT}\n- Validación final · \`cli\` · tests \`npm test\``;
    await writeFile(join(root, PLAN), text);
    const line = text.split("\n").length;

    const lint = await lintPlan(fs, paths, PLAN);
    if (!lint.ok) throw new Error(lint.failure.message);
    expect(lint.report.violations).toContainEqual(
      expect.objectContaining({
        code: "PLAN_FINAL_VALIDATION_INCOMPLETE",
        line,
        message: expect.stringContaining("cli"),
        moment: "publication",
      }),
    );
    const publication = await planGrammarAtPublication(
      fs,
      root,
      text,
      ["cli"],
      "docs/specs",
      paths,
    );
    expect(publication.failures).toContainEqual(
      expect.objectContaining({ code: "PLAN_FINAL_VALIDATION_INCOMPLETE", line }),
    );
  });

  it("localiza en la fase la fuente sin pipeline ni viñeta final", async () => {
    await writeFile(join(root, "CLAUDE.md"), WORKSPACE_BLOCK.replace("## Pipeline", "## Otro"));
    const report = await lintPlan(fs, paths, PLAN);
    if (!report.ok) throw new Error(report.failure.message);
    expect(report.report.violations).toContainEqual(
      expect.objectContaining({
        code: "PLAN_FINAL_VALIDATION_INCOMPLETE",
        line: 9,
        message: expect.stringContaining("'cli' no resuelve build y tests"),
      }),
    );
  });

  it("rechaza build y tests repartidos entre viñetas, aunque el pipeline sea completo", async () => {
    const text = `${PLAN_TEXT}\n- Validación final · \`cli\` · build \`npm run build\`\n- Validación final · \`cli\` · tests \`npm test\``;
    await writeFile(join(root, PLAN), text);
    const line = text.split("\n").length;

    const lint = await lintPlan(fs, paths, PLAN);
    if (!lint.ok) throw new Error(lint.failure.message);
    expect(lint.report.violations).toContainEqual(
      expect.objectContaining({
        code: "PLAN_FINAL_VALIDATION_SPLIT",
        line,
        message: expect.stringContaining("cli"),
        moment: "both",
      }),
    );
    const publication = await planGrammarAtPublication(
      fs,
      root,
      text,
      ["cli"],
      "docs/specs",
      paths,
    );
    expect(publication.failures).toContainEqual(
      expect.objectContaining({ code: "PLAN_FINAL_VALIDATION_SPLIT", line }),
    );
  });

  it("acepta el pipeline versionado completo sin repetir comandos en el plan", async () => {
    const text = PLAN_TEXT.replace(
      "**Validación de fase:** la rúbrica queda verde.",
      "**Validación de fase:** `npm test` pasa.",
    ).replace("- AC-04: la spec queda cubierta.", "- AC-04: `npm test` pasa.");
    await writeFile(join(root, PLAN), text);
    const lint = await lintPlan(fs, paths, PLAN);
    if (!lint.ok) throw new Error(lint.failure.message);
    expect(lint.report.violations).toEqual([]);
    expect(
      (await planGrammarAtPublication(fs, root, text, ["cli"], "docs/specs", paths)).failures,
    ).toEqual([]);
  });

  it("acepta el pase operativo sin tratar su texto remoto como cierre", async () => {
    const clean = PLAN_TEXT.replace(
      "**Validación de fase:** la rúbrica queda verde.",
      "**Validación de fase:** `npx vitest run tests/unit/b.test.ts` pasa.",
    ).replace(
      "- AC-04: la spec queda cubierta.",
      "- AC-04: `npx vitest run tests/unit/c.test.ts`.",
    );
    await writeFile(
      join(root, PLAN),
      `${clean}\n## Handoff operativo\n\n- Pase a PROD: corte-1\n- [ ] legada: deploy https://example.org\n`,
    );
    const result = await run(PLAN);
    expect(result.exitCode).toBe(0);
    expect(result.data?.violations).toEqual([]);
  });

  it("la proyección humana nombra línea, código, gate y regla de cada violación", async () => {
    const result = await run(PLAN);
    const human = planCommand.renderHuman?.(result, { detail: false }) ?? "";
    expect(human).toContain(`${PLAN}:20 PLAN_SOURCE_LOCAL_PROOF_MISSING [both]`);
    expect(human).toContain("→ nombrá en esa cláusula el comando");
  });

  it("reparte cada violación en el momento que la juzga, con y sin bloque WORKSPACE", async () => {
    // Un alias fuera del bloque y un plan sin linaje: lo que cada gate juzga cambia
    // con el bloque, y el lint tiene que decir lo mismo que cada uno.
    const drifted = PLAN_TEXT.replace(`> Derived from ${SPEC}\n`, "").replace(
      "### F2 — linaje\n> Fuentes: cli",
      "### F2 — linaje\n> Fuentes: otra",
    );
    await writeFile(join(root, PLAN), drifted, "utf8");

    for (const declared of [["cli"], null] as const) {
      if (declared === null) await rm(join(root, "CLAUDE.md"));
      const publication = await planGrammarAtPublication(
        fs,
        root,
        drifted,
        declared,
        "docs/specs",
        paths,
      );
      const entry = planGrammarAtEntry(drifted, declared);
      const report = await lintPlan(fs, paths, PLAN);
      if (!report.ok) throw new Error(report.failure.message);

      const key = (f: { code: string; line?: number | null }) => `${f.code}@${f.line ?? ""}`;
      const lintAt = (moment: "publication" | "execution-entry") =>
        report.report.violations
          .filter((v) => v.moment === moment || v.moment === "both")
          .map(key)
          .sort();
      expect(lintAt("publication"), String(declared)).toEqual(publication.failures.map(key).sort());
      expect(lintAt("execution-entry"), String(declared)).toEqual(entry.map(key).sort());
      expect(report.report.hub_block).toBe(declared !== null);
    }
  });

  it("el comando está registrado y vive en la familia del linaje", () => {
    expect(ALL_COMMANDS.map((command) => command.name)).toContain("plan");
    const group = groupCommands(ALL_COMMANDS.map((command) => command.name)).find((entry) =>
      entry.commands.includes("plan"),
    );
    expect(group?.commands).toEqual(expect.arrayContaining(["reseal", "amend", "settle", "plan"]));
  });

  it("un plan ausente, ambiguo o que no es un Markdown de plan se rechaza con su código", async () => {
    const codeOf = async (target: string) => {
      const result = await lintPlan(fs, paths, target);
      return result.ok ? null : result.failure.code;
    };
    expect(await codeOf("999")).toBe("PLAN_LINT_PLAN_ABSENT");
    expect(await codeOf("docs/plans/999-plan-x.md")).toBe("PLAN_LINT_PLAN_ABSENT");
    await writeFile(join(root, "docs/plans/055-plan-otro.md"), PLAN_TEXT, "utf8");
    expect(await codeOf("055")).toBe("PLAN_LINT_TARGET_AMBIGUOUS");
    await writeFile(join(root, "docs/plans/057-notas.txt"), PLAN_TEXT, "utf8");
    expect(await codeOf("docs/plans/057-notas.txt")).toBe("PLAN_LINT_TARGET_INVALID");
  });

  it("una acción desconocida, sin plan o con argumentos de más se rechaza con el uso", async () => {
    const extra = await planCommand.execute(parseArgv(["plan", "lint", PLAN, "otro"]), {
      fs,
      env: new FakeEnv(root, root),
      paths,
    } as unknown as Parameters<typeof planCommand.execute>[1]);
    expect(extra.ok).toBe(false);
    const result = await planCommand.execute(parseArgv(["plan", "check", PLAN]), {
      fs,
      env: new FakeEnv(root, root),
      paths,
    } as unknown as Parameters<typeof planCommand.execute>[1]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("plan lint <ruta del plan|correlativo>");
  });
});
