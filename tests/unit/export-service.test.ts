import { describe, expect, it } from "vitest";
import { readClaimEvents } from "../../src/application/claims-ledger.js";
import {
  type ExportCategory,
  type ExportPrepared,
  type ExportSelection,
  SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS,
  applyExport,
  conflictingScopeFlags,
  prepareExport,
  readExportScope,
  validateExport,
} from "../../src/application/export-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { exportScriptsCommand } from "../../src/cli/commands/export.js";
import { commandHelpText } from "../../src/cli/help-groups.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const env = new FakeEnv("/home", "/cwd");
const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
const DATE = "2026-07-29";

function workspace(): MemFs {
  const fs = new MemFs();
  fs.file(
    "/cwd/.workflow/sessions/040-algo-plan-exec/SESSION.md",
    "# SESSION\n\n## Objective\nalgo\n",
  );
  fs.file("/cwd/.workflow/sessions/040-algo-plan-exec/.closed", "");
  fs.file(
    "/cwd/.workflow/sessions/040-algo-plan-exec/SCRIPTS.sql",
    "CREATE TABLE algo (id integer);\n",
  );
  return fs;
}

function closedSession(fs: MemFs, folder: string): void {
  fs.file(`/cwd/.workflow/sessions/${folder}/SESSION.md`, "# SESSION\n\n## Objective\notra\n");
  fs.file(`/cwd/.workflow/sessions/${folder}/.closed`, "");
}

async function prepare(
  fs: MemFs,
  category: ExportCategory,
  selection: ExportSelection = { date: DATE },
  now?: () => Date,
): Promise<ExportPrepared> {
  const result = await prepareExport(fs, env, paths(), category, selection, now);
  if (!result.ok) throw new Error(`expected prepare to succeed: ${result.failure.message}`);
  return result.value;
}

function answer(
  prepared: ExportPrepared,
  files: Array<[string, string]>,
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    operation: `export-${prepared.category}`,
    input_digest: prepared.request.input_digest,
    state: "proposed",
    scope: prepared.scope,
    ...(prepared.category === "scripts" ? { decisions: { supersedes: [], requires: [] } } : {}),
    artifacts: files.map(([path, content]) => ({ path, content })),
    ...over,
  });
}

/**
 * What `validate` and `apply` do at the command layer: rebuild the preparation
 * from the scope the ANSWER echoes, not from the flags of this invocation.
 * Everything the workspace can move meanwhile is re-read; nothing else is.
 */
async function restage(
  fs: MemFs,
  category: ExportCategory,
  raw: string,
  now?: () => Date,
): Promise<ExportPrepared> {
  const echoed = readExportScope(raw);
  if (!echoed.ok) throw new Error(`expected a readable scope: ${echoed.failure.message}`);
  if (echoed.value === null) throw new Error("expected the answer to echo its scope");
  return await prepare(fs, category, echoed.value, now);
}

const clock = (iso: string) => (): Date => new Date(iso);

function dossier(prepared: ExportPrepared, extra: Array<[string, string]> = []) {
  return [
    [`${prepared.unit}/README.md`, "# Dossier\n\nqué contiene\n"] as [string, string],
    ...extra,
  ];
}

function approvalOf(prepared: ExportPrepared, raw: string): string {
  const validated = validateExport(raw, prepared);
  if (!validated.ok) throw new Error(`expected it to validate: ${validated.failure.message}`);
  return validated.value.approval_digest;
}

// ── corpus ───────────────────────────────────────────────────────────────────

describe("prepareExport — the corpus decides whether there is anything to export", () => {
  it("rechaza un corpus vacío en vez de publicar un dossier hueco", async () => {
    const fs = new MemFs();
    fs.file("/cwd/.workflow/sessions/.keep", "");
    const result = await prepareExport(fs, env, paths(), "manuals", { date: DATE });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("EXPORT_CORPUS_EMPTY");
    expect(result.failure.action).toContain("--since");
  });

  it("no escribe nada al preparar", async () => {
    const fs = workspace();
    await prepare(fs, "diagrams");
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("cada categoría declara SOLO su carpeta como destino", async () => {
    const fs = workspace();
    for (const category of ["diagrams", "manuals", "reports", "scripts"] as ExportCategory[]) {
      const prepared = await prepare(fs, category);
      for (const destination of prepared.request.allowed_destinations) {
        expect(destination.startsWith(`docs/${category}`)).toBe(true);
      }
    }
  });
});

// ── per-category shape ───────────────────────────────────────────────────────

describe("validateExport — each category enforces its own shape", () => {
  it("un informe indivisible supera 512 KiB; un forward grande indica cómo partirlo", async () => {
    const fs = workspace();
    const report = await prepare(fs, "reports");
    const largeReport = validateExport(
      answer(report, [
        [`${report.dir}/${report.next}-informe.md`, `# Informe\n${"a".repeat(600_000)}`],
      ]),
      report,
    );
    expect(largeReport.ok).toBe(true);
    const scripts = await prepare(fs, "scripts");
    const raw = answer(scripts, [
      [`${scripts.unit}/README.md`, "# Bundle\n"],
      [`${scripts.unit}/rollback/00-global/00-ROLLBACK.sql`, "-- rollback\n"],
      [`${scripts.unit}/01-ddl-tablas/01-forward.sql`, `-- forward\n${"x".repeat(600_000)}`],
    ]);
    const invalid = validateExport(raw, scripts);
    expect(invalid).toMatchObject({
      ok: false,
      failure: {
        code: "EXPORT_LIMIT_EXCEEDED",
        message: expect.stringContaining("524288"),
        action: expect.stringContaining("partí"),
      },
    });
    const globalRollback = validateExport(
      answer(scripts, [
        [`${scripts.unit}/README.md`, "# Bundle\n"],
        [
          `${scripts.unit}/rollback/00-global/00-ROLLBACK.sql`,
          `-- rollback\n${"x".repeat(600_000)}`,
        ],
        [`${scripts.unit}/01-ddl-tablas/01-forward.sql`, "CREATE TABLE esq.nueva (id int);\n"],
        [
          `${scripts.unit}/rollback/01-ddl-tablas/01-forward.rollback.sql`,
          "DROP TABLE esq.nueva;\n",
        ],
      ]),
      scripts,
    );
    expect(globalRollback.ok).toBe(true);
  });
  it("diagrams exige README y admite Markdown más DSL", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const ok = validateExport(
      answer(prepared, dossier(prepared, [[`${prepared.unit}/c4.dsl`, "workspace {}\n"]])),
      prepared,
    );
    expect(ok.ok).toBe(true);

    const missing = validateExport(
      answer(prepared, [[`${prepared.unit}/c4.dsl`, "workspace {}\n"]]),
      prepared,
    );
    if (missing.ok) throw new Error("expected a rejection");
    expect(missing.failure.message).toContain("README.md");
  });

  it("publica un diagrama Graphviz de un corpus local sin exigir C4 ni Mermaid", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const source = "digraph flujo { Cliente -> API -> BaseDeDatos }\n";
    const raw = answer(prepared, dossier(prepared, [[`${prepared.unit}/flujo.dot`, source]]));
    const checked = validateExport(raw, prepared);
    if (!checked.ok) throw new Error(checked.failure.message);
    const published = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: checked.value.approval_digest,
    });
    if (!published.ok) throw new Error(published.failure.message);
    expect(await fs.readText(`/cwd/${prepared.unit}/flujo.dot`)).toBe(source);
    expect(published.value.written).toEqual([
      `${prepared.unit}/README.md`,
      `${prepared.unit}/flujo.dot`,
    ]);
  });

  it("reports publica UN documento, no un dossier", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "reports");
    const result = validateExport(
      answer(prepared, [
        ["docs/reports/001-informe-x-2026-07-29.md", "# Informe\n\nAudiencia: dirección\n"],
        ["docs/reports/001-informe-y-2026-07-29.md", "# Otro\n"],
      ]),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("UN documento");
  });

  it("reports exige el número preparado en la ruta del documento", async () => {
    const prepared = await prepare(workspace(), "reports");
    const bad = validateExport(
      answer(prepared, [["docs/reports/002-informe.md", "# Informe\n"]]),
      prepared,
    );
    if (bad.ok) throw new Error("expected wrong number to be refused");
    expect(bad.failure.message).toContain("001-<slug>.md");
  });

  it("scripts exige rollback global, acoplados y forwards numerados dentro de cada categoría", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "scripts");
    const complete = dossier(prepared, [
      [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "-- rollback\n"],
      [`${prepared.unit}/01-ddl-tablas/01-crear-tabla.sql`, "-- forward\n"],
      [`${prepared.unit}/rollback/01-ddl-tablas/01-crear-tabla.rollback.sql`, "-- reverse\n"],
      [`${prepared.unit}/01-ddl-tablas/02-indices.sql`, "-- forward\n"],
      [`${prepared.unit}/rollback/01-ddl-tablas/02-indices.rollback.sql`, "-- reverse\n"],
    ]);
    expect(validateExport(answer(prepared, complete), prepared).ok).toBe(true);

    const gap = dossier(prepared, [
      [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "-- rollback\n"],
      [`${prepared.unit}/01-ddl-tablas/01-crear-tabla.sql`, "-- forward\n"],
      [`${prepared.unit}/rollback/01-ddl-tablas/01-crear-tabla.rollback.sql`, "-- reverse\n"],
      [`${prepared.unit}/01-ddl-tablas/03-indices.sql`, "-- forward\n"],
      [`${prepared.unit}/rollback/01-ddl-tablas/03-indices.rollback.sql`, "-- reverse\n"],
    ]);
    const broken = validateExport(answer(prepared, gap), prepared);
    if (broken.ok) throw new Error("expected a rejection");
    expect(broken.failure.message).toContain("continua");

    const noRollback = dossier(prepared, [
      [`${prepared.unit}/01-ddl-tablas/01-crear-tabla.sql`, "-- forward\n"],
    ]);
    const missing = validateExport(answer(prepared, noRollback), prepared);
    if (missing.ok) throw new Error("expected a rejection");
    expect(missing.failure.message).toContain("00-ROLLBACK.sql");
  });

  it("rechaza juntos rollback mal ubicado, forward sin reverse, huérfano y SQL de raíz", async () => {
    const prepared = await prepare(workspace(), "scripts");
    const result = validateExport(
      answer(
        prepared,
        dossier(prepared, [
          [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "DROP TABLE t;"],
          [`${prepared.unit}/01-ddl-tablas/01-tabla.sql`, "CREATE TABLE t (id int);"],
          [`${prepared.unit}/01-ddl-tablas/01-tabla.rollback.sql`, "DROP TABLE t;"],
          [`${prepared.unit}/rollback/01-ddl-tablas/02-otra.rollback.sql`, "DROP TABLE otra;"],
          [`${prepared.unit}/rollback/03-suelto.sql`, "-- reverse"],
          [`${prepared.unit}/02-raiz.sql`, "-- forward"],
        ]),
      ),
      prepared,
    );
    if (result.ok) throw new Error("expected invalid bundle layout");
    for (const token of [
      "01-tabla.rollback.sql",
      "huérfano",
      "rollback/03-suelto.sql",
      "02-raiz.sql",
    ]) {
      expect(result.failure.message).toContain(token);
    }
  });

  it("README y RUNBOOK rechazan juntos citas ausentes pero reconocen bundle.json", async () => {
    const prepared = await prepare(workspace(), "scripts");
    const result = validateExport(
      answer(prepared, [
        [
          `${prepared.unit}/README.md`,
          "# Aplicar\n\n`01-ddl-tablas/01-tabla.sql` y `falta.sql`; manifiesto `bundle.json`.",
        ],
        [`${prepared.unit}/RUNBOOK.md`, "[Ver guía](guia.md)"],
        [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "DROP TABLE t;"],
        [`${prepared.unit}/01-ddl-tablas/01-tabla.sql`, "CREATE TABLE t (id int);"],
        [`${prepared.unit}/rollback/01-ddl-tablas/01-tabla.rollback.sql`, "DROP TABLE t;"],
      ]),
      prepared,
    );
    if (result.ok) throw new Error("expected missing cited files");
    expect(result.failure.message).toContain("falta.sql");
    expect(result.failure.message).toContain("guia.md");
    expect(result.failure.message).not.toContain("bundle.json");
  });

  it("rechaza una extensión fuera de la categoría", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const result = validateExport(
      answer(prepared, dossier(prepared, [[`${prepared.unit}/notas.sql`, "select 1;\n"]])),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("extensión");
  });

  it("rechaza un archivo vacío", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const result = validateExport(
      answer(prepared, [[`${prepared.unit}/README.md`, "   \n"]]),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("vacío");
  });

  it("rechaza escribir en la carpeta de otra categoría", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const result = validateExport(
      answer(prepared, [["docs/manuals/README.md", "# Ajeno\n"]]),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_PATH_REJECTED");
  });

  it("el preview es determinista: mismo digest de aprobación en dos pasadas", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, dossier(prepared));
    expect(approvalOf(prepared, raw)).toBe(approvalOf(prepared, raw));
  });
});

// ── publication ──────────────────────────────────────────────────────────────

describe("applyExport — publishes the dossier as a unit, or nothing", () => {
  it("manuals complement publica sólo INDEX.md sin dossier", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, [["docs/manuals/INDEX.md", "# Manuales\n\nListado actual\n"]]);
    const checked = validateExport(raw, prepared);
    if (!checked.ok) throw new Error(checked.failure.message);
    expect(checked.value.preview.mode).toBe("complement");
    expect(checked.value.preview.destination).toBe("docs/manuals");
    const published = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: checked.value.approval_digest,
    });
    if (!published.ok) throw new Error(published.failure.message);
    expect(published.value.written).toEqual(["docs/manuals/INDEX.md"]);
    expect(await fs.exists(`/cwd/${prepared.unit}/README.md`)).toBe(false);
  });

  it("manuals planos listan todos los reemplazos y exigen --overwrite sólo para ellos", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/manuals/guia.md", "# Vieja\n");
    fs.file("/cwd/docs/manuals/operacion.md", "# Vieja\n");
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, [
      ["docs/manuals/guia.md", "# Guía nueva\n"],
      ["docs/manuals/operacion.md", "# Operación nueva\n"],
      ["docs/manuals/nuevo.md", "# Nuevo\n"],
    ]);
    const checked = validateExport(raw, prepared);
    if (!checked.ok) throw new Error(checked.failure.message);
    expect(checked.value.preview.mode).toBe("flat");
    expect(checked.value.preview.replacements).toEqual([
      "docs/manuals/guia.md",
      "docs/manuals/operacion.md",
    ]);
    const denied = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: checked.value.approval_digest,
    });
    if (denied.ok) throw new Error("expected explicit overwrite");
    expect(denied.failure.code).toBe("OVERWRITE_NOT_AUTHORIZED");
    const published = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: checked.value.approval_digest,
      allowOverwrite: true,
    });
    if (!published.ok) throw new Error(published.failure.message);
    expect(await fs.readText("/cwd/docs/manuals/guia.md")).toBe("# Guía nueva\n");
    expect(await fs.readText("/cwd/docs/manuals/nuevo.md")).toBe("# Nuevo\n");
  });

  it("publica el dossier con el número asignado dentro del lock", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/manuals/001-export-manuals-2026-01-01/README.md", "# Viejo\n");
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, dossier(prepared, [[`${prepared.unit}/guia.md`, "# Guía\n"]]));

    const result = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });
    if (!result.ok) throw new Error(`expected it to apply: ${result.failure.message}`);
    expect(result.value.written).toEqual([
      `docs/manuals/002-export-manuals-${DATE}/README.md`,
      `docs/manuals/002-export-manuals-${DATE}/guia.md`,
    ]);
    expect(await fs.readText("/cwd/docs/manuals/001-export-manuals-2026-01-01/README.md")).toBe(
      "# Viejo\n",
    );
  });

  it("rechaza el correlativo ocupado por otra fecha sin renumerar ni escribir", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    expect(prepared.unit).toBe(`docs/diagrams/001-export-diagrams-${DATE}`);
    const raw = answer(prepared, dossier(prepared));
    const approval = approvalOf(prepared, raw);

    fs.file("/cwd/docs/diagrams/001-export-diagrams-2026-01-01/README.md", "# Ajeno\n");

    const result = await applyExport(fs, env, paths(), { raw, prepared, approval });
    if (result.ok) throw new Error("expected the approved number to be occupied");
    expect(result.failure.code).toBe("EXPORT_NUMBER_TAKEN");
    expect(result.failure.message).toContain("001-export-diagrams-2026-01-01");
    expect(await fs.exists(`/cwd/docs/diagrams/002-export-diagrams-${DATE}`)).toBe(false);
    expect(await fs.readText("/cwd/docs/diagrams/001-export-diagrams-2026-01-01/README.md")).toBe(
      "# Ajeno\n",
    );
  });

  it("rechaza un número publicado aunque su carpeta haya sido borrada", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "scripts");
    const raw = answer(
      prepared,
      dossier(prepared, [
        [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "DROP TABLE algo;\n"],
        [`${prepared.unit}/01-ddl-tablas/01-algo.sql`, "CREATE TABLE algo (id integer);\n"],
        [`${prepared.unit}/rollback/01-ddl-tablas/01-algo.rollback.sql`, "DROP TABLE algo;\n"],
      ]),
    );
    fs.file(
      "/cwd/.workflow/HISTORY.md",
      `## Publicaciones\n\n| Documento | Fecha | Comando |\n|-----------|-------|---------|\n| ${prepared.unit}/README.md | 2026-01-01 | export-scripts |\n`,
    );
    const result = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });
    if (result.ok) throw new Error("expected the published number to be unavailable");
    expect(result.failure.code).toBe("EXPORT_NUMBER_TAKEN");
  });

  it("rechaza un correlativo enlazado en el libro de pases aunque no haya carpeta", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const raw = answer(prepared, dossier(prepared));
    const linked = {
      version: 1,
      at: "2026-01-01",
      event: "linked",
      pass_version: "v1",
      artifact: `${prepared.unit}/README.md`,
    };
    fs.file("/cwd/.workflow/release-passes.jsonl", `${JSON.stringify(linked)}\n`);
    const result = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });
    if (result.ok) throw new Error("expected linked number to be refused");
    expect(result.failure.code).toBe("EXPORT_NUMBER_TAKEN");
  });

  it("un approval que no corresponde no escribe un solo byte", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const raw = answer(prepared, dossier(prepared));
    const result = await applyExport(fs, env, paths(), { raw, prepared, approval: "otro" });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("APPROVAL_MISMATCH");
    expect([...fs.writes.keys()]).toEqual([]);
  });

  // The INDEX is the one file an export may replace, and only on purpose.
  it("manuals exige --overwrite para reemplazar INDEX.md", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/manuals/INDEX.md", "# Índice viejo\n");
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, [
      ...dossier(prepared),
      ["docs/manuals/INDEX.md", "# Índice nuevo\n"],
    ]);
    const approval = approvalOf(prepared, raw);

    const denied = await applyExport(fs, env, paths(), { raw, prepared, approval });
    if (denied.ok) throw new Error("expected a rejection");
    expect(denied.failure.code).toBe("OVERWRITE_NOT_AUTHORIZED");
    expect(await fs.readText("/cwd/docs/manuals/INDEX.md")).toBe("# Índice viejo\n");

    const allowed = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval,
      allowOverwrite: true,
    });
    if (!allowed.ok) throw new Error(`expected it to apply: ${allowed.failure.message}`);
    expect(await fs.readText("/cwd/docs/manuals/INDEX.md")).toBe("# Índice nuevo\n");
  });

  // The dossier guarantee: injecting a failure mid-publish leaves ZERO files.
  it("un fallo a mitad de la publicación deja cero archivos finales", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const raw = answer(
      prepared,
      dossier(prepared, [
        [`${prepared.unit}/a.md`, "# A\n"],
        [`${prepared.unit}/boom.md`, "# Boom\n"],
      ]),
    );
    const approval = approvalOf(prepared, raw);

    const realWrite = fs.writeTextExclusive.bind(fs);
    fs.writeTextExclusive = async (path: string, content: string) => {
      if (path.endsWith("/boom.md")) throw new Error("disco lleno");
      return await realWrite(path, content);
    };

    const result = await applyExport(fs, env, paths(), { raw, prepared, approval });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("PUBLISH_FAILED");
    for (const name of ["README.md", "a.md", "boom.md"]) {
      expect(await fs.exists(`/cwd/docs/diagrams/001-export-diagrams-${DATE}/${name}`)).toBe(false);
    }
  });

  it("no toca sesiones ni otra carpeta de docs", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "reports");
    const raw = answer(prepared, [
      ["docs/reports/001-informe-x-2026-07-29.md", "# Informe\n\nAudiencia: dirección\n"],
    ]);
    await applyExport(fs, env, paths(), { raw, prepared, approval: approvalOf(prepared, raw) });

    // The workspace lock is machinery and the index row is the publication's own
    // record — the only two writes outside the category, and naming both here
    // keeps the boundary honest.
    const touched = [...fs.writes.keys()].filter(
      (p) => !p.endsWith("/.lock") && p !== "/cwd/.workflow/HISTORY.md",
    );
    expect(touched.every((p) => p.startsWith("/cwd/docs/reports/"))).toBe(true);
    expect(touched.some((p) => p.includes("/sessions/"))).toBe(false);
    expect(touched.some((p) => p.startsWith("/cwd/docs/reports/"))).toBe(true);
  });

  it("deja su fila en el índice del workspace, sin flujo activo que la escriba", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "reports");
    const raw = answer(prepared, [
      ["docs/reports/001-informe-x-2026-07-29.md", "# Informe\n\nAudiencia: dirección\n"],
    ]);

    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });

    expect(applied.ok).toBe(true);
    const index = await fs.readText("/cwd/.workflow/HISTORY.md");
    expect(index).toContain("## Publicaciones");
    expect(index).toContain("docs/reports/001-informe-x-2026-07-29.md");
    expect(index).toContain("export-reports");
  });
});

// ── the scope travels with what was prepared ─────────────────────────────────

/**
 * The seal used to be computed over everything the re-derivation touched — the
 * corpus, the pending number and the day — so THREE different events rejected a
 * perfectly current answer as stale, and only the first was the invoker's doing.
 * Each is exercised on its own below; the fourth case is the one that must keep
 * failing.
 */
describe("el alcance viaja con lo preparado — los tres disparadores del vencimiento", () => {
  it("(a) validar sin repetir los flags de alcance opera sobre el alcance preparado", async () => {
    const fs = workspace();
    closedSession(fs, "041-otra-plan-exec");
    const prepared = await prepare(fs, "manuals", {
      sessions: ["040-algo-plan-exec"],
      date: DATE,
    });
    expect(prepared.request.read_set).toHaveLength(1);
    const raw = answer(prepared, dossier(prepared));

    // The invocation repeats NOTHING: no --sessions, no --date.
    const second = await restage(fs, "manuals", raw);
    expect(second.request.input_digest).toBe(prepared.request.input_digest);
    expect(validateExport(raw, second).ok).toBe(true);

    // And the counter-proof that the echo is what carried it: a stage that
    // re-derives the scope from an empty invocation sees the other session.
    const rederived = await prepare(fs, "manuals", { date: DATE });
    expect(rederived.request.read_set).toHaveLength(2);
    expect(rederived.request.input_digest).not.toBe(prepared.request.input_digest);
  });

  it("(b) que alguien numere en el destino entre dos etapas ya no vence", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const raw = answer(prepared, dossier(prepared));

    fs.file("/cwd/docs/diagrams/001-export-diagrams-2026-01-01/README.md", "# Ajeno\n");

    const second = await restage(fs, "diagrams", raw);
    expect(second.unit).toBe(prepared.unit);
    expect(second.request.input_digest).toBe(prepared.request.input_digest);
    expect(validateExport(raw, second).ok).toBe(true);
  });

  it("(c) cruzar la medianoche entre preparar y aplicar ya no vence", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams", {}, clock("2026-07-29T23:59:30"));
    expect(prepared.unit).toBe(`docs/diagrams/001-export-diagrams-${DATE}`);
    const raw = answer(prepared, dossier(prepared));

    const second = await restage(fs, "diagrams", raw, clock("2026-07-30T00:00:30"));
    expect(second.unit).toBe(prepared.unit);
    expect(second.request.input_digest).toBe(prepared.request.input_digest);

    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared: second,
      approval: approvalOf(second, raw),
    });
    if (!applied.ok) throw new Error(`expected it to apply: ${applied.failure.message}`);
    expect(applied.value.written).toEqual([`docs/diagrams/001-export-diagrams-${DATE}/README.md`]);
  });

  it("un cambio real del contenido que el alcance abarca sigue venciendo, y dice qué cambió", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    const raw = answer(prepared, dossier(prepared));

    // A session lands inside the scope: what the dossier should have contained
    // is not what it contains.
    closedSession(fs, "041-otra-plan-exec");

    const second = await restage(fs, "diagrams", raw);
    const result = validateExport(raw, second);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_STALE");
    // The seal names the MATERIAL now, not only the session corpus: it covers
    // the loose SQL and the previously published bundles too.
    expect(result.failure.message).toContain("material");
    expect(result.failure.message).toContain("cambió entre preparar y responder");
  });

  it("una invocación que repite los mismos flags en las tres etapas sigue funcionando igual", async () => {
    const fs = workspace();
    const flags = { sessions: ["040-algo-plan-exec"], date: DATE };
    const prepared = await prepare(fs, "manuals", flags);
    const raw = answer(prepared, dossier(prepared));

    const validateStage = await prepare(fs, "manuals", flags);
    expect(validateExport(raw, validateStage).ok).toBe(true);

    const applyStage = await prepare(fs, "manuals", flags);
    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared: applyStage,
      approval: approvalOf(applyStage, raw),
    });
    if (!applied.ok) throw new Error(`expected it to apply: ${applied.failure.message}`);
    expect(applied.value.written).toEqual([`docs/manuals/001-export-manuals-${DATE}/README.md`]);
  });

  it("un sobre sin scope sellado se rechaza por clave faltante", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, dossier(prepared), { scope: undefined });
    const echoed = readExportScope(raw);
    if (!echoed.ok) throw new Error("expected it to read");
    expect(echoed.value).toBeNull();
    const validated = validateExport(raw, prepared);
    if (validated.ok) throw new Error("expected missing scope to fail");
    expect(validated.failure.code).toBe("EXPORT_SCOPE_MISMATCH");
  });

  it("un scope reescrito se rechaza nombrando el campo, no se usa a medias", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, dossier(prepared), {
      scope: { ...prepared.scope, date: "ayer" },
    });
    const echoed = readExportScope(raw);
    if (echoed.ok) throw new Error("expected a rejection");
    expect(echoed.failure.message).toContain("'date'");
  });

  it("detecta claves añadidas, eliminadas y alteradas antes de comparar el digest", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    for (const scope of [
      { ...prepared.scope, extra: "otro" },
      { seal: prepared.scope.seal, next: prepared.scope.next },
      { ...prepared.scope, date: "2026-07-30" },
    ]) {
      const result = validateExport(answer(prepared, dossier(prepared), { scope }), prepared);
      if (result.ok) throw new Error("expected scope mismatch");
      expect(result.failure.message).toMatch(/extra|date/);
    }
  });

  it("el contenido SQL vence el sello, una sesión sin SQL no", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "scripts");
    closedSession(fs, "041-otra-plan-exec");
    const second = await prepare(fs, "scripts");
    expect(second.request.input_digest).toBe(prepared.request.input_digest);
    fs.file(
      "/cwd/.workflow/sessions/040-algo-plan-exec/SCRIPTS.sql",
      "CREATE TABLE algo (id bigint);\n",
    );
    const changed = await prepare(fs, "scripts");
    expect(changed.request.input_digest).not.toBe(prepared.request.input_digest);
  });

  it("un flag de alcance que contradice el sobre se nombra en vez de ignorarse", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals", { sessions: ["040-algo-plan-exec"], date: DATE });
    expect(conflictingScopeFlags(prepared.scope, { date: DATE })).toEqual([]);
    expect(conflictingScopeFlags(prepared.scope, { sessions: ["040-algo-plan-exec"] })).toEqual([]);
    expect(conflictingScopeFlags(prepared.scope, { sessions: ["099-otra"] })).toEqual([
      "--sessions",
    ]);
    expect(conflictingScopeFlags(prepared.scope, { date: "2026-01-01", source: "cli" })).toEqual([
      "--source",
      "--date",
    ]);
  });
});

// ── the envelope, readable before it is attempted ────────────────────────────

describe("el sobre y el rechazo se entienden sin gastar un intento", () => {
  it.each([
    ["version", { version: undefined }],
    ["operation", { operation: undefined }],
    ["input_digest", { input_digest: undefined }],
    ["state", { state: undefined }],
  ])("omitir '%s' nombra el campo que falta", async (field, over) => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const result = validateExport(answer(prepared, dossier(prepared), over), prepared);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_RESPONSE_INVALID");
    expect(result.failure.message).toContain(`falta el campo obligatorio '${field}'`);
  });

  // The old message for a missing `state` was `estado desconocido: undefined`:
  // it named the value, so the reader could not tell `state` from `status`.
  it("un estado inventado sigue siendo un estado inventado", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const result = validateExport(
      answer(prepared, dossier(prepared), { state: "maybe" }),
      prepared,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("estado desconocido: maybe");
  });

  it("la ayuda del comando publica las cabeceras con su nombre exacto", () => {
    const help = [undefined, "prepare", "validate", "apply"]
      .map((action) => commandHelpText(exportScriptsCommand, action))
      .join("\n");
    for (const header of ["version", "operation", "input_digest", "state", "scope", "artifacts"]) {
      expect(help, header).toMatch(new RegExp(`\\b${header}\\b`));
    }
    expect(help).toContain("proposed | ambiguous | unsupported");
    expect(help).toContain("--approval");
  });
});

// ── destination and doctrine ─────────────────────────────────────────────────

describe("el destino de una categoría se alinea con el canon del workspace", () => {
  function withCanon(fs: MemFs, toml: string): MemFs {
    fs.file("/cwd/.workflow/skills.toml", toml);
    return fs;
  }

  it("publica en la carpeta que el workspace declara, sin dejar un árbol paralelo", async () => {
    const fs = withCanon(workspace(), '[docs]\nmanuals = "documentacion/manuales"\n');
    const prepared = await prepare(fs, "manuals");
    expect(prepared.dir).toBe("documentacion/manuales");
    expect(prepared.unit).toBe(`documentacion/manuales/001-export-manuals-${DATE}`);
    // The flat canon and optional INDEX move with the category: one tree, not two.
    expect(prepared.request.allowed_destinations).toEqual([
      prepared.unit,
      "documentacion/manuales",
    ]);

    const raw = answer(prepared, dossier(prepared));
    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });
    if (!applied.ok) throw new Error(`expected it to apply: ${applied.failure.message}`);
    expect(applied.value.written).toEqual([`${prepared.unit}/README.md`]);
    expect(await fs.exists(`/cwd/docs/manuals/001-export-manuals-${DATE}/README.md`)).toBe(false);
  });

  it("el canon configurable también aloja manuales planos sin dossier paralelo", async () => {
    const fs = withCanon(workspace(), '[docs]\nmanuals = "documentacion/manuales"\n');
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, [["documentacion/manuales/guia.md", "# Guía\n"]]);
    const approved = approvalOf(prepared, raw);
    const result = await applyExport(fs, env, paths(), { raw, prepared, approval: approved });
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.written).toEqual(["documentacion/manuales/guia.md"]);
    expect(await fs.exists("/cwd/docs/manuals/guia.md")).toBe(false);
  });

  // El canon volvió configurable la carpeta de la categoría, y la renumeración
  // del apply sustituía el PRIMER `/NNN-` de la ruta entera: con un canon
  // numerado se comía ese número y publicaba en una carpeta que nadie aprobó ni
  // figura en los destinos permitidos — y nada aguas abajo lo re-verifica.
  it("un canon NUMERADO no se come la renumeración: se escribe donde se aprobó", async () => {
    const fs = withCanon(workspace(), '[docs]\nmanuals = "docs/003-manuales"\n');
    const prepared = await prepare(fs, "manuals");
    expect(prepared.unit).toBe(`docs/003-manuales/001-export-manuals-${DATE}`);

    const raw = answer(prepared, dossier(prepared));
    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });
    if (!applied.ok) throw new Error(`expected it to apply: ${applied.failure.message}`);
    for (const written of applied.value.written) {
      expect(written.startsWith("docs/003-manuales/")).toBe(true);
    }
    expect(await fs.exists("/cwd/docs/001-manuales")).toBe(false);
  });

  // El canon mueve documentos, no estado de la herramienta. Una unidad publicada
  // bajo el runtime se llama `NNN-export-…`, así que el workspace pasaría a
  // enumerarla como sesión y quedaría con una línea abierta fantasma.
  it("rechaza un canon que apunta al estado interno de la herramienta", async () => {
    const fs = withCanon(workspace(), '[docs]\nmanuals = ".workflow/sessions"\n');
    const result = await prepareExport(fs, env, paths(), "manuals");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain("oculto");
  });

  it("una fecha malformada se rechaza al preparar, no al validar la respuesta", async () => {
    const result = await prepareExport(fs0(), env, paths(), "manuals", { date: "lunes" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("EXPORT_SCOPE_INVALID");
  });

  it("un workspace que no declara nada conserva el destino de siempre", async () => {
    const prepared = await prepare(withCanon(workspace(), '[docs]\nscripts = "sql"\n'), "manuals");
    expect(prepared.dir).toBe("docs/manuals");
  });

  it("un destino que se escapa del workspace se rechaza, no se corrige solo", async () => {
    const fs = withCanon(workspace(), '[docs]\nmanuals = "../fuera"\n');
    const result = await prepareExport(fs, env, paths(), "manuals", { date: DATE });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("EXPORT_DESTINATION_INVALID");
    expect(result.failure.message).toContain("[docs].manuals");
  });

  it("una categoría que no existe se nombra en vez de no hacer nada", async () => {
    const fs = withCanon(workspace(), '[docs]\nmanueles = "docs/manuales"\n');
    const result = await prepareExport(fs, env, paths(), "manuals", { date: DATE });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("manueles");
  });
});

/**
 * The net-final-state doctrine rides in the CONTRACT and not in the `skills/w`
 * bundle: the bundle's context budget is a frozen gate with ~121 B of headroom
 * and this doctrine is ~700 B, so it would have to be paid for by cutting live
 * doctrine. The contract reaches the same composer at the moment the bundle is
 * written, and its bytes are request bytes, which no frozen gate prices.
 */
describe("la consolidación de scripts declara el estado final neto", () => {
  it("el contrato de scripts publica la doctrina completa", async () => {
    const fs = workspace();
    const contract = (await prepare(fs, "scripts")).request.contract;
    for (const clause of SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS) {
      expect(contract, clause).toContain(clause);
    }
  });

  it("las otras categorías no heredan una doctrina que no es suya", async () => {
    const fs = workspace();
    expect((await prepare(fs, "manuals")).request.contract).not.toContain("ESTADO FINAL NETO");
  });
});

/** Un workspace sin canon declarado, para los casos que no lo necesitan. */
function fs0(): MemFs {
  return workspace();
}

// ── the origin, composed ─────────────────────────────────────────────────────

/**
 * Where the bundle's material comes from stopped being implicit.
 *
 * The command always started from the session corpus and excluded the bundles it
 * had already published. That is still what an invocation with no new flag does
 * — the characterization case below is the one that would catch it changing —
 * and everything else here is what a declared base adds on top of it.
 */
describe("el origen del bundle se compone: base, exclusiones y sello", () => {
  const SCRIPTS = "/cwd/docs/scripts";
  const BUNDLE_A = "002-export-scripts-2026-07-03";
  const BUNDLE_B = "003-export-scripts-2026-07-10";

  function withMaterial(): MemFs {
    const fs = workspace();
    closedSession(fs, "041-otra-plan-exec");
    fs.file(
      "/cwd/.workflow/sessions/041-otra-plan-exec/SCRIPTS.sql",
      "ALTER TABLE algo ADD c integer;\n",
    );
    fs.file(`${SCRIPTS}/${BUNDLE_A}/01-alter.sql`, "ALTER TABLE t ADD c int;");
    fs.file(`${SCRIPTS}/${BUNDLE_A}/00-ROLLBACK.sql`, "ALTER TABLE t DROP COLUMN c;");
    fs.file(`${SCRIPTS}/${BUNDLE_B}/01-drop.sql`, "DROP TABLE t;");
    fs.file(`${SCRIPTS}/${BUNDLE_B}/00-ROLLBACK.sql`, "CREATE TABLE t ();");
    fs.file(`${SCRIPTS}/suelto-limpieza.sql`, "DELETE FROM tmp;");
    return fs;
  }

  interface Inventory {
    origins: string[];
    sessions: Array<{ folder: string }>;
    bundles: Array<{ nnn: string }>;
    standalone_sql: Array<{ name: string }>;
    excluded: Array<{ name: string; origin: string; reason: string }>;
    exclude_unmatched: string[];
  }

  const inventoryOf = (prepared: ExportPrepared): Inventory =>
    prepared.request.inventory as unknown as Inventory;

  function scriptsDossier(prepared: ExportPrepared): Array<[string, string]> {
    return [
      [`${prepared.unit}/README.md`, "# Bundle\n\nqué consolida\n"],
      [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "DROP TABLE t;\n"],
      [`${prepared.unit}/01-ddl-tablas/01-crea.sql`, "CREATE TABLE t ();\n"],
      [`${prepared.unit}/rollback/01-ddl-tablas/01-crea.rollback.sql`, "DROP TABLE t;\n"],
    ];
  }

  it("sin los argumentos nuevos el material es el de siempre: sesiones, y los bundles afuera", async () => {
    const inventory = inventoryOf(await prepare(withMaterial(), "scripts", { date: DATE }));

    expect(inventory.origins).toEqual(["sessions"]);
    expect(inventory.sessions.map((s) => s.folder)).toEqual([
      "040-algo-plan-exec",
      "041-otra-plan-exec",
    ]);
    // The characterization that matters: a workspace full of published bundles
    // and loose SQL produces exactly the corpus it produced before any of this.
    expect(inventory.bundles).toEqual([]);
    expect(inventory.standalone_sql).toEqual([]);
  });

  it("la base de bundles publicados parte de ellos y deja las sesiones afuera", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", { from: "bundles", date: DATE }),
    );

    expect(inventory.origins).toEqual(["bundles"]);
    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002", "003"]);
    expect(inventory.sessions).toEqual([]);
  });

  it("la base de barrido del workspace junta sesiones, SQL suelto y bundles", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", { from: "hub", date: DATE }),
    );

    expect(inventory.origins).toEqual(["sessions", "standalone-sql", "bundles"]);
    expect(inventory.sessions).toHaveLength(2);
    expect(inventory.standalone_sql.map((f) => f.name)).toEqual(["suelto-limpieza.sql"]);
    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002", "003"]);
  });

  it("la exclusión por nombre resta la pieza del material", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", {
        from: "hub",
        exclude: [BUNDLE_B, "041-otra-plan-exec"],
        date: DATE,
      }),
    );

    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002"]);
    expect(inventory.sessions.map((s) => s.folder)).toEqual(["040-algo-plan-exec"]);
    expect(inventory.standalone_sql).toHaveLength(1);
  });

  it("una exclusión que no restó nada se declara, en vez de pasar por cumplida", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", {
        from: "hub",
        exclude: [BUNDLE_B, "099-export-scripts-2026-01-01"],
        date: DATE,
      }),
    );

    // A typo subtracts nothing and, from inside the composition, looks exactly
    // like a piece the filters had already left out. Only saying so keeps the
    // bundle from carrying the very material the person believed they removed.
    expect(inventory.excluded.map((piece) => piece.name)).toEqual([BUNDLE_B]);
    expect(inventory.exclude_unmatched).toEqual(["099-export-scripts-2026-01-01"]);
  });

  it("una exclusión que sí restó no se declara sin efecto", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", {
        from: "hub",
        exclude: [BUNDLE_B],
        date: DATE,
      }),
    );

    expect(inventory.exclude_unmatched).toEqual([]);
  });

  it("el inventario declara los orígenes y lo que quedó dentro y fuera, con el motivo", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", {
        from: "hub",
        exclude: [BUNDLE_B],
        date: DATE,
      }),
    );

    expect(inventory.origins).toEqual(["sessions", "standalone-sql", "bundles"]);
    // Named with its origin and its reason: an exclusion somebody asked for and
    // one the release book imposed look identical in the resulting bundle, and
    // only the first is something the person can take back.
    expect(inventory.excluded).toEqual([
      {
        origin: "bundles",
        name: BUNDLE_B,
        path: `${SCRIPTS}/${BUNDLE_B}`,
        reason: "manual",
      },
    ]);
  });

  it("el sello cubre el material nuevo: un bundle que aparece entre etapas vence la propuesta", async () => {
    const fs = withMaterial();
    const prepared = await prepare(fs, "scripts", { from: "hub", date: DATE });
    const raw = answer(prepared, scriptsDossier(prepared));

    // Under the old seal — the session corpus alone — this bundle appearing
    // changed the material the answer was written against and nothing noticed.
    fs.file(`${SCRIPTS}/004-export-scripts-2026-07-20/01-nuevo.sql`, "CREATE TABLE u ();");
    fs.file(`${SCRIPTS}/004-export-scripts-2026-07-20/00-ROLLBACK.sql`, "DROP TABLE u;");
    const result = validateExport(raw, await restage(fs, "scripts", raw));

    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_STALE");
    expect(result.failure.message).toContain("material");
  });

  it("un byte cambiado en un SQL suelto o de un bundle vence el sello", async () => {
    const fs = withMaterial();
    const before = await prepare(fs, "scripts", { from: "hub", date: DATE });
    fs.file(`${SCRIPTS}/suelto-limpieza.sql`, "DELETE FROM tmp WHERE id = 1;");
    const changedStandalone = await prepare(fs, "scripts", { from: "hub", date: DATE });
    expect(changedStandalone.request.input_digest).not.toBe(before.request.input_digest);
    fs.file(`${SCRIPTS}/${BUNDLE_A}/01-alter.sql`, "ALTER TABLE t ADD d int;");
    const changedBundle = await prepare(fs, "scripts", { from: "hub", date: DATE });
    expect(changedBundle.request.input_digest).not.toBe(changedStandalone.request.input_digest);
    fs.file(`${SCRIPTS}/${BUNDLE_A}/README.md`, "# Revisado\n");
    const changedDossier = await prepare(fs, "scripts", { from: "hub", date: DATE });
    expect(changedDossier.request.input_digest).not.toBe(changedBundle.request.input_digest);
  });

  it("sella bytes de cada archivo del bundle sin decodificar un adjunto binario", async () => {
    const fs = withMaterial();
    fs.binary(`${SCRIPTS}/${BUNDLE_A}/evidencia.bin`, new Uint8Array([0xff, 0]));
    const before = await prepare(fs, "scripts", { from: "bundles", date: DATE });
    fs.binary(`${SCRIPTS}/${BUNDLE_A}/evidencia.bin`, new Uint8Array([0xfe, 0]));
    const after = await prepare(fs, "scripts", { from: "bundles", date: DATE });
    expect(after.request.input_digest).not.toBe(before.request.input_digest);
  });

  it("un alcance contradictorio se rechaza nombrando el flag que lo contradice", async () => {
    const prepared = await prepare(withMaterial(), "scripts", {
      from: "hub",
      exclude: [BUNDLE_B],
      environment: "certificación",
      date: DATE,
    });

    expect(conflictingScopeFlags(prepared.scope, { date: DATE })).toEqual([]);
    expect(conflictingScopeFlags(prepared.scope, { from: "hub", exclude: [BUNDLE_B] })).toEqual([]);
    expect(
      conflictingScopeFlags(prepared.scope, {
        from: "bundles",
        exclude: [BUNDLE_A],
        environment: "producción",
      }),
    ).toEqual(["--exclude", "--from", "--environment"]);
  });

  it("componer el origen es del bundle de SQL, y una base inventada se nombra", async () => {
    const otra = await prepareExport(withMaterial(), env, paths(), "manuals", {
      from: "hub",
      date: DATE,
    });
    if (otra.ok) throw new Error("expected a rejection");
    expect(otra.failure.code).toBe("EXPORT_SCOPE_INVALID");
    expect(otra.failure.message).toContain("export-manuals");

    const inventada = await prepareExport(withMaterial(), env, paths(), "scripts", {
      from: "todo" as never,
      date: DATE,
    });
    if (inventada.ok) throw new Error("expected a rejection");
    expect(inventada.failure.code).toBe("EXPORT_SCOPE_INVALID");
    expect(inventada.failure.message).toContain("--from 'todo'");

    // Belonging beats validity: naming the three bases to a category that never
    // reads one sends the person to fix a value that is rejected all the same.
    const ambas = await prepareExport(withMaterial(), env, paths(), "manuals", {
      from: "todo" as never,
      date: DATE,
    });
    if (ambas.ok) throw new Error("expected a rejection");
    expect(ambas.failure.message).toContain("export-manuals");
  });
});

// ── the environment, subtracting what already ran ────────────────────────────

/**
 * What already ran against the destination is not pending work.
 *
 * The chain that answers it adds no new piece: a pass LINKS the bundle by path
 * and that same pass has an application for the environment. And the two
 * silences the book can return are kept apart on purpose — "no record for this
 * environment" is not "nothing was applied", and only the second would justify
 * handing an operator SQL that is already in place.
 */
describe("el ambiente deja fuera lo que ya consta aplicado", () => {
  const SCRIPTS = "/cwd/docs/scripts";
  const BUNDLE_A = "002-export-scripts-2026-07-03";
  const BUNDLE_B = "003-export-scripts-2026-07-10";
  const CERT = "certificación";

  function withBundles(): MemFs {
    const fs = workspace();
    fs.file(`${SCRIPTS}/${BUNDLE_A}/01-alter.sql`, "ALTER TABLE t ADD c int;");
    fs.file(`${SCRIPTS}/${BUNDLE_A}/00-ROLLBACK.sql`, "ALTER TABLE t DROP COLUMN c;");
    fs.file(`${SCRIPTS}/${BUNDLE_B}/01-drop.sql`, "DROP TABLE t;");
    fs.file(`${SCRIPTS}/${BUNDLE_B}/00-ROLLBACK.sql`, "CREATE TABLE t ();");
    return fs;
  }

  /** A book where `applied` name the bundles that ran in `environment`. */
  function book(fs: MemFs, environment: string, applied: string[]): MemFs {
    const rows: unknown[] = [
      {
        version: 1,
        at: "2026-07-04T10:00:00.000Z",
        event: "declared",
        pass: {
          version: "v1.0.0",
          plans: [{ kind: "plan", key: "047" }],
          sources: ["agent-workflow-cli"],
        },
      },
      ...applied.map((name) => ({
        version: 1,
        at: "2026-07-04T11:00:00.000Z",
        event: "linked",
        pass_version: "v1.0.0",
        artifact: `docs/scripts/${name}`,
      })),
      {
        version: 1,
        at: "2026-07-05T09:00:00.000Z",
        event: "applied",
        pass_version: "v1.0.0",
        application: { environment, detail: "corrido por el DBA", at: "2026-07-05" },
      },
    ];
    fs.file(
      "/cwd/.workflow/release-passes.jsonl",
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    return fs;
  }

  interface Inventory {
    bundles: Array<{ nnn: string }>;
    excluded: Array<{ name: string; origin: string; reason: string }>;
    environment: { name: string; axis: string; scanned: number; excluded: number } | null;
  }

  const inventoryOf = (prepared: ExportPrepared): Inventory =>
    prepared.request.inventory as unknown as Inventory;

  it("con constancia, el bundle que ya corrió sale y el resto se conserva", async () => {
    const fs = book(withBundles(), CERT, [BUNDLE_A]);
    const inventory = inventoryOf(
      await prepare(fs, "scripts", { from: "bundles", environment: CERT, date: DATE }),
    );

    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["003"]);
    // Named with the reason that distinguishes it from an exclusion somebody asked for.
    expect(inventory.excluded).toEqual([
      {
        origin: "bundles",
        name: BUNDLE_A,
        path: `${SCRIPTS}/${BUNDLE_A}`,
        reason: "applied",
      },
    ]);
    expect(inventory.environment).toEqual({
      name: CERT,
      axis: "applied",
      scanned: 2,
      excluded: 1,
    });
  });

  it("sin ninguna constancia para ese ambiente, la ausencia se declara como tal", async () => {
    const fs = book(withBundles(), "producción", [BUNDLE_A]);
    const inventory = inventoryOf(
      await prepare(fs, "scripts", { from: "bundles", environment: CERT, date: DATE }),
    );

    // Nothing left: the book says nothing about THIS environment, and the axis
    // says exactly that instead of letting an empty exclusion list read as
    // "nothing was applied".
    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002", "003"]);
    expect(inventory.excluded).toEqual([]);
    expect(inventory.environment).toEqual({
      name: CERT,
      axis: "no-record",
      scanned: 2,
      excluded: 0,
    });
  });

  it("cuando todo el material consta aplicado, el comando lo dice y no propone un bundle vacío", async () => {
    const fs = book(withBundles(), CERT, [BUNDLE_A, BUNDLE_B]);
    const result = await prepareExport(fs, env, paths(), "scripts", {
      from: "bundles",
      environment: CERT,
      date: DATE,
    });

    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("EXPORT_ORIGIN_ALREADY_APPLIED");
    expect(result.failure.message).toContain(CERT);
    expect(result.failure.action).toContain("--environment");
  });

  it("sobre una base de sesiones el filtro no tiene qué mirar, y lo dice", async () => {
    const fs = book(withBundles(), CERT, [BUNDLE_A]);
    const inventory = inventoryOf(await prepare(fs, "scripts", { environment: CERT, date: DATE }));

    // The SQL still living in a session was never delivered, so it cannot have
    // run: a `scanned` of zero says the filter had nothing to look at.
    expect(inventory.environment).toEqual({ name: CERT, axis: "applied", scanned: 0, excluded: 0 });
    expect(inventory.excluded).toEqual([]);
  });
});

describe("bundle.json · manifiesto derivado y aprobado por el CLI", () => {
  const scripts = "/cwd/docs/scripts";
  const named = "005-retiro-hinovill";

  function withNamedBundle(): MemFs {
    const fs = workspace();
    fs.file(`${scripts}/${named}/01-ddl-tablas/01-legacy.sql`, "CREATE TABLE legacy (id int);");
    fs.file(`${scripts}/suelto.sql`, "ALTER TABLE legacy ADD c int;");
    return fs;
  }

  function proposed(prepared: ExportPrepared, decisions: Record<string, unknown>) {
    return answer(
      prepared,
      dossier(prepared, [
        [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "DROP TABLE legacy;"],
        [`${prepared.unit}/01-ddl-tablas/01-legacy.sql`, "CREATE TABLE legacy (id int, c int);"],
        [`${prepared.unit}/rollback/01-ddl-tablas/01-legacy.rollback.sql`, "DROP TABLE legacy;"],
      ]),
      { decisions },
    );
  }

  it("genera el manifiesto con sha256: de bytes, lo muestra y sella antes de publicar", async () => {
    const fs = withNamedBundle();
    const prepared = await prepare(fs, "scripts", { from: "hub", date: DATE });
    const raw = proposed(prepared, { supersedes: [named], requires: [] });
    const validation = validateExport(raw, prepared);
    if (!validation.ok) throw new Error(validation.failure.message);
    expect(
      validation.value.preview.files.some((file) => file.path === `${prepared.unit}/bundle.json`),
    ).toBe(true);

    const changed = validateExport(
      proposed(prepared, { supersedes: [], requires: [named] }),
      prepared,
    );
    if (!changed.ok) throw new Error(changed.failure.message);
    expect(changed.value.approval_digest).not.toBe(validation.value.approval_digest);

    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: validation.value.approval_digest,
    });
    if (!applied.ok) throw new Error(applied.failure.message);
    const manifest = JSON.parse(await fs.readText(`/cwd/${prepared.unit}/bundle.json`));
    expect(manifest.supersedes).toEqual([named]);
    expect(manifest.requires).toEqual([]);
    expect(manifest.origin.sessions[0]?.files[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.origin.standalone_sql).toMatchObject([{ path: "docs/scripts/suelto.sql" }]);
    expect(manifest.origin.bundles[0]?.files[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rechaza bundles inexistentes, autorreferencia, superado requerido y un bundle.json del agente", async () => {
    const prepared = await prepare(withNamedBundle(), "scripts", { from: "bundles", date: DATE });
    for (const [decisions, needle] of [
      [{ supersedes: ["999-ausente"], requires: [] }, "999-ausente"],
      [{ supersedes: [prepared.unit.split("/").pop()], requires: [] }, "se está publicando"],
      [{ supersedes: [named], requires: [named] }, "superar y requerir"],
    ] as const) {
      const result = validateExport(proposed(prepared, decisions), prepared);
      if (result.ok) throw new Error("expected invalid dependencies");
      expect(result.failure.message).toContain(needle);
    }
    const raw = answer(prepared, [...dossier(prepared), [`${prepared.unit}/bundle.json`, "{}"]], {
      decisions: { supersedes: [], requires: [] },
    });
    const rejected = validateExport(raw, prepared);
    if (rejected.ok) throw new Error("agent-supplied manifest must fail");
    expect(rejected.failure.message).toContain("lo genera el CLI");
  });

  it("prepare señala SQL suelto sin origen y avisos de bundles superados/requeridos", async () => {
    const fs = withNamedBundle();
    const newer = `${scripts}/006-export-scripts-2026-07-01`;
    fs.file(`${scripts}/004-dependencia/01-ddl-tablas/01-dep.sql`, "CREATE TABLE dep (id int);");
    fs.file(`${newer}/01-ddl-tablas/01-new.sql`, "CREATE TABLE new_t (id int);");
    fs.file(
      `${newer}/bundle.json`,
      JSON.stringify({
        supersedes: [named],
        requires: ["004-dependencia"],
        origin: { standalone_sql: [] },
      }),
    );
    const prepared = await prepare(fs, "scripts", {
      from: "bundles",
      environment: "cert",
      date: DATE,
    });
    const inventory = prepared.request.inventory as {
      unbundled_sql: Array<{ name: string }>;
      bundle_warnings: Array<{ code: string }>;
    };
    expect(inventory.unbundled_sql.map((file) => file.name)).toContain("suelto.sql");
    expect(inventory.bundle_warnings.map((warning) => warning.code)).toEqual([
      "BUNDLE_SUPERSEDED",
      "BUNDLE_REQUIRES_UNRECORDED",
    ]);
    const rows = [
      {
        version: 1,
        at: DATE,
        event: "declared",
        pass: { version: "v1", sources: ["cli"], plans: [] },
      },
      {
        version: 1,
        at: DATE,
        event: "linked",
        pass_version: "v1",
        artifact: "docs/scripts/004-dependencia",
      },
      {
        version: 1,
        at: DATE,
        event: "applied",
        pass_version: "v1",
        application: { environment: "cert", detail: "registrado", at: DATE },
      },
    ];
    fs.file(
      "/cwd/.workflow/release-passes.jsonl",
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const recorded = await prepare(fs, "scripts", {
      from: "bundles",
      environment: "cert",
      date: DATE,
    });
    const after = recorded.request.inventory as { bundle_warnings: Array<{ code: string }> };
    expect(after.bundle_warnings.map((warning) => warning.code)).toEqual(["BUNDLE_SUPERSEDED"]);
  });
});

describe("export-scripts · reserva de carpeta desde prepare", () => {
  const sql = "CREATE TABLE t (id int);\n";
  const files = (prepared: ExportPrepared): Array<[string, string]> =>
    dossier(prepared, [
      [`${prepared.unit}/rollback/00-global/00-ROLLBACK.sql`, "DROP TABLE t;"],
      [`${prepared.unit}/01-ddl-tablas/01-t.sql`, sql],
      [`${prepared.unit}/rollback/01-ddl-tablas/01-t.rollback.sql`, "DROP TABLE t;"],
    ]);

  it("un prepare repetido recupera su carpeta; validate y apply consumen la marca", async () => {
    const fs = workspace();
    const old = "/cwd/docs/scripts/002-export-scripts-2026-07-01";
    fs.file(`${old}/01-ddl-tablas/01-vieja.sql`, "CREATE TABLE vieja (id int);");
    const prepared = await prepare(fs, "scripts", { from: "bundles", date: DATE });
    const marker = `/cwd/${prepared.unit}/.aw-reservation`;
    expect(await fs.exists(marker)).toBe(true);
    const repeated = await prepare(fs, "scripts", { from: "bundles", date: DATE });
    expect(repeated.unit).toBe(prepared.unit);
    const raw = answer(prepared, files(prepared));
    const replay = await restage(fs, "scripts", raw);
    expect(replay.request.input_digest).toBe(prepared.request.input_digest);
    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared: replay,
      approval: approvalOf(replay, raw),
    });
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(await fs.exists(marker)).toBe(false);
    expect(applied.value.written).toContain(`${prepared.unit}/bundle.json`);
  });

  it("si apply falla a mitad, el marcador de la carpeta queda para reintentar", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "scripts", { date: DATE });
    const raw = answer(prepared, files(prepared));
    const original = fs.writeTextExclusive.bind(fs);
    fs.writeTextExclusive = async (path, content) => {
      if (path.endsWith("/01-t.sql")) throw new Error("disco lleno");
      return original(path, content);
    };
    const applied = await applyExport(fs, env, paths(), {
      raw,
      prepared,
      approval: approvalOf(prepared, raw),
    });
    if (applied.ok) throw new Error("expected publish failure");
    expect(applied.failure.code).toBe("PUBLISH_FAILED");
    expect(await fs.exists(`/cwd/${prepared.unit}/.aw-reservation`)).toBe(true);
    expect(await fs.exists(`/cwd/${prepared.unit}/README.md`)).toBe(false);
  });

  it("reintenta una publicación escrita cuyo registro de claim falló sin duplicar archivos", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "scripts", { date: DATE });
    const raw = answer(prepared, files(prepared));
    const approval = approvalOf(prepared, raw);
    const append = fs.appendText.bind(fs);
    fs.appendText = async (path, content) => {
      if (path.endsWith("claims.jsonl") && content.includes('"event":"published"'))
        throw new Error("ledger temporalmente inaccesible");
      return append(path, content);
    };
    await expect(applyExport(fs, env, paths(), { raw, prepared, approval })).rejects.toThrow(
      "ledger temporalmente inaccesible",
    );
    expect(await fs.exists(`/cwd/${prepared.unit}/.aw-reservation`)).toBe(true);
    fs.appendText = append;
    const retry = await applyExport(fs, env, paths(), {
      raw,
      prepared: await restage(fs, "scripts", raw),
      approval,
    });
    if (!retry.ok) throw new Error(retry.failure.message);
    expect(await fs.exists(`/cwd/${prepared.unit}/.aw-reservation`)).toBe(false);
    expect(retry.value.written).toContain(`${prepared.unit}/bundle.json`);
  });

  it("un prepare nuevo de la misma sesión libera su reserva anterior sin publicar", async () => {
    const fs = workspace();
    const root = "/cwd/.workflow/sessions/050-nuevo-plan-exec";
    fs.file(`${root}/SESSION.md`, "# SESSION\n\n## Objective\nMigrar\n");
    fs.file(`${root}/SCRIPTS.sql`, sql);
    const first = await prepare(fs, "scripts", { sessions: ["050"], code: "050", date: DATE });
    fs.file(`${root}/SCRIPTS.sql`, "CREATE TABLE t (id bigint);\n");
    const second = await prepare(fs, "scripts", { sessions: ["050"], code: "050", date: DATE });
    expect(await fs.exists(`/cwd/${second.unit}/.aw-reservation`)).toBe(true);
    expect(
      (await fs.list(`/cwd/${first.unit}`)).every((entry) => entry.name === ".aw-reservation"),
    ).toBe(true);
    expect((await readClaimEvents(fs, paths())).events.map((event) => event.event)).toEqual([
      "claimed",
      "released",
      "claimed",
    ]);
  });
});
