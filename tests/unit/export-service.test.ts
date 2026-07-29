import { describe, expect, it } from "vitest";
import {
  type ExportCategory,
  type ExportPrepared,
  applyExport,
  prepareExport,
  validateExport,
} from "../../src/application/export-service.js";
import { PathsService } from "../../src/application/paths-service.js";
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
  return fs;
}

async function prepare(fs: MemFs, category: ExportCategory): Promise<ExportPrepared> {
  const result = await prepareExport(fs, env, paths(), category, { date: DATE });
  if (!result.ok) throw new Error(`expected prepare to succeed: ${result.failure.message}`);
  return result.value;
}

function answer(prepared: ExportPrepared, files: Array<[string, string]>): string {
  return JSON.stringify({
    version: 1,
    operation: `export-${prepared.category}`,
    input_digest: prepared.request.input_digest,
    state: "proposed",
    artifacts: files.map(([path, content]) => ({ path, content })),
  });
}

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

  it("scripts exige 00-ROLLBACK.sql, README y forwards continuos desde 01", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "scripts");
    const complete = dossier(prepared, [
      [`${prepared.unit}/00-ROLLBACK.sql`, "-- rollback\n"],
      [`${prepared.unit}/01-crear-tabla.sql`, "-- forward\n"],
      [`${prepared.unit}/02-indices.sql`, "-- forward\n"],
    ]);
    expect(validateExport(answer(prepared, complete), prepared).ok).toBe(true);

    const gap = dossier(prepared, [
      [`${prepared.unit}/00-ROLLBACK.sql`, "-- rollback\n"],
      [`${prepared.unit}/01-crear-tabla.sql`, "-- forward\n"],
      [`${prepared.unit}/03-indices.sql`, "-- forward\n"],
    ]);
    const broken = validateExport(answer(prepared, gap), prepared);
    if (broken.ok) throw new Error("expected a rejection");
    expect(broken.failure.message).toContain("continua");

    const noRollback = dossier(prepared, [[`${prepared.unit}/01-crear-tabla.sql`, "-- forward\n"]]);
    const missing = validateExport(answer(prepared, noRollback), prepared);
    if (missing.ok) throw new Error("expected a rejection");
    expect(missing.failure.message).toContain("00-ROLLBACK.sql");
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

  // The number in the proposal is consultative. If another export lands in the
  // category between prepare and apply, the dossier must move to the minted
  // number — not overwrite, and not keep the stale one.
  it("reasigna el número cuando la categoría cambió después del prepare", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "diagrams");
    expect(prepared.unit).toBe(`docs/diagrams/001-export-diagrams-${DATE}`);
    const raw = answer(prepared, dossier(prepared));
    const approval = approvalOf(prepared, raw);

    fs.file("/cwd/docs/diagrams/001-export-diagrams-2026-01-01/README.md", "# Ajeno\n");

    const result = await applyExport(fs, env, paths(), { raw, prepared, approval });
    if (!result.ok) throw new Error(`expected it to apply: ${result.failure.message}`);
    expect(result.value.written).toEqual([`docs/diagrams/002-export-diagrams-${DATE}/README.md`]);
    expect(await fs.readText("/cwd/docs/diagrams/001-export-diagrams-2026-01-01/README.md")).toBe(
      "# Ajeno\n",
    );
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

    // The workspace lock is machinery, not a deliverable — it is the ONLY write
    // outside the category, and naming it here keeps the boundary honest.
    const touched = [...fs.writes.keys()].filter((p) => !p.endsWith("/.lock"));
    expect(touched.every((p) => p.startsWith("/cwd/docs/reports/"))).toBe(true);
    expect(touched.some((p) => p.includes("/sessions/"))).toBe(false);
    expect(touched.some((p) => p.startsWith("/cwd/docs/reports/"))).toBe(true);
  });
});
