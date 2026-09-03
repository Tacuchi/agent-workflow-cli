import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  amendDocument,
  amendmentLedgerPath,
  amendmentsOf,
  revertAmendment,
} from "../../src/application/amend-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { amendCommand } from "../../src/cli/commands/amend.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { groupCommands } from "../../src/cli/help-groups.js";
import { parseArgv } from "../../src/cli/parser.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * La vía directa: corregir la REDACCIÓN de un documento cerrado en un solo acto.
 *
 * Lo que estas pruebas fijan no es que escriba, sino DÓNDE está la línea. Una
 * frase se corrige y queda constancia con su preimagen exacta; lo que mueve el
 * contrato se rechaza y nombra el refinamiento, comprobado con lo que el checkout
 * ya sabe calcular; la reversión devuelve los bytes originales; y un documento
 * que se movió entre la lectura y la escritura detiene el acto sin escribir.
 */

const fs = new NodeFileSystem();

const SPEC = "docs/specs/041-spec-ceremonia.md";
const PLAN = "docs/plans/041-plan-ceremonia.md";

const specText = [
  "---",
  "status: ready-for-plan",
  "---",
  "",
  "# Spec 041 — ceremonia",
  "",
  "## Requirement",
  "Que la compuerta juzge por referente y no por vocabulario.",
  "",
  "## Scope",
  "- In: la compuerta de cierre",
  "- Out: el refinamiento",
  "",
  "## Acceptance criteria",
  "- [ ] AC-01: una cláusula que describe una comprobación reproducible se acepta.",
  "",
].join("\n");

const planText = [
  "# Plan 041 — ceremonia",
  "",
  "> Derived from docs/specs/041-spec-ceremonia.md",
  "> Estado: done",
  "> Cierre: 2026-09-03 · sesión 164",
  "> Límite de ejecución: checkout",
  "",
  "## Solution",
  "El juicio pasa de vocabulario a referente, y la lista se conserba como compatibilidad.",
  "",
  "## Tasks",
  "",
  "### F1 — La compuerta juzga localidad",
  "> Estado: validada",
  "> Fuentes: cli",
  "",
  "- [x] T1.1 — Definir el referente _(fuentes: cli)_",
  "",
  "**Validación de fase:** `npm test` sobre `tests/unit/source-boundary-policy.test.ts` en verde.",
  "**Condición de salida:** ninguna cláusula con referente es rechazada.",
  "",
  "## Execution batches",
  "",
  "- B1 · isolated · F1",
  "",
  "## Validations",
  "",
  "- La suite completa corre con `npm test` al cierre del lote.",
  "",
].join("\n");

/** Un sistema de archivos que mueve el documento justo después de leerlo. */
class MovingFs extends NodeFileSystem {
  private armed = true;
  constructor(
    private readonly suffix: string,
    private readonly after: string,
  ) {
    super();
  }
  override async readText(path: string): Promise<string> {
    const text = await super.readText(path);
    if (this.armed && path.endsWith(this.suffix)) {
      this.armed = false;
      await super.writeText(path, this.after);
    }
    return text;
  }
}

describe("aw amend — la corrección directa de una redacción cerrada", () => {
  let workdir: string;
  let paths: PathsService;
  let env: FakeEnv;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-amend-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    env = new FakeEnv(workdir, workdir);
    await mkdir(join(workdir, "docs", "specs"), { recursive: true });
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(join(workdir, SPEC), specText, "utf8");
    await writeFile(join(workdir, PLAN), planText, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const read = (relative: string): Promise<string> => readFile(join(workdir, relative), "utf8");

  it("corrige una frase de la prosa y deja constancia con su preimagen exacta", async () => {
    const applied = await amendDocument(fs, env, paths, {
      target: PLAN,
      from: "se conserba como compatibilidad",
      to: "se conserva como compatibilidad",
      declaration:
        "es un error de tipeo en la prosa de la solución: no cambia alcance, criterios ni reglas",
    });
    if (applied.status === "failed") throw new Error(`esperaba corregir: ${applied.failure.code}`);

    expect(await read(PLAN)).toContain("se conserva como compatibilidad");
    expect(applied.written).toEqual([PLAN]);

    const events = await amendmentsOf(fs, paths, PLAN);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({ version: 1, event: "amended" });
    expect(event?.amendment).toMatchObject({
      document: PLAN,
      // El origen es lo que la distingue de un cambio nacido de un refinamiento.
      origin: "direct",
      from: "se conserba como compatibilidad",
      to: "se conserva como compatibilidad",
    });
    expect(event?.amendment.declaration).toContain("error de tipeo");
    expect(event?.amendment.before_digest).not.toBe(event?.amendment.after_digest);
    // Una línea por registro, append-only: la forma que el registro de reservas ya usa.
    const ledger = await readFile(amendmentLedgerPath(paths), "utf8");
    expect(ledger.trimEnd().split("\n")).toHaveLength(1);
  });

  it("sin declaración no escribe nada: lo que se registra es lo que se declaró", async () => {
    const refused = await amendDocument(fs, env, paths, {
      target: PLAN,
      from: "se conserba",
      to: "se conserva",
      declaration: "   ",
    });
    if (refused.status !== "failed") throw new Error("esperaba un rechazo");
    expect(refused.failure.code).toBe("AMEND_DECLARATION_MISSING");
    expect(await read(PLAN)).toBe(planText);
  });

  it("rechaza lo que mueve el contenido funcional de una spec, y nombra el refinamiento", async () => {
    const refused = await amendDocument(fs, env, paths, {
      target: SPEC,
      from: "- [ ] AC-01: una cláusula que describe una comprobación reproducible se acepta.",
      to: "- [ ] AC-01: una cláusula que describe una comprobación reproducible se rechaza.",
      declaration: "digo que es redacción, aunque invierta el criterio",
    });
    if (refused.status !== "failed") throw new Error("esperaba un rechazo estructural");
    expect(refused.failure.code).toBe("AMEND_CONTRACT_TOUCHED");
    expect(refused.failure.message).toContain("el contenido funcional");
    expect(refused.failure.action).toContain("/w:spec-refine");
    // Nada se escribió, y la declaración no alcanzó para pasar.
    expect(await read(SPEC)).toBe(specText);
    expect(await amendmentsOf(fs, paths, SPEC)).toEqual([]);
  });

  it("rechaza lo que altera una cláusula de cierre del plan, aunque parezca redacción", async () => {
    const refused = await amendDocument(fs, env, paths, {
      target: PLAN,
      from: "**Condición de salida:** ninguna cláusula con referente es rechazada.",
      to: "**Condición de salida:** casi ninguna cláusula con referente es rechazada.",
      declaration: "es una aclaración de redacción",
    });
    if (refused.status !== "failed") throw new Error("esperaba un rechazo estructural");
    expect(refused.failure.code).toBe("AMEND_CONTRACT_TOUCHED");
    expect(refused.failure.message).toContain("cláusulas de cierre");
    expect(refused.failure.action).toContain("/w:plan-refine");
    expect(await read(PLAN)).toBe(planText);
  });

  it("rechaza corregir un documento que todavía está abierto", async () => {
    await writeFile(
      join(workdir, PLAN),
      planText.replace("> Estado: done", "> Estado: open"),
      "utf8",
    );
    const refused = await amendDocument(fs, env, paths, {
      target: PLAN,
      from: "se conserba",
      to: "se conserva",
      declaration: "redacción",
    });
    if (refused.status !== "failed") throw new Error("esperaba un rechazo");
    expect(refused.failure.code).toBe("AMEND_TARGET_OPEN");
    expect(refused.failure.action).toContain("el recorrido que lo tiene");
  });

  it("la reversión devuelve los bytes exactos y queda como su propio evento", async () => {
    const original = await read(PLAN);
    const applied = await amendDocument(fs, env, paths, {
      target: PLAN,
      from: "se conserba como compatibilidad",
      to: "se conserva como compatibilidad",
      declaration: "error de tipeo",
    });
    if (applied.status === "failed") throw new Error("esperaba corregir");
    expect(await read(PLAN)).not.toBe(original);

    const reverted = await revertAmendment(fs, env, paths, applied.amendment.id);
    if (reverted.status === "failed")
      throw new Error(`esperaba revertir: ${reverted.failure.code}`);

    // Ida y vuelta: los bytes originales, no una reconstrucción parecida.
    expect(await read(PLAN)).toBe(original);
    const events = await amendmentsOf(fs, paths, PLAN);
    expect(events.map((event) => event.event)).toEqual(["amended", "reverted"]);
    expect(events[1]?.cause).toContain(applied.amendment.id);

    // Y no se revierte dos veces la misma corrección.
    const again = await revertAmendment(fs, env, paths, applied.amendment.id);
    if (again.status !== "failed") throw new Error("esperaba un rechazo");
    expect(again.failure.code).toBe("AMEND_RECORD_UNKNOWN");
  });

  it("un documento movido entre la lectura y la escritura detiene el acto sin escribir", async () => {
    const moved = planText.replace(
      "El juicio pasa de vocabulario a referente",
      "Otra persona reescribió esta línea",
    );
    const movingFs = new MovingFs("041-plan-ceremonia.md", moved);
    const refused = await amendDocument(movingFs, env, paths, {
      target: PLAN,
      from: "se conserba como compatibilidad",
      to: "se conserva como compatibilidad",
      declaration: "error de tipeo",
    });
    if (refused.status !== "failed") throw new Error("esperaba que el compare-and-swap lo detenga");
    // El código es el de la publicación, no uno inventado acá: dice QUÉ garantía paró la escritura.
    expect(refused.failure.code).toBe("PROPOSAL_BASE_STALE");
    // Lo que quedó en disco es lo que escribió el otro, sin la corrección encima.
    expect(await read(PLAN)).toBe(moved);
    expect(await amendmentsOf(fs, paths, PLAN)).toEqual([]);
  });

  it("el comando está registrado, en su grupo, y sus dos proyecciones dicen lo mismo", async () => {
    expect(ALL_COMMANDS.map((command) => command.name)).toContain("amend");
    const group = groupCommands(ALL_COMMANDS.map((command) => command.name)).find((entry) =>
      entry.commands.includes("amend"),
    );
    expect(group?.name).toBe("Orchestration");

    const args = parseArgv([
      "amend",
      "apply",
      PLAN,
      "--de",
      "se conserba como compatibilidad",
      "--a",
      "se conserva como compatibilidad",
      "--declaracion",
      "error de tipeo en la prosa",
    ]);
    const result = await amendCommand.execute(args, {
      fs,
      env,
      paths,
      git: undefined,
      runtime: undefined,
    } as unknown as Parameters<typeof amendCommand.execute>[1]);
    expect(result.ok).toBe(true);
    if (result.data === undefined || result.data.action !== "apply") {
      throw new Error("esperaba el resultado de una corrección");
    }
    const human = amendCommand.renderHuman?.(result, { detail: false }) ?? "";
    // Nada que la proyección humana diga sale de otro lado que del mismo objeto.
    expect(human).toContain(result.data.amendment.id);
    expect(human).toContain(PLAN);
    expect(human).toContain(result.data.amendment.declaration);
    expect(human).toContain(`aw amend revert ${result.data.amendment.id}`);
  });

  it("un fragmento que aparece dos veces no se corrige a ciegas", async () => {
    // "ceremonia" está en el título y en la línea 'Derived from': cuál de las
    // dos se corrige no se puede adivinar, y adivinarlo sería escribir en la
    // cabecera del plan creyendo corregir su título.
    const refused = await amendDocument(fs, env, paths, {
      target: PLAN,
      from: "ceremonia",
      to: "ceremonia proporcional",
      declaration: "precisión de redacción",
    });
    if (refused.status !== "failed") throw new Error("esperaba un rechazo por ambigüedad");
    expect(refused.failure.code).toBe("AMEND_TEXT_AMBIGUOUS");
    expect(refused.failure.action).toContain("hasta que sea único");
    expect(await read(PLAN)).toBe(planText);
  });
});
