import { describe, expect, it } from "vitest";
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
    expect(result.failure.message).toContain("corpus");
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

  // Answers written before the scope existed carry none: the flags still decide,
  // which is exactly the behavior that has to survive.
  it("un sobre sin scope no se inventa uno", async () => {
    const fs = workspace();
    const prepared = await prepare(fs, "manuals");
    const raw = answer(prepared, dossier(prepared), { scope: undefined });
    const echoed = readExportScope(raw);
    if (!echoed.ok) throw new Error("expected it to read");
    expect(echoed.value).toBeNull();
    expect(validateExport(raw, prepared).ok).toBe(true);
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
    const help = exportScriptsCommand.describe;
    for (const header of ["version", "operation", "input_digest", "state", "scope", "artifacts"]) {
      expect(help, header).toContain(`${header}:`);
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
    // The overwritable file moves with the category: one tree, not two.
    expect(prepared.request.allowed_destinations).toEqual([
      prepared.unit,
      "documentacion/manuales/INDEX.md",
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
