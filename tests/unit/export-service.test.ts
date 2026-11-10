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
import { commandHelpText } from "../../src/cli/help-groups.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const env = new FakeEnv("/home", "/cwd");
const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
const DATE = "2026-07-29";

function hub(): MemFs {
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
  // export-scripts consolidates loose SQL of docs/scripts/ (spec 066, ID06).
  fs.file("/cwd/docs/scripts/040-algo.sql", "CREATE TABLE algo (id integer);\n");
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

// ── per-category shape ───────────────────────────────────────────────────────

describe("validateExport — each category enforces its own shape", () => {
  it("scripts exige rollback global, acoplados y forwards numerados dentro de cada categoría", async () => {
    const fs = hub();
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
    const prepared = await prepare(hub(), "scripts");
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
    const prepared = await prepare(hub(), "scripts");
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
});

// ── publication ──────────────────────────────────────────────────────────────

describe("applyExport — publishes the dossier as a unit, or nothing", () => {
  it("rechaza un número publicado aunque su carpeta haya sido borrada", async () => {
    const fs = hub();
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

  // The INDEX is the one file an export may replace, and only on purpose.
  // The dossier guarantee: injecting a failure mid-publish leaves ZERO files.
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
  it("el contenido SQL de docs/scripts/ vence el sello; una sesión nueva no", async () => {
    const fs = hub();
    const prepared = await prepare(fs, "scripts");
    closedSession(fs, "041-otra-plan-exec");
    const second = await prepare(fs, "scripts");
    expect(second.request.input_digest).toBe(prepared.request.input_digest);
    fs.file("/cwd/docs/scripts/040-algo.sql", "CREATE TABLE algo (id bigint);\n");
    const changed = await prepare(fs, "scripts");
    expect(changed.request.input_digest).not.toBe(prepared.request.input_digest);
  });
});

// ── the envelope, readable before it is attempted ────────────────────────────

describe("el sobre y el rechazo se entienden sin gastar un intento", () => {
  // The old message for a missing `state` was `estado desconocido: undefined`:
  // it named the value, so the reader could not tell `state` from `status`.
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

/**
 * The net-final-state doctrine rides in the CONTRACT and not in the `skills/w`
 * bundle: the bundle's context budget is a frozen gate with ~121 B of headroom
 * and this doctrine is ~700 B, so it would have to be paid for by cutting live
 * doctrine. The contract reaches the same composer at the moment the bundle is
 * written, and its bytes are request bytes, which no frozen gate prices.
 */
describe("la consolidación de scripts declara el estado final neto", () => {
  it("el contrato de scripts publica la doctrina completa", async () => {
    const fs = hub();
    const contract = (await prepare(fs, "scripts")).request.contract;
    for (const clause of SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS) {
      expect(contract, clause).toContain(clause);
    }
  });
});

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
    const fs = hub();
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

  it("sin --from consolida docs/scripts/: SQL suelto y bundles, ninguna sesión (spec 066, ID06)", async () => {
    const inventory = inventoryOf(await prepare(withMaterial(), "scripts", { date: DATE }));

    expect(inventory.origins).toEqual(["standalone-sql", "bundles"]);
    expect(inventory.sessions).toEqual([]);
    expect(inventory.standalone_sql.map((f) => f.name)).toEqual([
      "040-algo.sql",
      "suelto-limpieza.sql",
    ]);
    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002", "003"]);
  });

  it("la base 'sessions' ya no existe", async () => {
    const result = await prepareExport(withMaterial(), env, paths(), "scripts", {
      from: "sessions" as never,
      date: DATE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain("no es una base: hub, bundles");
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

    expect(inventory.origins).toEqual(["standalone-sql", "bundles"]);
    expect(inventory.sessions).toEqual([]);
    expect(inventory.standalone_sql.map((f) => f.name)).toEqual([
      "040-algo.sql",
      "suelto-limpieza.sql",
    ]);
    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002", "003"]);
  });

  it("la exclusión por nombre resta la pieza del material", async () => {
    const inventory = inventoryOf(
      await prepare(withMaterial(), "scripts", {
        from: "hub",
        exclude: [BUNDLE_B, "suelto-limpieza.sql"],
        date: DATE,
      }),
    );

    expect(inventory.bundles.map((b) => b.nnn)).toEqual(["002"]);
    expect(inventory.standalone_sql.map((f) => f.name)).toEqual(["040-algo.sql"]);
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

    expect(inventory.origins).toEqual(["standalone-sql", "bundles"]);
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
    const fs = hub();
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
});

describe("bundle.json · manifiesto derivado y aprobado por el CLI", () => {
  const scripts = "/cwd/docs/scripts";
  const named = "005-retiro-hinovill";

  function withNamedBundle(): MemFs {
    const fs = hub();
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
    expect(manifest.origin.sessions).toEqual([]);
    expect(manifest.origin.standalone_sql).toMatchObject([
      { path: "docs/scripts/040-algo.sql" },
      { path: "docs/scripts/suelto.sql" },
    ]);
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
    const fs = hub();
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
    const fs = hub();
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
    const fs = hub();
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
});
