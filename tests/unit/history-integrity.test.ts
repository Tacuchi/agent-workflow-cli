import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHistoryUpdate } from "../../src/application/history-update-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { birthCustody, writeCustody } from "../../src/application/session-custody-service.js";
import { resolveSessionTarget } from "../../src/application/session-resolver.js";
import { SessionsService } from "../../src/application/sessions-service.js";
import { historyUpdateCommand } from "../../src/cli/commands/history-update.js";
import { sessionCloseCommand } from "../../src/cli/commands/session-close.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The durable record of a session — spec 027, F3 and F4.
 *
 * Every case here is a way `HISTORY.md` used to lose or falsify a fact through
 * an operation nobody would call destructive: consulting the next correlative,
 * closing a session twice, updating a state without naming references.
 */

const env = new FakeEnv("/home/u", "/cwd");
const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const HISTORY = "/cwd/.workflow/HISTORY.md";
const SLIM_TABLE =
  "# Session History\n\n| Sesión | Fecha | Estado | Refs |\n|--------|-------|--------|------|\n";

function hub(folders: readonly string[], history?: string): MemFs {
  const fs = new MemFs({ lenient: true });
  for (const folder of folders) {
    fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n`);
  }
  if (history !== undefined) fs.file(HISTORY, history);
  return fs;
}

// ─── F3 · one correlative ────────────────────────────────────────────────────

describe("el número que se anuncia es el que se asigna", () => {
  async function announcedAndAssigned(fs: MemFs): Promise<{ said: string; got: string }> {
    const said = (await new SessionsService(fs, env, paths).list()).next_correlative;
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "nueva-quick",
      objetivo: "x",
    });
    if ("error" in created) throw new Error(`unexpected error: ${created.error}`);
    return { said, got: created.sessionCreate.number };
  }

  it("workspace enteramente del modelo nuevo: anunciaba 001 y asignaba 004", async () => {
    const fs = hub(["001-uno-quick", "002-dos-quick", "003-tres-quick"]);
    const { said, got } = await announcedAndAssigned(fs);
    expect(said).toBe("004");
    expect(got).toBe(said);
  });

  it("carpeta legacy SIN fila en el histórico: anunciaba 002 y asignaba 001", async () => {
    const fs = hub(["session001-vieja"]);
    const { said, got } = await announcedAndAssigned(fs);
    expect(said).toBe("002");
    expect(got).toBe(said);
    // El código desnudo que repartía dos veces ya no colisiona con la carpeta.
    expect(await fs.exists(`${sessionsDir}/001-nueva-quick`)).toBe(false);
  });

  it("carpeta legacy CON fila en el histórico", async () => {
    const fs = hub(["session001-vieja"], `${SLIM_TABLE}| 001-vieja | 2026-01-01 | closed | — |\n`);
    const { said, got } = await announcedAndAssigned(fs);
    expect(said).toBe("002");
    expect(got).toBe(said);
  });

  it("una sesión retirada gastó su número: la fila lo recuerda sin carpeta", async () => {
    const fs = hub(
      ["002-dos-quick"],
      `${SLIM_TABLE}| 001-una-quick | 2026-01-01 | closed | — |\n| 005-cinco-quick | 2026-01-05 | closed | — |\n`,
    );
    const { said, got } = await announcedAndAssigned(fs);
    expect(said).toBe("006");
    expect(got).toBe(said);
  });
});

// ─── F4 · the row tells the truth ────────────────────────────────────────────

describe("la fecha de una fila es un hecho de la sesión, no del sistema de archivos", () => {
  const fs = new NodeFileSystem();
  let root: string;
  let realPaths: PathsService;
  let folder: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "aw-history-"));
    realPaths = new PathsService(normalizeNamespace("workflow"), root, root);
    folder = join(root, ".workflow", "sessions", "050-nueva-quick");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SESSION.md"), "# SESSION — 050-nueva-quick\n");
    writeFileSync(join(root, ".workflow", "HISTORY.md"), SLIM_TABLE);
    // The birth date the session sealed when it was created — the only reading
    // that cannot drift, since nothing ever rewrites it.
    await writeCustody(
      fs,
      folder,
      birthCustody({
        subject: { kind: "session", key: "050-nueva-quick" },
        subjectPath: folder,
        parents: [],
        artifacts: [],
        created: "2026-01-05",
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function historyRow(): string {
    const text = readFileSync(join(root, ".workflow", "HISTORY.md"), "utf8");
    return text.split("\n").find((line) => line.startsWith("| 050-")) ?? "";
  }

  function touch(when: string): void {
    utimesSync(folder, new Date(when), new Date(when));
  }

  it("la carpeta tocada en 2030 no envejece la fila hacia 2030", async () => {
    touch("2030-06-06T00:00:00Z");
    const closed = await runSessionClose(fs, realPaths, { code: "050" });
    if (!("sessionClose" in closed)) throw new Error(`unexpected: ${JSON.stringify(closed)}`);
    expect(historyRow()).toBe("| 050-nueva-quick | 2026-01-05 | closed | — |");
  });

  it("y volver a tocarla después no mueve la fila que ya se escribió", async () => {
    await runSessionClose(fs, realPaths, { code: "050" });
    const before = historyRow();
    touch("2031-07-07T00:00:00Z");
    const again = await runHistoryUpdate(fs, realPaths, { code: "050", state: "active" });
    expect("error" in again).toBe(false);
    expect(historyRow()).toBe(before.replace("closed", "active"));
    expect(historyRow()).toContain("2026-01-05");
  });

  it("una sesión anterior al registro de custodia conserva la fecha que el histórico ya tenía", async () => {
    rmSync(join(folder, ".custody.json"));
    writeFileSync(
      join(root, ".workflow", "HISTORY.md"),
      `${SLIM_TABLE}| 050-nueva-quick | 2025-11-11 | active | — |\n`,
    );
    touch("2030-06-06T00:00:00Z");
    await runSessionClose(fs, realPaths, { code: "050" });
    expect(historyRow()).toBe("| 050-nueva-quick | 2025-11-11 | closed | — |");
  });
});

describe("un upsert conserva las celdas que nadie nombró", () => {
  const WITH_REFS = `${SLIM_TABLE}| 047-algo-quick | 2026-03-04 | active | docs/decisiones/007-x.md |\n`;

  it("actualizar el estado sin --refs no borra las referencias", async () => {
    const fs = hub(["047-algo-quick"], WITH_REFS);
    const result = await runHistoryUpdate(fs, paths, { code: "047", state: "closed" });
    if ("error" in result || "sessionError" in result) throw new Error("expected a written row");
    expect(result.action).toBe("updated");
    expect(await fs.readText(HISTORY)).toContain(
      "| 047-algo-quick | 2026-03-04 | closed | docs/decisiones/007-x.md |",
    );
  });

  it("cerrar con --refs y actualizar después conserva lo que el cierre dejó", async () => {
    const fs = hub(["047-algo-quick"], SLIM_TABLE);
    await runSessionClose(fs, paths, { code: "047", refs: "dec:007-x" });
    await runHistoryUpdate(fs, paths, { code: "047", state: "active" });
    const text = await fs.readText(HISTORY);
    expect(text).toContain("[DEC](../docs/decisiones/007-x.md)");
    expect(text.match(/^\| 047-/gm)).toHaveLength(1);
  });
});

describe("las entradas legacy se normalizan antes de escribir HISTORY", () => {
  it("un código corto que resolvió 007 no inventa una fila 7-007", async () => {
    const fs = hub(["007-corto-quick"], SLIM_TABLE);
    const result = await runHistoryUpdate(fs, paths, { code: "7", state: "closed" });
    if ("error" in result || "sessionError" in result) throw new Error(JSON.stringify(result));
    expect(result.code).toBe("007");
    const text = await fs.readText(HISTORY);
    expect(text).toMatch(/^\| 007-corto-quick \| .* \| closed \| — \|$/m);
    expect(text).not.toContain("| 7-007-corto-quick |");
  });

  it("una fila legacy retirada sólo se repara cuando se la nombra exactamente", async () => {
    const table = `${SLIM_TABLE}| session007-retirada-quick | 2026-03-01 | active | — |\n`;
    const fs = hub([], table);
    const result = await runHistoryUpdate(fs, paths, {
      code: "session007-retirada-quick",
      state: "closed",
    });
    if ("error" in result || "sessionError" in result) throw new Error(JSON.stringify(result));
    expect(result.action).toBe("updated");
    expect(await fs.readText(HISTORY)).toContain(
      "| session007-retirada-quick | 2026-03-01 | closed | — |",
    );
  });
});

describe("sin una identidad que resuelva a una sola sesión no se escribe", () => {
  const COLLIDING = ["047-algo-quick", "session047-legacy-x"] as const;
  const TABLE = `${SLIM_TABLE}| 047-algo-quick | 2026-03-04 | active | docs/x.md |\n`;

  it("un --code ambiguo se niega e informa los candidatos, sin tocar el histórico", async () => {
    const fs = hub(COLLIDING, TABLE);
    const result = await runHistoryUpdate(fs, paths, { code: "047", state: "closed" });
    if (!("sessionError" in result)) throw new Error("expected a refusal");
    expect(result.sessionError.code).toBe("SESSION_AMBIGUOUS");
    expect(result.sessionError.candidates.map((c) => c.folder)).toEqual([...COLLIDING]);
    expect(await fs.readText(HISTORY)).toBe(TABLE);
  });

  it("la salida que sugiere el error es satisfacible: la carpeta exacta resuelve a una sola", async () => {
    const fs = hub(COLLIDING, TABLE);
    const ambiguous = await resolveSessionTarget(fs, paths, { code: "047", intent: "read" });
    if (ambiguous.outcome !== "error") throw new Error("expected an ambiguity");
    expect(ambiguous.action).toContain("session047-legacy-x");

    const exact = await resolveSessionTarget(fs, paths, {
      code: "session047-legacy-x",
      intent: "read",
    });
    if (exact.outcome !== "resolved") throw new Error(`unexpected: ${exact.message}`);
    expect(exact.session.folder).toBe("session047-legacy-x");
  });

  // La otra mitad de la regla: exigir que la identidad resuelva a una carpeta
  // dejaba sin reparación a la fila cuya carpeta ya no está — y retirarlas es
  // justo lo que hace `discard`. La fila es el único rastro que queda, y
  // repararla es para lo que existe este comando.
  it("una fila cuya carpeta ya no existe se repara nombrándola entera", async () => {
    const table = `${SLIM_TABLE}| 031-retirada-quick | 2026-03-01 | active | docs/plans/031-plan.md |\n`;
    const fs = hub([], table);
    const result = await runHistoryUpdate(fs, paths, {
      code: "031-retirada-quick",
      state: "closed",
    });
    if ("sessionError" in result || "error" in result) throw new Error(JSON.stringify(result));
    expect(result.action).toBe("updated");
    const written = await fs.readText(HISTORY);
    expect(written).toContain("| 031-retirada-quick | 2026-03-01 | closed |");
    // Ni la fecha ni las referencias las nombró nadie: siguen donde estaban.
    expect(written).toContain("docs/plans/031-plan.md");
  });

  it("pero un número desnudo sigue sin alcanzar: nombraría una fila que no es suya", async () => {
    const table = `${SLIM_TABLE}| 031-retirada-quick | 2026-03-01 | active | docs/plans/031-plan.md |\n`;
    const fs = hub([], table);
    const result = await runHistoryUpdate(fs, paths, { code: "031", state: "closed" });
    if (!("sessionError" in result)) throw new Error("esperaba una negativa");
    expect(await fs.readText(HISTORY)).toBe(table);
  });

  it("nombrada exactamente, la legacy en colisión tampoco pisa la fila de la otra", async () => {
    const fs = hub(COLLIDING, TABLE);
    const result = await runHistoryUpdate(fs, paths, {
      code: "session047-legacy-x",
      state: "closed",
    });
    // El registro se indexa por número y dos carpetas comparten el 047: se dice,
    // en vez de reescribir la fila de `047-algo-quick` con el nombre de la otra.
    if (!("sessionError" in result)) throw new Error("expected a refusal");
    expect(result.sessionError.action).toContain("session047-legacy-x");
    expect(await fs.readText(HISTORY)).toBe(TABLE);
  });
});

describe("un cierre que no puede registrarse no se aplica a medias", () => {
  // El cierre escribía `.closed`, invalidaba los vínculos y devolvía éxito con
  // un `history_error` adentro: la sesión quedaba cerrada en disco y activa en
  // el registro, sin reparación posible. Una mutación a medias es peor que una
  // negativa, y acá la negativa además nombra el único remedio.
  it("con el número compartido se niega ANTES de tocar el disco", async () => {
    const fs = hub(["047-algo-quick", "session047-legacy-x"], SLIM_TABLE);
    const result = await runSessionClose(fs, paths, { code: "047-algo-quick" });
    if (!("sessionError" in result))
      throw new Error(`esperaba una negativa: ${JSON.stringify(result)}`);
    expect(result.sessionError.action).toContain("renombrá");
    // Nada se movió: ni el centinela de cierre ni el registro.
    expect(await fs.exists(`${sessionsDir}/047-algo-quick/.closed`)).toBe(false);
    expect(await fs.readText(HISTORY)).toBe(SLIM_TABLE);
  });

  it("sin colisión el cierre sigue registrando su fila", async () => {
    const fs = hub(["047-algo-quick"], SLIM_TABLE);
    const result = await runSessionClose(fs, paths, { code: "047-algo-quick" });
    if (!("sessionClose" in result)) throw new Error(JSON.stringify(result));
    expect(result.sessionClose.closed).toBe(true);
    expect(result.sessionClose.history_error).toBeUndefined();
    expect(await fs.readText(HISTORY)).toContain("| 047-algo-quick |");
  });
});

describe("cerrar dos veces actualiza una fila, nunca agrega una segunda", () => {
  it("una carpeta legacy con fila propia se actualiza en su lugar", async () => {
    const fs = hub(
      ["session047-legacy-x"],
      `${SLIM_TABLE}| session047-legacy-x | 2026-02-02 | active | docs/x.md |\n`,
    );
    await runSessionClose(fs, paths, { code: "047" });
    await runSessionClose(fs, paths, { code: "047" });
    const text = await fs.readText(HISTORY);
    expect(text.match(/^\|.*047/gm)).toHaveLength(1);
    expect(text).toContain("| 047-legacy-x | 2026-02-02 | closed | docs/x.md |");
  });

  it("la fila nace dentro de la tabla aunque haya prosa debajo", async () => {
    const fs = hub(
      ["050-nueva-quick"],
      `${SLIM_TABLE}| 001-vieja-quick | 2026-01-01 | closed | — |\n\n## Notas\n\nel hub arrancó en enero.\n`,
    );
    await runSessionClose(fs, paths, { code: "050" });
    const lines = (await fs.readText(HISTORY)).split("\n");
    expect(lines.findIndex((l) => l.startsWith("| 050-"))).toBe(
      lines.findIndex((l) => l.startsWith("| 001-")) + 1,
    );
    expect(lines[lines.length - 2]).toBe("el hub arrancó en enero.");
  });
});

// ─── F4 · a flag nobody reads is not a flag that ran ─────────────────────────

describe("un flag que el comando no conoce no se ejecuta como si nada", () => {
  function context(fs: MemFs): CliContext {
    return { fs, env, paths } as unknown as CliContext;
  }

  it("`session-close --name x` falla en vez de cerrar ignorando la mitad de la invocación", async () => {
    const fs = hub(["001-uno-quick"], SLIM_TABLE);
    const result = await sessionCloseCommand.execute(
      parseArgv(["session-close", "--code", "001", "--name", "x"]),
      context(fs),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_FLAG");
    expect(result.error?.message).toContain("--name");
    // Y no cerró nada: la negativa ocurre antes de tocar el workspace.
    expect(await fs.exists(`${sessionsDir}/001-uno-quick/.closed`)).toBe(false);
  });

  it("`history-update --nombre` mal tipeado falla nombrando lo que sí acepta", async () => {
    const fs = hub(["001-uno-quick"], SLIM_TABLE);
    const result = await historyUpdateCommand.execute(
      parseArgv(["history-update", "--code", "001", "--state", "closed", "--nombre", "x"]),
      context(fs),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_FLAG");
    expect(result.error?.message).toContain("--refs");
    expect(await fs.readText(HISTORY)).toBe(SLIM_TABLE);
  });

  it("un flag retirado que este CLI documentó se acepta y se declara, nunca en silencio", async () => {
    const fs = hub(["001-uno-quick"], SLIM_TABLE);
    const result = await historyUpdateCommand.execute(
      parseArgv(["history-update", "--code", "001", "--state", "closed", "--summary", "x"]),
      context(fs),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: "added", ignored_flags: ["--summary"] });
  });

  it("los flags del runtime no son desconocidos para ningún comando", async () => {
    const fs = hub(["001-uno-quick"], SLIM_TABLE);
    const result = await historyUpdateCommand.execute(
      parseArgv(["history-update", "--code", "001", "--state", "closed", "--json"]),
      context(fs),
    );
    expect(result.ok).toBe(true);
  });
});
