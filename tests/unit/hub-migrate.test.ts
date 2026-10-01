import { describe, expect, it } from "vitest";
import {
  appendClaimEvent,
  openClaimsOf,
  readClaimEvents,
} from "../../src/application/claims-ledger.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { readHistoryRows } from "../../src/application/history-table.js";
import { applyHubMigration, applyRenumber } from "../../src/application/hub-migrate/apply.js";
import { planHubMigration, planRenumber } from "../../src/application/hub-migrate/plan.js";
import { parseHubBlock } from "../../src/application/parsers/hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { birthCustody, writeCustody } from "../../src/application/session-custody-service.js";
import { nextSessionCorrelative } from "../../src/application/session-resolver.js";
import { SessionsService } from "../../src/application/sessions-service.js";
import { hubMigrateCommand } from "../../src/cli/commands/hub-migrate.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  newRunState,
  sealRunState,
  serializeRunState,
  withProposal,
} from "../../src/domain/flow/run-state.js";
import { sealProposal } from "../../src/domain/proposal.js";
import { reservationMarker } from "../../src/domain/reservation.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { dispatch } from "../helpers/dispatch.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
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

describe("renumerado asistido de sesiones", () => {
  it("reconoce y transfiere un marcador intacto que nació sin evento claimed", async () => {
    const from = "009-local-quick";
    const to = "010-local-quick";
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: from }],
    });
    fs.file("/cwd/docs/plans/002-pendiente.md", reservationMarker(from));
    const result = await applyRenumber(fs, paths);
    if ("error" in result) throw new Error(result.error);
    expect(await fs.readText("/cwd/docs/plans/002-pendiente.md")).toBe(reservationMarker(to));
    const events = (await readClaimEvents(fs, paths)).events;
    expect(events.map((event) => event.event)).toEqual([
      "claimed",
      "transfer-intent",
      "transfer-confirmed",
    ]);
    expect(openClaimsOf(events, from)).toEqual([]);
    expect(openClaimsOf(events, to)).toHaveLength(1);
    const closed = await runSessionClose(fs, paths, { code: to });
    expect(closed).toHaveProperty("sessionClose.reservations_released", [
      "docs/plans/002-pendiente.md",
    ]);
  });

  it("compensa append fallido sin reescribir claims previos ni perder ninguna reserva", async () => {
    class FailSecondConfirmation extends MemFs {
      confirmations = 0;
      override async appendText(path: string, content: string) {
        if (
          path === "/cwd/.workflow/claims.jsonl" &&
          content.includes('"event":"transfer-confirmed"')
        ) {
          this.confirmations += 1;
          if (this.confirmations === 2) throw new Error("confirmación interrumpida");
        }
        await super.appendText(path, content);
      }
    }
    const from = "009-local-quick";
    const to = "010-local-quick";
    const fs = hub(
      {
        history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
        folders: [{ name: from }],
      },
      new FailSecondConfirmation({ lenient: true }),
    );
    for (const [number, name] of [
      ["002", "uno.md"],
      ["003", "dos.md"],
    ] as [string, string][]) {
      const claim = { category: "plans", correlative: number, name, owner: from };
      fs.file(`/cwd/docs/plans/${number}-${name}`, reservationMarker(from));
      await appendClaimEvent(fs, paths, { at: "2026-01-01", event: "claimed", claim });
    }
    const before = await fs.readText("/cwd/.workflow/claims.jsonl");
    await expect(applyRenumber(fs, paths)).rejects.toThrow("confirmación interrumpida");
    expect(await fs.exists(`${SESSIONS}/${from}/SESSION.md`)).toBe(true);
    expect(await fs.exists(`${SESSIONS}/${to}`)).toBe(false);
    expect(await fs.exists("/cwd/.workflow/renumber-pending.json")).toBe(false);
    const after = await fs.readText("/cwd/.workflow/claims.jsonl");
    expect(after.startsWith(before)).toBe(true);
    const events = (await readClaimEvents(fs, paths)).events;
    expect(openClaimsOf(events, from)).toHaveLength(2);
    expect(openClaimsOf(events, to)).toEqual([]);
    expect(await fs.readText("/cwd/docs/plans/002-uno.md")).toBe(reservationMarker(from));
    expect(await fs.readText("/cwd/docs/plans/003-dos.md")).toBe(reservationMarker(from));
  });

  it.each(["intención", "marcador", "confirmación"])(
    "recupera renumerado interrumpido tras %s y conserva un dueño",
    async (step) => {
      const from = "009-local-quick";
      const to = "010-local-quick";
      const marker = "/cwd/docs/plans/002-pendiente.md";
      const claim = { category: "plans", correlative: "002", name: "pendiente.md", owner: from };
      const transfer = {
        id: "recover-002",
        marker: "docs/plans/002-pendiente.md",
        number: "002",
        from,
        to,
      };
      const fs = hub({
        history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
        folders: [{ name: from }],
      });
      fs.file(marker, reservationMarker(from));
      await appendClaimEvent(fs, paths, { at: "2026-01-01", event: "claimed", claim });
      const body = {
        version: 1 as const,
        moves: [{ from, to, reason: "registro-remoto" as const }],
        files: [
          [HISTORY, await fs.readText(HISTORY)],
          ["/cwd/.workflow/HISTORY.legacy.md", null],
          [paths.cwdSessionBindingsFile(), null],
          ["/cwd/.workflow/doc-branches.jsonl", null],
          [`${SESSIONS}/${from}/.custody.json`, null],
          [`${SESSIONS}/${from}/.flow-run.json`, null],
          [paths.cwdFlowAttemptsFile(from), null],
          [marker, reservationMarker(from)],
        ],
        transfers: [{ path: marker, before: reservationMarker(from), from, to, claim, transfer }],
      };
      fs.file(
        "/cwd/.workflow/renumber-pending.json",
        JSON.stringify({ ...body, digest: semanticDigest(body) }),
      );
      await appendClaimEvent(fs, paths, {
        at: "2026-01-01",
        event: "transfer-intent",
        claim,
        transfer,
      });
      if (step !== "intención") fs.file(marker, reservationMarker(to));
      if (step === "confirmación")
        await appendClaimEvent(fs, paths, {
          at: "2026-01-01",
          event: "transfer-confirmed",
          claim,
          transfer,
        });
      if (step === "confirmación") {
        // También cubre una muerte dentro del movimiento de carpeta posterior
        // a la confirmación de la reserva.
        await fs.rename(`${SESSIONS}/${from}`, `${SESSIONS}/${to}`);
      }

      if (step === "intención") await planRenumber(fs, paths);
      const first = await readClaimEvents(fs, paths);
      expect(first.unreadable).toBe(0);
      expect(await fs.exists("/cwd/.workflow/renumber-pending.json")).toBe(false);
      const owner = step === "intención" ? from : to;
      expect(openClaimsOf(first.events, owner)).toEqual([{ ...claim, owner }]);
      expect(openClaimsOf(first.events, owner === from ? to : from)).toEqual([]);
      expect(await fs.exists(`${SESSIONS}/${owner}/SESSION.md`)).toBe(true);
      const ledger = await fs.readText("/cwd/.workflow/claims.jsonl");
      await readClaimEvents(fs, paths);
      expect(await fs.readText("/cwd/.workflow/claims.jsonl")).toBe(ledger);
    },
  );

  it("no mueve una corrida con una propuesta sellada cuya base usa el número anterior", async () => {
    const from = "009-local-quick";
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: from }],
    });
    const proposal = sealProposal({
      operation: "quick.save",
      artifacts: [{ path: "docs/plans/009-pendiente.md", content: "x", overwrite: false }],
      bases: [],
      effects: ["local_additive"],
      requiresApproval: [],
    });
    fs.file(
      `${SESSIONS}/${from}/.flow-run.json`,
      serializeRunState(withProposal(newRunState("quick", from), proposal)),
    );
    expect((await planRenumber(fs, paths)).blocked[0]).toContain("propuesta pendiente");
  });

  it("transfiere una reserva vigente al nuevo propietario y el cierre la libera", async () => {
    const from = "009-local-quick";
    const to = "010-local-quick";
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: from }],
    });
    const claim = { category: "plans", correlative: "002", name: "pendiente.md", owner: from };
    fs.file("/cwd/docs/plans/002-pendiente.md", `<!--  aw:reserva   ${from}   -->\n`);
    await appendClaimEvent(fs, paths, { at: "2026-01-01T00:00:00Z", event: "claimed", claim });
    const moved = await applyRenumber(fs, paths);
    if ("error" in moved) throw new Error(moved.error);
    expect(await fs.readText("/cwd/docs/plans/002-pendiente.md")).toBe(reservationMarker(to));
    const events = (await readClaimEvents(fs, paths)).events;
    expect(openClaimsOf(events, from)).toEqual([]);
    expect(openClaimsOf(events, to)).toEqual([{ ...claim, owner: to }]);
    const closed = await runSessionClose(fs, paths, { code: to });
    expect(closed).toHaveProperty("sessionClose.reservations_released", [
      "docs/plans/002-pendiente.md",
    ]);
  });

  it("mueve las dos carpetas legacy cuando una tercera identidad llegó del remoto", async () => {
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: "session009-a" }, { name: "session009-b" }],
    });
    expect((await planRenumber(fs, paths)).moves).toEqual([
      { from: "session009-a", to: "010-a", reason: "legacy" },
      { from: "session009-b", to: "011-b", reason: "legacy" },
    ]);
    const result = await applyRenumber(fs, paths);
    if ("error" in result) throw new Error(result.error);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toEqual([
      "009-remota-quick",
      "010-a",
      "011-b",
    ]);
  });

  it("una única carpeta legacy con fila remota distinta también tiene salida", async () => {
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: "session009-local" }],
    });
    expect((await planRenumber(fs, paths)).moves).toEqual([
      { from: "session009-local", to: "010-local", reason: "legacy" },
    ]);
    const moved = await applyRenumber(fs, paths);
    if ("error" in moved) throw new Error(moved.error);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toEqual([
      "009-remota-quick",
      "010-local",
    ]);
  });

  it("resuelve también dos carpetas de la serie legacy con el mismo número", async () => {
    const fs = hub({
      history: history("| 009-a | 2026-01-01 | active | — |"),
      folders: [{ name: "session009-a" }, { name: "session009-b" }],
    });
    expect((await planRenumber(fs, paths)).moves).toEqual([
      { from: "session009-b", to: "010-b", reason: "legacy" },
    ]);
    const result = await applyRenumber(fs, paths);
    if ("error" in result) throw new Error(result.error);
    expect(await fs.exists(`${SESSIONS}/010-b/SESSION.md`)).toBe(true);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toEqual([
      "009-a",
      "010-b",
    ]);
  });

  it("rechaza mover una corrida que conserva su candado", async () => {
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: "009-local-quick" }],
    });
    fs.file(
      `${SESSIONS}/009-local-quick/.flow-run.json.lock`,
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    expect((await planRenumber(fs, paths)).blocked[0]).toContain("corrida tiene el candado");
    const applied = await applyRenumber(fs, paths);
    expect(applied).toMatchObject({ moved: [] });
    expect(await fs.exists(`${SESSIONS}/009-local-quick/SESSION.md`)).toBe(true);
  });

  it("revierte el conjunto si la segunda sesión no permite leer su custodia", async () => {
    const fs = hub({
      history: history(
        "| 009-remota-quick | 2026-01-01 | active | — |",
        "| 010-remota-quick | 2026-01-01 | active | — |",
      ),
      folders: [{ name: "009-local-quick" }, { name: "010-local-quick" }],
    });
    fs.file(`${SESSIONS}/010-local-quick/.custody.json`, "{");
    const before = await fs.readText(HISTORY);
    expect((await planRenumber(fs, paths)).moves).toHaveLength(2);
    await expect(applyRenumber(fs, paths)).rejects.toThrow();
    expect(await fs.readText(HISTORY)).toBe(before);
    expect(await fs.exists(`${SESSIONS}/009-local-quick/SESSION.md`)).toBe(true);
    expect(await fs.exists(`${SESSIONS}/010-local-quick/SESSION.md`)).toBe(true);
    expect(await fs.exists(`${SESSIONS}/011-local-quick`)).toBe(false);
  });

  it("el rollback retira también el respaldo legacy creado por el primer movimiento", async () => {
    const fs = hub({
      history:
        "# Session History\n\n| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n|---|---|---|---|---|---|---|\n| 009 | quick | remota-quick | 2026-01-01 | active | remota | — |\n| 010 | quick | otra-remota-quick | 2026-01-01 | active | remota | — |\n",
      folders: [{ name: "009-local-quick" }, { name: "010-local-quick" }],
    });
    fs.file(`${SESSIONS}/010-local-quick/.custody.json`, "{");
    const before = await fs.readText(HISTORY);
    await expect(applyRenumber(fs, paths)).rejects.toThrow();
    expect(await fs.exists("/cwd/.workflow/HISTORY.legacy.md")).toBe(false);
    expect(await fs.readText(HISTORY)).toBe(before);
  });

  it("se niega si la sesión aún tiene una unidad de aislamiento viva", async () => {
    const local = "009-local-quick";
    const fs = hub({
      claude:
        "<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| cli | /repos/cli | main |\n<!-- WORKFLOW-HUB-END -->",
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: local }],
    });
    const git = new RecordingGit({
      worktrees: {
        "/repos/cli": [
          {
            path: `/unidades/${local}`,
            branch: `aw/${local}`,
            head: "a".repeat(40),
            main: false,
            prunable: false,
          },
        ],
      },
    });
    const preview = await planRenumber(fs, paths, git);
    expect(preview.moves).toEqual([]);
    expect(preview.blocked[0]).toContain("integrá o liberá");
  });

  it("resuelve la fila que llegó de otra máquina sin borrar esa identidad", async () => {
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: "009-local-quick" }],
    });
    expect((await planRenumber(fs, paths)).moves).toEqual([
      { from: "009-local-quick", to: "010-local-quick", reason: "registro-remoto" },
    ]);
    const result = await applyRenumber(fs, paths);
    if ("error" in result) throw new Error(result.error);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toEqual([
      "009-remota-quick",
      "010-local-quick",
    ]);
  });

  it("también retira la fila local slim escrita sin espacios", async () => {
    const fs = hub({
      history: `${SLIM_HEADER}|009-remota-quick|2026-01-01|active|—|\n|009-local-quick|2026-01-02|active|—|\n`,
      folders: [{ name: "009-local-quick" }],
    });
    const result = await applyRenumber(fs, paths);
    if ("error" in result) throw new Error(result.error);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toEqual([
      "009-remota-quick",
      "010-local-quick",
    ]);
  });

  it("resuelve serie legacy y fila remota, reescribiendo custodia, binding, corrida, contador y quick", async () => {
    const local = "009-local-quick";
    const next = "010-local-quick";
    const fs = hub({
      history: history("| 009-remota-quick | 2026-01-01 | active | — |"),
      folders: [{ name: "session009-antigua" }, { name: local }],
    });
    const session = `${SESSIONS}/${local}`;
    await writeCustody(
      fs,
      session,
      birthCustody({
        subject: { kind: "session", key: local },
        subjectPath: session,
        parents: [],
        artifacts: [],
        created: "2026-01-02",
      }),
    );
    fs.file(`${session}/.flow-run.json`, serializeRunState(newRunState("quick", local)));
    fs.file(
      paths.cwdFlowAttemptsFile(local),
      JSON.stringify({
        version: 2,
        session: local,
        attempts: {},
        granted: {},
        digest: semanticDigest({ version: 2, session: local, attempts: {}, granted: {} }),
      }),
    );
    fs.file(
      paths.cwdSessionBindingsFile(),
      JSON.stringify({ version: 1, bindings: { hash: local } }),
    );
    fs.file(
      "/cwd/.workflow/doc-branches.jsonl",
      `${JSON.stringify({ version: 1, at: "2026-01-02", doc: { kind: "quick", key: local }, source: "cli", branch: "main", by: local, outcome: "existing" })}\n`,
    );
    expect((await planRenumber(fs, paths)).moves).toEqual([
      { from: local, to: next, reason: "legacy" },
      { from: "session009-antigua", to: "011-antigua", reason: "legacy" },
    ]);
    const preview = await hubMigrateCommand.execute(
      parseArgv(["hub-migrate", "--renumber"]),
      context(fs),
    );
    expect(preview.data).toMatchObject({
      action: "renumber-preview",
      moves: [
        { from: local, to: next },
        { from: "session009-antigua", to: "011-antigua" },
      ],
    });
    const result = await applyRenumber(fs, paths);
    if ("error" in result) throw new Error(result.error);
    expect(result.moved).toHaveLength(2);
    expect(await fs.exists(session)).toBe(false);
    expect(await fs.exists(`${SESSIONS}/${next}/SESSION.md`)).toBe(true);
    expect(await fs.exists(paths.cwdFlowAttemptsFile(next))).toBe(true);
    expect(JSON.parse(await fs.readText(paths.cwdFlowAttemptsFile(next))).session).toBe(next);
    expect(JSON.parse(await fs.readText(`${SESSIONS}/${next}/.custody.json`)).subject.key).toBe(
      next,
    );
    expect(JSON.parse(await fs.readText(`${SESSIONS}/${next}/.flow-run.json`)).session).toBe(next);
    const resumed = await readRun(fs, locateRun(paths, next));
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.failure));
    expect(JSON.parse(await fs.readText(paths.cwdSessionBindingsFile())).bindings.hash).toBe(next);
    expect(
      JSON.parse((await fs.readText("/cwd/.workflow/doc-branches.jsonl")).trim()).doc.key,
    ).toBe(next);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toContain(next);
    expect(readHistoryRows(await fs.readText(HISTORY)).map((row) => row.key)).toContain(
      "009-remota-quick",
    );
    expect(await fs.exists(`${SESSIONS}/011-antigua/SESSION.md`)).toBe(true);
    const closed = await runSessionClose(fs, paths, { code: next });
    expect(closed).toHaveProperty("sessionClose.closed", true);
  });
});

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
const APPENDED_STUB = `<!-- WORKFLOW-HUB-START -->
## Hub

_Describe el proyecto aquí: qué es y por qué existe._

## Fuentes

_Sin fuentes declaradas. Edita manualmente o usa \`project-md-upsert --init\`._

## Stack

_Stack sin detectar._

## Status

- Última actividad: 2026-08-01 10:00
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-HUB-END -->`;

const SLIM_HEADER =
  "# Session History\n\n| Sesión | Fecha | Estado | Refs |\n|--------|-------|--------|------|\n";

function history(...rows: string[]): string {
  return rows.length === 0 ? SLIM_HEADER : `${SLIM_HEADER}${rows.join("\n")}\n`;
}

interface Folder {
  name: string;
  closed?: boolean;
}

function hub(
  options: {
    claude?: string;
    history?: string;
    folders?: readonly Folder[];
  },
  fs: MemFs = new MemFs({ lenient: true }),
): MemFs {
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
  it("un fallo en el segundo espejo revierte ambos bloques migrados", async () => {
    const fs = hub({ claude: RICH_BLOCK });
    const agents = "/cwd/AGENTS.md";
    fs.file(agents, RICH_BLOCK);
    const originals = [await fs.readText(HUB), await fs.readText(agents)];
    let failed = false;
    const injected: FileSystemPort = new Proxy(fs, {
      get(target, property) {
        if (property === "writeText") {
          return async (path: string, text: string) => {
            if (path === agents && !failed) {
              failed = true;
              throw new Error("fallo inyectado en AGENTS.md");
            }
            return target.writeText(path, text);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(applyHubMigration(injected, paths)).rejects.toThrow("fallo inyectado");
    expect([await fs.readText(HUB), await fs.readText(agents)]).toEqual(originals);
  });

  function legacyHub(): MemFs {
    return hub({
      claude: `# CLAUDE.md\n\n${RICH_BLOCK}\n\n${APPENDED_STUB}\n`,
      history: history("| 007-triage | 2025-11-03 | closed | docs/x.md |"),
      folders: [{ name: "session007-triage" }, { name: "session008-otra" }],
    });
  }

  it("la vista previa dice qué va a pasar y no escribe una sola vez", async () => {
    const fs = legacyHub();
    const plan = await planHubMigration(fs, paths);

    expect(fs.writes.size).toBe(0);
    expect(plan.markers.map((m) => [m.from, m.to, m.drops_duplicate])).toEqual([
      ["AGENT-WORKFLOW-PROJECT", "WORKFLOW-HUB", true],
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
    const applied = await applyHubMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    const text = await fs.readText(HUB);
    expect(text).not.toContain("AGENT-WORKFLOW-PROJECT-START");
    expect(text.match(/WORKFLOW-HUB-START/g)).toHaveLength(1);
    expect(text).toContain("# CLAUDE.md");

    // Y lo que el CLI lee ahora es el bloque rico, no el vacío que había agregado.
    const parsed = parseHubBlock(text, paths.blockMarkers());
    expect(parsed?.proyecto).toBe("Arnés de agentes multihost.");
    expect(parsed?.fuentes).toEqual([{ alias: "cli", path: "/repos/cli", main_branch: "main" }]);
    expect(parsed?.working_branches).toEqual({ cli: "main" });
    expect(applied.duplicates_dropped).toEqual([HUB]);
  });

  it("siembra el centinela de la sesión que el histórico ya daba por cerrada", async () => {
    const fs = legacyHub();
    // Antes: las dos figuran activas, y una de ellas hace meses que no lo está.
    expect((await new SessionsService(fs, env, paths).list()).active_count).toBe(2);

    const applied = await applyHubMigration(fs, paths);
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
    await applyHubMigration(fs, paths);
    const rows = readHistoryRows(await fs.readText(HISTORY));
    const seven = rows.find((r) => r.key.startsWith("007"));
    expect(seven?.date).toBe("2025-11-03");
    expect(seven?.refs).toBe("docs/x.md");
  });

  it("reserva el número legacy que sólo vivía en el nombre de la carpeta", async () => {
    const fs = legacyHub();
    const applied = await applyHubMigration(fs, paths);
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
    const applied = await applyHubMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    expect(applied.rows_without_date).toEqual([]);
    const rows = readHistoryRows(await fs.readText(HISTORY));
    expect(rows.find((r) => r.key.startsWith("008"))?.date).toBe("2025-11-04");
  });

  it("correr la migración dos veces no vuelve a cambiar nada", async () => {
    const fs = legacyHub();
    await applyHubMigration(fs, paths);
    const second = await planHubMigration(fs, paths);
    expect(second.markers).toEqual([]);
    expect(second.aliases).toEqual([]);
    expect(second.runs).toEqual([]);
    expect(second.sentinels).toEqual([]);
    expect(second.rows).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });
});

// ─── 29.0.0: el término único hub ────────────────────────────────────────────

describe("hub-migrate lleva el bloque, el encabezado y el alias a hub", () => {
  const OPEN_PLAN = "/cwd/docs/plans/001-plan-abierto.md";
  const DONE_PLAN = "/cwd/docs/plans/002-plan-cerrado.md";
  const RUN = `${SESSIONS}/003-abierta-plan-exec/.flow-run.json`;

  function planDoc(state: string): string {
    return [
      "# Plan 001 — abierto",
      "",
      `> Estado: ${state}`,
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — algo",
      "> Estado: pendiente",
      "> Fuentes: cli, workspace",
      "",
      "- [ ] T1.1 — tocar el hub _(fuentes: workspace)_",
      "- [ ] T1.2 — tocar la fuente _(fuentes: cli)_",
      "",
    ].join("\n");
  }

  function hubWithAlias(): MemFs {
    const fs = hub({ claude: `# CLAUDE.md\n\n${RICH_BLOCK}\n` });
    fs.file(OPEN_PLAN, planDoc("open"));
    fs.file(DONE_PLAN, planDoc("done"));
    fs.file(`${SESSIONS}/003-abierta-plan-exec/SESSION.md`, "# SESSION\n");
    const { digest: _seal, ...state } = newRunState("plan-exec", "003-abierta-plan-exec");
    fs.file(
      RUN,
      serializeRunState(
        sealRunState({
          ...state,
          scope: { plan: "docs/plans/001-plan-abierto.md", sources: ["workspace", "cli"] },
        }),
      ),
    );
    return fs;
  }

  it("la vista previa lista archivo y línea, y no escribe", async () => {
    const fs = hubWithAlias();
    const plan = await planHubMigration(fs, paths);
    expect(fs.writes.size).toBe(0);
    expect(plan.markers.map((m) => [m.from, m.to])).toEqual([
      ["AGENT-WORKFLOW-PROJECT", "WORKFLOW-HUB"],
    ]);
    expect(plan.aliases.flatMap((a) => a.lines.map((l) => l.line))).toEqual([10, 12]);
    expect(plan.runs.map((run) => run.session)).toEqual(["003-abierta-plan-exec"]);
  });

  it("aplicar deja marcadores HUB, ## Hub y el alias hub sólo en lo abierto", async () => {
    const fs = hubWithAlias();
    const closedBefore = await fs.readText(DONE_PLAN);
    const applied = await applyHubMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);

    const claude = await fs.readText(HUB);
    expect(claude).toContain("<!-- WORKFLOW-HUB-START -->\n## Hub\n");
    expect(claude).not.toContain("## Proyecto");
    expect(parseHubBlock(claude, paths.blockMarkers())?.proyecto).toBe(
      "Arnés de agentes multihost.",
    );

    const open = await fs.readText(OPEN_PLAN);
    expect(open).toContain("> Fuentes: cli, hub");
    expect(open).toContain("_(fuentes: hub)_");
    expect(open).not.toMatch(/\bworkspace\b/);
    expect(await fs.readText(DONE_PLAN)).toBe(closedBefore);

    const run = await readRun(fs, locateRun(paths, "003-abierta-plan-exec"));
    expect(run.ok && run.state.scope?.sources).toEqual(["hub", "cli"]);
    expect(applied.aliases_rewritten).toEqual([OPEN_PLAN]);
    expect(applied.runs_rewritten).toEqual(["003-abierta-plan-exec"]);
  });

  it("una corrida cerrada conserva su alias tal cual", async () => {
    const fs = hubWithAlias();
    fs.file(`${SESSIONS}/003-abierta-plan-exec/.closed`, "");
    const before = await fs.readText(RUN);
    await applyHubMigration(fs, paths);
    expect(await fs.readText(RUN)).toBe(before);
  });

  it("CLAUDE.md y AGENTS.md distintos conservan cada uno su contenido", async () => {
    const fs = hub({ claude: `# CLAUDE.md\n\n${RICH_BLOCK}\n\nNotas de Claude.\n` });
    const agents = "/cwd/AGENTS.md";
    fs.file(
      agents,
      `# AGENTS.md\n\n${RICH_BLOCK.replace("Arnés de agentes multihost.", "Otra descripción.")}\n`,
    );
    await applyHubMigration(fs, paths);
    const claude = await fs.readText(HUB);
    const other = await fs.readText(agents);
    expect(claude).toContain("Notas de Claude.");
    expect(parseHubBlock(claude, paths.blockMarkers())?.proyecto).toBe(
      "Arnés de agentes multihost.",
    );
    expect(parseHubBlock(other, paths.blockMarkers())?.proyecto).toBe("Otra descripción.");
    expect(other).toContain("# AGENTS.md");
  });

  it("el segundo --apply no cambia nada", async () => {
    const fs = hubWithAlias();
    await applyHubMigration(fs, paths);
    const snapshot = [HUB, OPEN_PLAN, DONE_PLAN, RUN].map((path) => fs.readText(path));
    const before = await Promise.all(snapshot);
    const second = await planHubMigration(fs, paths);
    expect([second.markers, second.aliases, second.runs]).toEqual([[], [], []]);
    await applyHubMigration(fs, paths);
    expect(
      await Promise.all([HUB, OPEN_PLAN, DONE_PLAN, RUN].map((path) => fs.readText(path))),
    ).toEqual(before);
  });
});

describe("hub-migrate reescribe el alias sólo donde el lector lo lee (revisión del plan 086)", () => {
  const PLAN = "/cwd/docs/plans/001-plan-abierto.md";
  const RUN = `${SESSIONS}/003-abierta-plan-exec/.flow-run.json`;

  function openPlan(lines: string[], eol = "\n"): string {
    return ["# Plan 001 — abierto", "", "> Estado: open", "", "## Tasks", "", ...lines, ""].join(
      eol,
    );
  }

  function runWith(extra: Record<string, unknown>): string {
    const { digest: _seal, ...state } = newRunState("plan-exec", "003-abierta-plan-exec");
    return serializeRunState(
      sealRunState({
        ...state,
        scope: { plan: "docs/plans/001-plan-abierto.md", sources: ["workspace", "cli"] },
        ...extra,
      } as typeof state),
    );
  }

  function batch(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "batch-1",
      iteration: 1,
      mode: "isolated",
      phases: [1],
      tasks: ["T1.1"],
      plan_digest: "d",
      stage: "closed",
      ...extra,
    };
  }

  it("un bloque cercado y la prosa fuera de una tarea no se tocan", async () => {
    const text = openPlan([
      "### F1 — algo",
      "> Fuentes: workspace",
      "- [ ] T1.1 — tarea _(fuentes: workspace)_",
      "La nota cita `_(fuentes: workspace)_` sin ser tarea.",
      "```",
      "> Fuentes: workspace",
      "- [ ] T9.9 — ejemplo _(fuentes: workspace)_",
      "```",
    ]);
    const fs = hub({});
    fs.file(PLAN, text);
    await applyHubMigration(fs, paths);
    const after = (await fs.readText(PLAN)).split("\n");
    expect(after[7]).toBe("> Fuentes: hub");
    expect(after[8]).toBe("- [ ] T1.1 — tarea _(fuentes: hub)_");
    expect(after.slice(9)).toEqual(text.split("\n").slice(9));
  });

  it("acepta lo mismo que el lector: mayúsculas, espacios y CRLF", async () => {
    const text = openPlan(
      ["### F1 — algo", "> fuentes : workspace", "- [ ] T1.1 — tarea _( Fuentes: workspace )_"],
      "\r\n",
    );
    const fs = hub({});
    fs.file(PLAN, text);
    await applyHubMigration(fs, paths);
    expect(await fs.readText(PLAN)).toBe(
      text
        .replace("> fuentes : workspace", "> fuentes : hub")
        .replace("Fuentes: workspace )", "Fuentes: hub )"),
    );
  });

  it("una corrida abierta renombra también las claves por alias de sus lotes y su validación final", async () => {
    const fs = hub({});
    fs.file(`${SESSIONS}/003-abierta-plan-exec/SESSION.md`, "# SESSION\n");
    fs.file(
      RUN,
      runWith({
        batches: [
          batch({
            base: { workspace: "sha256:w", cli: "sha256:c" },
            credit: { workspace: "d-w" },
            snapshot: { workspace: { head: "h", branch: "main", dirty: [] } },
            commit_result: {},
          }),
        ],
      }),
    );
    await applyHubMigration(fs, paths);
    const run = await readRun(fs, locateRun(paths, "003-abierta-plan-exec"));
    if (!run.ok) throw new Error(run.failure.message);
    const migrated = run.state.batches?.[0];
    expect(run.state.scope?.sources).toEqual(["hub", "cli"]);
    expect(migrated?.base).toEqual({ hub: "sha256:w", cli: "sha256:c" });
    expect(migrated?.credit).toEqual({ hub: "d-w" });
    expect(Object.keys(migrated?.snapshot ?? {})).toEqual(["hub"]);
  });

  it("una corrida con un commit de lote sin aterrizar queda intacta y se informa", async () => {
    const fs = hub({});
    fs.file(`${SESSIONS}/003-abierta-plan-exec/SESSION.md`, "# SESSION\n");
    const text = runWith({
      batches: [
        batch({
          stage: "batch-committing",
          commit_proposal: {
            sources: [
              {
                alias: "workspace",
                paths: ["a.md"],
                dirty: [{ path: "a.md", digest: "d" }],
                message: "m",
              },
            ],
            digest: "x",
            approved_digest: "x",
          },
        }),
      ],
    });
    fs.file(RUN, text);
    const plan = await planHubMigration(fs, paths);
    expect(plan.runs).toEqual([]);
    expect(plan.conflicts.map((conflict) => conflict.reason)).toEqual(["commit_de_lote_pendiente"]);
    await applyHubMigration(fs, paths);
    expect(await fs.readText(RUN)).toBe(text);
  });

  it("con el candado de una corrida abierta tomado no escribe nada", async () => {
    const fs = hub({});
    fs.file(PLAN, openPlan(["### F1 — algo", "> Fuentes: workspace"]));
    fs.file(`${SESSIONS}/003-abierta-plan-exec/SESSION.md`, "# SESSION\n");
    fs.file(RUN, runWith({}));
    fs.file(`${RUN}.lock`, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    const before = [await fs.readText(PLAN), await fs.readText(RUN)];
    expect(await applyHubMigration(fs, paths)).toEqual({
      error: expect.stringContaining("003-abierta-plan-exec"),
    });
    expect([await fs.readText(PLAN), await fs.readText(RUN)]).toEqual(before);
  });

  it("la marca de fuentes en la línea de continuación de una tarea también migra", async () => {
    const text = openPlan([
      "### F1 — algo",
      "- [ ] T1.1 — una tarea larga",
      "  que sigue acá _(fuentes: workspace)_",
    ]);
    const fs = hub({});
    fs.file(PLAN, text);
    await applyHubMigration(fs, paths);
    expect(await fs.readText(PLAN)).toBe(text.replace("(fuentes: workspace)", "(fuentes: hub)"));
  });

  it("una corrida que todavía no fijó su scope migra las fuentes de su entrada", async () => {
    const fs = hub({});
    fs.file(`${SESSIONS}/003-abierta-plan-exec/SESSION.md`, "# SESSION\n");
    fs.file(
      RUN,
      runWith({
        scope: null,
        plan_exec_entry: {
          plan: "docs/plans/001-plan-abierto.md",
          phases_without_open_tasks: [],
          sources: ["cli", "workspace"],
        },
      }),
    );
    await applyHubMigration(fs, paths);
    const run = await readRun(fs, locateRun(paths, "003-abierta-plan-exec"));
    if (!run.ok) throw new Error(run.failure.message);
    expect(run.state.plan_exec_entry?.sources).toEqual(["cli", "hub"]);
  });

  it("un lote parado en batch-committing con sus commits ya aterrizados también queda intacto", async () => {
    const fs = hub({});
    fs.file(`${SESSIONS}/003-abierta-plan-exec/SESSION.md`, "# SESSION\n");
    const text = runWith({
      batches: [
        batch({
          stage: "batch-committing",
          commit_proposal: {
            sources: [
              {
                alias: "workspace",
                paths: ["a.md"],
                dirty: [{ path: "a.md", digest: "d" }],
                message: "m",
              },
            ],
            digest: "x",
            approved_digest: "x",
          },
          commit_result: {
            workspace: { branch: "main", before: "a", after: "b", parents: ["a"] },
          },
        }),
      ],
    });
    fs.file(RUN, text);
    await applyHubMigration(fs, paths);
    expect(await fs.readText(RUN)).toBe(text);
  });
});

// ─── ante duda, no se adivina ────────────────────────────────────────────────

describe("cuando el histórico y el disco se contradicen, la sesión no se toca", () => {
  it("una fila (local) y la absoluta vieja de la misma fuente se comparan por la ruta resuelta", async () => {
    const portable = APPENDED_STUB.replace(
      "_Sin fuentes declaradas. Edita manualmente o usa `project-md-upsert --init`._",
      "| Alias | Path | Rama principal |\n|---|---|---|\n| cli | (local) | main |",
    );
    const text = `${RICH_BLOCK}\n\n${portable}\n`;
    const fs = hub({ claude: text });
    fs.file(
      paths.cwdLocalConfigFile(),
      JSON.stringify({ version: 1, sources: { cli: "/repos/cli" } }),
    );
    const plan = await planHubMigration(fs, paths);
    expect(plan.conflicts).toEqual([]);
    expect(plan.markers).toMatchObject([{ drops_duplicate: true }]);
    expect(await fs.readText(HUB)).toBe(text);
    const applied = await applyHubMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);
    expect((await fs.readText(HUB)).match(/WORKFLOW-HUB-START/g)).toHaveLength(1);
  });

  it("sin la ruta local no adivina que (local) equivale a una absoluta vieja", async () => {
    const portable = APPENDED_STUB.replace(
      "_Sin fuentes declaradas. Edita manualmente o usa `project-md-upsert --init`._",
      "| Alias | Path | Rama principal |\n|---|---|---|\n| cli | (local) | main |",
    );
    const fs = hub({ claude: `${RICH_BLOCK}\n\n${portable}\n` });
    const plan = await planHubMigration(fs, paths);
    expect(plan.markers).toEqual([]);
    expect(plan.conflicts.map((conflict) => conflict.reason)).toEqual(["duplicado_con_contenido"]);
  });

  it("el histórico la da por activa y la carpeta ya tiene su centinela", async () => {
    const fs = hub({
      history: history("| 007-triage | 2025-11-03 | active | — |"),
      folders: [{ name: "session007-triage", closed: true }],
    });
    const plan = await planHubMigration(fs, paths);

    expect(plan.sentinels).toEqual([]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.subject).toBe("session007-triage");
    expect(plan.conflicts[0]?.reason).toBe("estado_divergente");

    const before = await fs.readText(HISTORY);
    const applied = await applyHubMigration(fs, paths);
    if ("error" in applied) throw new Error(applied.error);
    expect(await fs.readText(HISTORY)).toBe(before);
    expect(applied.conflicts).toHaveLength(1);
  });

  it("un estado que no es ni active ni closed no se interpreta", async () => {
    const fs = hub({
      history: history("| 007-triage | 2025-11-03 | en curso | — |"),
      folders: [{ name: "session007-triage" }],
    });
    const plan = await planHubMigration(fs, paths);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["estado_ilegible"]);
    expect(plan.sentinels).toEqual([]);
  });

  it("un número que comparten dos carpetas no habilita a escribir la fila de ninguna", async () => {
    const fs = hub({
      history: history("| 007-triage | 2025-11-03 | closed | — |"),
      folders: [{ name: "session007-triage" }, { name: "007-otra-quick" }],
    });
    const plan = await planHubMigration(fs, paths);

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
    const plan = await planHubMigration(fs, paths);

    expect(plan.markers).toEqual([]);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["duplicado_con_contenido"]);
    expect(plan.conflicts[0]?.detail).toContain("/repos/otra");

    const before = await fs.readText(HUB);
    await applyHubMigration(fs, paths);
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
    const plan = await planHubMigration(fs, paths);
    expect(plan.markers).toEqual([]);
    expect(plan.sentinels).toEqual([]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.legacy).toEqual([]);

    await applyHubMigration(fs, paths);
    // Sólo el candado de la operación tocó el disco.
    expect([...fs.writes.keys()].filter((p) => !p.endsWith(".lock"))).toEqual([]);
  });

  it("una sesión reabierta con `--reopen` NO se vuelve a cerrar", async () => {
    // `session-load --reopen` borra el centinela y deja la fila diciendo
    // `closed`: exactamente la forma del hueco fantasma, y sin embargo lo
    // correcto acá es no tocar nada.
    const fs = hub({
      history: history("| 001-uno-quick | 2026-01-01 | closed | — |"),
      folders: [{ name: "001-uno-quick" }],
    });
    const plan = await planHubMigration(fs, paths);
    expect(plan.sentinels).toEqual([]);
    expect(plan.conflicts).toEqual([]);

    await applyHubMigration(fs, paths);
    expect(await fs.exists(`${SESSIONS}/001-uno-quick/.closed`)).toBe(false);
  });

  it("un workspace sin CLAUDE.md ni histórico no rompe", async () => {
    const fs = new MemFs({ lenient: true });
    fs.dir("/cwd/.workflow");
    const plan = await planHubMigration(fs, paths);
    expect(plan.next_correlative).toBe("001");
    expect(plan.conflicts).toEqual([]);
  });
});

// ─── la superficie del comando ───────────────────────────────────────────────

describe("aw hub-migrate", () => {
  it("sin --apply es de sólo lectura y ofrece el comando que aplica", async () => {
    const fs = hub({
      claude: `${RICH_BLOCK}\n`,
      folders: [{ name: "session007-triage" }],
    });
    const result = await hubMigrateCommand.execute(parseArgv(["hub-migrate"]), context(fs));
    expect(result.ok).toBe(true);
    expect(fs.writes.size).toBe(0);
    if (result.data?.action !== "preview") throw new Error("esperaba una vista previa");
    expect(result.data.pending).toBe(2);
    expect(result.data.next).toBe("aw hub-migrate --apply");
    expect(result.data.markers[0]?.file).toBe("CLAUDE.md");

    const human = hubMigrateCommand.renderHuman?.(result, { detail: false }) ?? "";
    expect(human).toContain("aw hub-migrate --apply");
    expect(human).toContain("AGENT-WORKFLOW-PROJECT → WORKFLOW-HUB");
  });

  it("con --apply escribe y reporta lo que hizo", async () => {
    const fs = hub({
      claude: `${RICH_BLOCK}\n`,
      history: history("| 007-triage | 2025-11-03 | closed | — |"),
      folders: [{ name: "session007-triage" }],
    });
    const result = await hubMigrateCommand.execute(
      parseArgv(["hub-migrate", "--apply"]),
      context(fs),
    );
    expect(result.ok).toBe(true);
    if (result.data?.action !== "apply") throw new Error("esperaba una aplicación");
    expect(result.data.sentinels_seeded).toEqual(["session007-triage"]);
    expect(await fs.exists(`${SESSIONS}/session007-triage/.closed`)).toBe(true);
  });

  it("`--apply` seguido de un positional no se traga el token y sigue aplicando", async () => {
    const args = parseArgv(["hub-migrate", "--apply", "algo"]);
    expect(args.flags.has("--apply")).toBe(true);
    expect(args.values.has("apply")).toBe(false);
  });

  it("un flag que no conoce lo rechaza en vez de ejecutarse como si nada", async () => {
    const fs = hub({ claude: `${RICH_BLOCK}\n` });
    const result = await dispatch(
      hubMigrateCommand,
      parseArgv(["hub-migrate", "--force"]),
      context(fs),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_FLAG");
    expect(result.error?.message).toContain("--force");
    expect(fs.writes.size).toBe(0);
  });
});
