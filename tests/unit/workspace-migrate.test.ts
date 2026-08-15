import { describe, expect, it } from "vitest";
import { readHistoryRows } from "../../src/application/history-table.js";
import { parseProjectBlock } from "../../src/application/parsers/project-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { birthCustody, writeCustody } from "../../src/application/session-custody-service.js";
import { nextSessionCorrelative } from "../../src/application/session-resolver.js";
import { SessionsService } from "../../src/application/sessions-service.js";
import { applyWorkspaceMigration } from "../../src/application/workspace-migrate/apply.js";
import { planWorkspaceMigration } from "../../src/application/workspace-migrate/plan.js";
import { workspaceMigrateCommand } from "../../src/cli/commands/workspace-migrate.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * Un hub con serie legacy se pone al día — spec 027, F5.
 *
 * Todo lo que se ejercita acá es un hub heredado que el CLI actual NO ve: el
 * bloque de proyecto lleva los marcadores de un namespace anterior y el CLI
 * terminó leyendo un segundo bloque vacío que él mismo agregó; las sesiones que
 * el histórico da por cerradas no tienen su centinela en disco y figuran activas
 * para siempre; y los números de la serie legacy viven sólo en nombres de
 * carpeta. Cuando el histórico y el disco se contradicen, no se adivina.
 */

const env = new FakeEnv("/home/u", "/cwd");
const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const SESSIONS = "/cwd/.workflow/sessions";
const HISTORY = "/cwd/.workflow/HISTORY.md";
const HUB = "/cwd/CLAUDE.md";

const RICH_BLOCK = `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Arnés de agentes multihost.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| cli | /repos/cli | main |

## Stack

- Lenguaje: TypeScript

## Status

- Ramas de trabajo actuales:
  - cli: main
- Última actividad: 2025-11-01 09:00
- Histórico: \`.workflow/HISTORY.md\`
<!-- AGENT-WORKFLOW-PROJECT-END -->`;

/** El bloque que el CLI agrega cuando no encuentra los marcadores vigentes. */
const APPENDED_STUB = `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

_Describe el proyecto aquí: qué es y por qué existe._

## Fuentes

_Sin fuentes declaradas. Edita manualmente o usa \`project-md-upsert --init\`._

## Stack

_Stack sin detectar._

## Status

- Última actividad: 2026-08-01 10:00
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->`;

const SLIM_HEADER =
  "# Session History\n\n| Sesión | Fecha | Estado | Refs |\n|--------|-------|--------|------|\n";

function history(...rows: string[]): string {
  return rows.length === 0 ? SLIM_HEADER : `${SLIM_HEADER}${rows.join("\n")}\n`;
}

interface Folder {
  name: string;
  closed?: boolean;
}

function hub(options: {
  claude?: string;
  history?: string;
  folders?: readonly Folder[];
}): MemFs {
  const fs = new MemFs({ lenient: true });
  fs.file(HISTORY, options.history ?? history());
  if (options.claude !== undefined) fs.file(HUB, options.claude);
  for (const folder of options.folders ?? []) {
    fs.file(`${SESSIONS}/${folder.name}/SESSION.md`, `# SESSION — ${folder.name}\n`);
    if (folder.closed === true) fs.file(`${SESSIONS}/${folder.name}/.closed`, "");
  }
  return fs;
}

function context(fs: MemFs): CliContext {
  return { fs, env, paths } as unknown as CliContext;
}

// ─── el hub legacy completo ──────────────────────────────────────────────────

describe("un hub con serie legacy queda operable después de migrarlo", () => {
  function legacyHub(): MemFs {
    return hub({
      claude: `# CLAUDE.md\n\n${RICH_BLOCK}\n\n${APPENDED_STUB}\n`,
      history: history("| 007-triage | 2025-11-03 | closed | docs/x.md |"),
      folders: [{ name: "session007-triage" }, { name: "session008-otra" }],
    });
  }

  it("la vista previa dice qué va a pasar y no escribe una sola vez", async () => {
    const fs = legacyHub();
    const plan = await planWorkspaceMigration(fs, paths);

    expect(fs.writes.size).toBe(0);
    expect(plan.markers.map((m) => [m.from, m.to, m.drops_duplicate])).toEqual([
      ["AGENT-WORKFLOW", "WORKFLOW", true],
    ]);
    // El centinela sale del histórico, con la fecha del histórico.
    expect(plan.sentinels).toEqual([
      { folder: "session007-triage", path: `${SESSIONS}/session007-triage`, date: "2025-11-03" },
    ]);
    // 008 no tiene fila: su número sólo existe como nombre de carpeta.
    expect(plan.rows.map((r) => r.folder)).toEqual(["session008-otra"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.legacy).toEqual(["session007-triage", "session008-otra"]);
  });

  it("aplicar renombra los marcadores conservando el bloque rico y borra el duplicado", async () => {
    const fs = legacyHub();
    const applied = await applyWorkspaceMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    const text = await fs.readText(HUB);
    expect(text).not.toContain("AGENT-WORKFLOW-PROJECT-START");
    expect(text.match(/WORKFLOW-PROJECT-START/g)).toHaveLength(1);
    expect(text).toContain("# CLAUDE.md");

    // Y lo que el CLI lee ahora es el bloque rico, no el vacío que había agregado.
    const parsed = parseProjectBlock(text, paths.blockMarkers());
    expect(parsed?.proyecto).toBe("Arnés de agentes multihost.");
    expect(parsed?.fuentes).toEqual([{ alias: "cli", path: "/repos/cli", main_branch: "main" }]);
    expect(parsed?.working_branches).toEqual({ cli: "main" });
    expect(applied.duplicates_dropped).toEqual([HUB]);
  });

  it("siembra el centinela de la sesión que el histórico ya daba por cerrada", async () => {
    const fs = legacyHub();
    // Antes: las dos figuran activas, y una de ellas hace meses que no lo está.
    expect((await new SessionsService(fs, env, paths).list()).active_count).toBe(2);

    const applied = await applyWorkspaceMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    expect(applied.sentinels_seeded).toEqual(["session007-triage"]);
    expect(await fs.exists(`${SESSIONS}/session007-triage/.closed`)).toBe(true);
    // Vacío, byte a byte como lo escribe `session-close`: el centinela dice
    // "cerrada" por existir.
    expect(await fs.readText(`${SESSIONS}/session007-triage/.closed`)).toBe("");

    // Y deja de figurar activa de forma fantasma.
    const listed = await new SessionsService(fs, env, paths).list({ state: "all" });
    expect(listed.sessions.find((s) => s.folder === "session007-triage")?.state).toBe("closed");
    expect(listed.active_count).toBe(1);
  });

  it("no re-fecha la fila que ya existía: el centinela no es una escritura del registro", async () => {
    const fs = legacyHub();
    await applyWorkspaceMigration(fs, paths);
    const rows = readHistoryRows(await fs.readText(HISTORY));
    const seven = rows.find((r) => r.key.startsWith("007"));
    expect(seven?.date).toBe("2025-11-03");
    expect(seven?.refs).toBe("docs/x.md");
  });

  it("reserva el número legacy que sólo vivía en el nombre de la carpeta", async () => {
    const fs = legacyHub();
    const applied = await applyWorkspaceMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    expect(applied.rows_seeded).toEqual(["session008-otra"]);
    const rows = readHistoryRows(await fs.readText(HISTORY));
    expect(rows.map((r) => r.key)).toEqual(["007-triage", "008-otra"]);
    // La sesión nunca declaró su fecha: la migración guarda la ausencia, no la fecha de hoy.
    expect(applied.rows_without_date).toEqual(["session008-otra"]);
    expect(rows.find((r) => r.key.startsWith("008"))?.date).toBe("—");

    // El número queda gastado aunque mañana la carpeta se archive.
    const withoutFolders = hub({ history: await fs.readText(HISTORY) });
    expect(await nextSessionCorrelative(withoutFolders, paths)).toBe("009");
  });

  it("la fecha declarada por la custodia es la que va a la fila reservada", async () => {
    const fs = legacyHub();
    await writeCustody(
      fs,
      `${SESSIONS}/session008-otra`,
      birthCustody({
        subject: { kind: "session", key: "session008-otra" },
        subjectPath: `${SESSIONS}/session008-otra`,
        parents: [],
        artifacts: [],
        created: "2025-11-04",
      }),
    );
    const applied = await applyWorkspaceMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    expect(applied.rows_without_date).toEqual([]);
    const rows = readHistoryRows(await fs.readText(HISTORY));
    expect(rows.find((r) => r.key.startsWith("008"))?.date).toBe("2025-11-04");
  });

  it("correr la migración dos veces no vuelve a cambiar nada", async () => {
    const fs = legacyHub();
    await applyWorkspaceMigration(fs, paths);
    const second = await planWorkspaceMigration(fs, paths);
    expect(second.markers).toEqual([]);
    expect(second.sentinels).toEqual([]);
    expect(second.rows).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });
});

// ─── ante duda, no se adivina ────────────────────────────────────────────────

describe("cuando el histórico y el disco se contradicen, la sesión no se toca", () => {
  it("el histórico la da por activa y la carpeta ya tiene su centinela", async () => {
    const fs = hub({
      history: history("| 007-triage | 2025-11-03 | active | — |"),
      folders: [{ name: "session007-triage", closed: true }],
    });
    const plan = await planWorkspaceMigration(fs, paths);

    expect(plan.sentinels).toEqual([]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.subject).toBe("session007-triage");
    expect(plan.conflicts[0]?.reason).toBe("estado_divergente");

    const before = await fs.readText(HISTORY);
    const applied = await applyWorkspaceMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);
    expect(await fs.readText(HISTORY)).toBe(before);
    expect(applied.conflicts).toHaveLength(1);
  });

  it("un estado que no es ni active ni closed no se interpreta", async () => {
    const fs = hub({
      history: history("| 007-triage | 2025-11-03 | en curso | — |"),
      folders: [{ name: "session007-triage" }],
    });
    const plan = await planWorkspaceMigration(fs, paths);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["estado_ilegible"]);
    expect(plan.sentinels).toEqual([]);
  });

  it("un número que comparten dos carpetas no habilita a escribir la fila de ninguna", async () => {
    const fs = hub({
      history: history("| 007-triage | 2025-11-03 | closed | — |"),
      folders: [{ name: "session007-triage" }, { name: "007-otra-quick" }],
    });
    const plan = await planWorkspaceMigration(fs, paths);

    expect(plan.conflicts.map((c) => c.reason)).toEqual(["numero_compartido"]);
    expect(plan.conflicts[0]?.detail).toContain("007-otra-quick");
    expect(plan.sentinels).toEqual([]);
  });

  it("el bloque duplicado que declara algo propio no se borra: se reporta", async () => {
    const rival = APPENDED_STUB.replace(
      "_Sin fuentes declaradas. Edita manualmente o usa `project-md-upsert --init`._",
      "| Alias | Path | Rama principal |\n|---|---|---|\n| otra | /repos/otra | main |",
    );
    const fs = hub({ claude: `${RICH_BLOCK}\n\n${rival}\n` });
    const plan = await planWorkspaceMigration(fs, paths);

    expect(plan.markers).toEqual([]);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["duplicado_con_contenido"]);
    expect(plan.conflicts[0]?.detail).toContain("/repos/otra");

    const before = await fs.readText(HUB);
    await applyWorkspaceMigration(fs, paths);
    expect(await fs.readText(HUB)).toBe(before);
  });
});

// ─── un workspace sano no cambia ─────────────────────────────────────────────

describe("un workspace sano no cambia de comportamiento", () => {
  it("sin serie legacy y con los marcadores vigentes no hay nada que migrar", async () => {
    const fs = hub({
      claude: `# CLAUDE.md\n\n${APPENDED_STUB}\n`,
      history: history("| 001-uno-quick | 2026-01-01 | closed | — |"),
      folders: [{ name: "001-uno-quick", closed: true }, { name: "002-dos-quick" }],
    });
    const plan = await planWorkspaceMigration(fs, paths);
    expect(plan.markers).toEqual([]);
    expect(plan.sentinels).toEqual([]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.legacy).toEqual([]);

    await applyWorkspaceMigration(fs, paths);
    // Sólo el candado de la operación tocó el disco.
    expect([...fs.writes.keys()].filter((p) => !p.endsWith(".lock"))).toEqual([]);
  });

  it("una sesión reabierta con `--reopen` NO se vuelve a cerrar", async () => {
    // `session-resume --reopen` borra el centinela y deja la fila diciendo
    // `closed`: exactamente la forma del hueco fantasma, y sin embargo lo
    // correcto acá es no tocar nada.
    const fs = hub({
      history: history("| 001-uno-quick | 2026-01-01 | closed | — |"),
      folders: [{ name: "001-uno-quick" }],
    });
    const plan = await planWorkspaceMigration(fs, paths);
    expect(plan.sentinels).toEqual([]);
    expect(plan.conflicts).toEqual([]);

    await applyWorkspaceMigration(fs, paths);
    expect(await fs.exists(`${SESSIONS}/001-uno-quick/.closed`)).toBe(false);
  });

  it("un workspace sin CLAUDE.md ni histórico no rompe", async () => {
    const fs = new MemFs({ lenient: true });
    fs.dir("/cwd/.workflow");
    const plan = await planWorkspaceMigration(fs, paths);
    expect(plan.next_correlative).toBe("001");
    expect(plan.conflicts).toEqual([]);
  });
});

// ─── la superficie del comando ───────────────────────────────────────────────

describe("aw workspace-migrate", () => {
  it("sin --apply es de sólo lectura y ofrece el comando que aplica", async () => {
    const fs = hub({
      claude: `${RICH_BLOCK}\n`,
      folders: [{ name: "session007-triage" }],
    });
    const result = await workspaceMigrateCommand.execute(
      parseArgv(["workspace-migrate"]),
      context(fs),
    );
    expect(result.ok).toBe(true);
    expect(fs.writes.size).toBe(0);
    if (result.data?.action !== "preview") throw new Error("esperaba una vista previa");
    expect(result.data.pending).toBe(2);
    expect(result.data.next).toBe("aw workspace-migrate --apply");
    expect(result.data.markers[0]?.file).toBe("CLAUDE.md");

    const human = workspaceMigrateCommand.renderHuman?.(result, { detail: false }) ?? "";
    expect(human).toContain("aw workspace-migrate --apply");
    expect(human).toContain("AGENT-WORKFLOW → WORKFLOW");
  });

  it("con --apply escribe y reporta lo que hizo", async () => {
    const fs = hub({
      claude: `${RICH_BLOCK}\n`,
      history: history("| 007-triage | 2025-11-03 | closed | — |"),
      folders: [{ name: "session007-triage" }],
    });
    const result = await workspaceMigrateCommand.execute(
      parseArgv(["workspace-migrate", "--apply"]),
      context(fs),
    );
    expect(result.ok).toBe(true);
    if (result.data?.action !== "apply") throw new Error("esperaba una aplicación");
    expect(result.data.sentinels_seeded).toEqual(["session007-triage"]);
    expect(await fs.exists(`${SESSIONS}/session007-triage/.closed`)).toBe(true);
  });

  it("`--apply` seguido de un positional no se traga el token y sigue aplicando", async () => {
    const args = parseArgv(["workspace-migrate", "--apply", "algo"]);
    expect(args.flags.has("--apply")).toBe(true);
    expect(args.values.has("apply")).toBe(false);
  });

  it("un flag que no conoce lo rechaza en vez de ejecutarse como si nada", async () => {
    const fs = hub({ claude: `${RICH_BLOCK}\n` });
    const result = await workspaceMigrateCommand.execute(
      parseArgv(["workspace-migrate", "--force"]),
      context(fs),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_FLAG");
    expect(result.error?.message).toContain("--force");
    expect(fs.writes.size).toBe(0);
  });
});
