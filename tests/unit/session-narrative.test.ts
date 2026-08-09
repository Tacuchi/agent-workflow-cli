import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runArtifactsCommand } from "../../src/application/artifacts-service.js";
import {
  readCheckpointNarrative,
  readLatestCheckpoint,
} from "../../src/application/checkpoint-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runResume } from "../../src/application/resume-service.js";
import {
  ARTIFACT_CATALOG,
  ARTIFACT_FILENAMES,
  type ArtifactKind,
} from "../../src/application/session-artifacts.js";
import {
  buildSessionNarrative,
  writeSessionNarrative,
} from "../../src/application/session-narrative.js";
import {
  NARRATIVE_BEGIN,
  NARRATIVE_END,
  renderNarrativeBlock,
  upsertNarrativeBlock,
} from "../../src/domain/session/narrative.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Una sesión se entiende desde una sola salida.
 *
 * Las preguntas que este archivo hace son las de alguien que no estuvo: qué se
 * quiso hacer, qué pasó y en qué orden, qué tareas hay, por qué se decidió lo que
 * se decidió, qué resultó, qué evidencia queda y qué sigue. Se contestan todas
 * desde la proyección, no abriendo archivos — y cada respuesta dice de qué archivo
 * salió, que es lo que la vuelve verificable en vez de creíble.
 */

const fs = new NodeFileSystem();

describe("catálogo de artefactos — cada tipo declara qué hecho posee", () => {
  const kinds = Object.keys(ARTIFACT_FILENAMES) as ArtifactKind[];

  it("ningún tipo queda sin productor, sin fuente primaria ni sin consumidores", () => {
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const role = ARTIFACT_CATALOG[kind];
      // El `Record` ya obliga a la entrada en compilación; lo que esta prueba
      // agrega es que la entrada DIGA algo: una fila con campos vacíos pasaría el
      // compilador y dejaría el tipo tan sin clasificar como si faltara.
      expect(role, kind).toBeDefined();
      expect(role.producer.trim().length, kind).toBeGreaterThan(0);
      expect(role.primary_source.trim().length, kind).toBeGreaterThan(0);
      // Un artefacto vigente que nadie lee es un artefacto que se acumula.
      if (role.legacy !== true) expect(role.consumers.length, kind).toBeGreaterThan(0);
    }
  });

  it("los tipos legacy se leen pero ningún productor vigente los escribe", () => {
    for (const kind of kinds) {
      const role = ARTIFACT_CATALOG[kind];
      if (role.legacy !== true) continue;
      expect(role.producer, kind).toContain("anteriores");
    }
  });
});

describe("lector de CHECKPOINT — uno solo, con fallback histórico", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-checkpoint-"));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const write = (body: string): Promise<void> =>
    writeFile(join(workdir, "CHECKPOINT.md"), body, "utf8");

  it("los encabezados vigentes se leen — el defecto que dejaba todo en null", async () => {
    await write(
      "# CHECKPOINT\n\n## Completed\n- se cerró F1\n\n## Pending / Next\n- arrancar F2\n",
    );
    const narrative = await readCheckpointNarrative(fs, workdir);
    expect(narrative?.completed).toContain("se cerró F1");
    expect(narrative?.pending).toContain("arrancar F2");
    // Y el lector viejo deja de mentir: sus dos campos salen de las mismas
    // secciones, así que `checkpoint-read` y el payload post-compactación ven lo
    // que `resume` siempre vio.
    const legacyShape = await readLatestCheckpoint(fs, workdir);
    expect(legacyShape?.ultimo).toContain("se cerró F1");
    expect(legacyShape?.proximo).toContain("arrancar F2");
  });

  it("una sesión escrita antes del rediseño sigue leyéndose", async () => {
    await write(
      "# CHECKPOINT\n\n## Lo último que hice\n- migré el parser\n\n## Próximo paso\n- correr la suite\n",
    );
    const narrative = await readCheckpointNarrative(fs, workdir);
    expect(narrative?.completed).toContain("migré el parser");
    expect(narrative?.pending).toContain("correr la suite");
  });
});

describe("narrativa de sesión — una entrada contesta las siete preguntas", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-narrative-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function session(folder: string, files: Record<string, string>): Promise<string> {
    const path = join(paths.cwdSessionsDir(), folder);
    await mkdir(path, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(path, name), body, "utf8");
    }
    return path;
  }

  const OPEN = {
    "SESSION.md":
      "# SESSION — arreglo-parser-quick\n\n## Objective\nArreglar el parser de estado de planes\n\n## Success criteria\n- [ ] la suite queda verde\n- [x] el parser lee las dos líneas\n",
  };

  const RESUMED = {
    ...OPEN,
    "CHECKPOINT.md":
      "# CHECKPOINT\n\n## Completed\n- el parser ya lee '> Cierre:' en su propia línea\n\n## Pending / Next\n- correr la suite completa\n\n## Open questions\n- ¿migramos los planes viejos?\n",
    // La convención del chasis: la decisión se anuncia sola en negrita y su
    // razón va debajo. Negrita a mitad de párrafo NO es una decisión, y el
    // parser único es el que sostiene esa diferencia.
    "DECISION.md":
      "# DECISION\n\n**Dos líneas y no una**\nUn bloqueo que viaja en la línea de estado se pierde al parsear.\n",
  };

  it("una sesión abierta ya contesta objetivo y tareas, y no inventa el resto", async () => {
    const path = await session("001-arreglo-parser-quick", OPEN);
    const narrative = await buildSessionNarrative(fs, paths, {
      folder: "001-arreglo-parser-quick",
      path,
    });
    expect(narrative.phase).toBe("abierta");
    expect(narrative.objective?.text).toBe("Arreglar el parser de estado de planes");
    expect(narrative.objective?.source).toEqual({ artifact: "SESSION.md", locator: "Objective" });
    // Planificado y aplicado se distinguen: una casilla marcada y una prueba
    // corrida no son la misma afirmación.
    expect(narrative.tasks.map((task) => task.state)).toEqual(["planificado", "aplicado"]);
    // Y lo que nadie escribió todavía no aparece: la narrativa se acorta, no se
    // completa desde el vecino.
    expect(narrative.results).toEqual([]);
    expect(narrative.decisions).toEqual([]);
    expect(narrative.next).toBeNull();
  });

  it("una sesión reanudada contesta las siete preguntas y cada una dice de dónde sale", async () => {
    const path = await session("002-arreglo-parser-quick", RESUMED);
    const narrative = await buildSessionNarrative(fs, paths, {
      folder: "002-arreglo-parser-quick",
      path,
    });
    expect(narrative.phase).toBe("reanudada");
    expect(narrative.objective?.text).toContain("parser");
    expect(narrative.tasks).toHaveLength(2);
    expect(narrative.decisions[0]?.text).toContain("Dos líneas y no una");
    expect(narrative.decisions[0]?.text).toContain("se pierde al parsear");
    // Y el énfasis a mitad de párrafo no se cuela como decisión.
    expect(narrative.decisions).toHaveLength(1);
    expect(narrative.results[0]?.text).toContain("'> Cierre:'");
    expect(narrative.next?.text).toContain("correr la suite");
    expect(narrative.pending.map((fact) => fact.text)).toContain("¿migramos los planes viejos?");
    // La fuente por hecho: cada respuesta nombra el archivo que la posee.
    const sources = new Set(
      [...narrative.results, ...narrative.pending, ...narrative.decisions].map(
        (fact) => fact.source.artifact,
      ),
    );
    expect(sources).toEqual(new Set(["CHECKPOINT.md", "DECISION.md"]));
    // Y el detalle técnico está enlazado, no copiado.
    expect(narrative.links.map((link) => link.label)).toEqual(["CHECKPOINT.md", "DECISION.md"]);
  });

  it("un placeholder sin llenar no es un hecho: la sesión sigue abierta", async () => {
    const path = await session("008-arreglo-parser-quick", {
      ...OPEN,
      "CHECKPOINT.md":
        "# CHECKPOINT\n\n## Completed\n_[AI: 1-3 sentences on the last concrete progress.]_\n\n## Pending / Next\n_[AI: 1-2 sentences on what remains.]_\n",
    });
    const narrative = await buildSessionNarrative(fs, paths, {
      folder: "008-arreglo-parser-quick",
      path,
    });
    // La plantilla pidiendo que la escriban no es avance, y una sesión con un
    // CHECKPOINT sin llenar no fue retomada por nadie.
    expect(narrative.results).toEqual([]);
    expect(narrative.pending).toEqual([]);
    expect(narrative.phase).toBe("abierta");
    expect(narrative.next).toBeNull();
  });

  it("una sesión cerrada se lee como cerrada aunque nadie lo declare", async () => {
    const path = await session("003-arreglo-parser-quick", RESUMED);
    await writeFile(join(path, ".closed"), "", "utf8");
    const narrative = await buildSessionNarrative(fs, paths, {
      folder: "003-arreglo-parser-quick",
      path,
    });
    expect(narrative.phase).toBe("cerrada");
  });

  it("la lectura normal esconde ids, digests y nombres de transición; --detail los muestra", async () => {
    const path = await session("004-arreglo-parser-quick", RESUMED);
    const narrative = await buildSessionNarrative(fs, paths, {
      folder: "004-arreglo-parser-quick",
      path,
    });
    narrative.sequence.push({
      state: "aplicado",
      text: "se leyeron los artefactos de la sesión",
      detail: "plan-exec.session · efectos read_only, local_additive",
      source: { artifact: ".flow-run.json", locator: "plan-exec.session" },
    });

    const plain = renderNarrativeBlock(narrative);
    expect(plain).toContain("se leyeron los artefactos de la sesión");
    expect(plain).not.toContain("plan-exec.session");
    expect(plain).not.toContain("read_only");

    const detailed = renderNarrativeBlock(narrative, { detail: true });
    expect(detailed).toContain("plan-exec.session");
    expect(detailed).toContain("read_only");
  });

  it("proyectar una sesión legacy no toca ningún archivo", async () => {
    const path = await session("005-vieja-research", {
      "OBJECTIVE.md": "# OBJETIVO\n\n## Objective\ninvestigar el índice\n",
      "CHECKPOINT.md": "# CHECKPOINT\n\n## Lo último que hice\n- leí el índice\n",
    });
    const before = await Promise.all(
      ["OBJECTIVE.md", "CHECKPOINT.md"].map(async (name) => ({
        name,
        body: await readFile(join(path, name), "utf8"),
        mtime: (await stat(join(path, name))).mtimeMs,
      })),
    );
    const narrative = await buildSessionNarrative(fs, paths, {
      folder: "005-vieja-research",
      path,
    });
    expect(narrative.objective?.text).toBe("investigar el índice");
    expect(narrative.objective?.source.artifact).toBe("OBJECTIVE.md");
    for (const file of before) {
      expect(await readFile(join(path, file.name), "utf8"), file.name).toBe(file.body);
      expect((await stat(join(path, file.name))).mtimeMs, file.name).toBe(file.mtime);
    }
    // Y una sesión sin SESSION.md no gana un bloque: escribirlo sería reescribir
    // historia para que se parezca a la proyección.
    expect(await writeSessionNarrative(fs, paths, { folder: "005-vieja-research", path })).toBe(
      false,
    );
  });

  it("el bloque administrado es idempotente y no se lee a sí mismo", async () => {
    const folder = "006-arreglo-parser-quick";
    const path = await session(folder, RESUMED);
    expect(await writeSessionNarrative(fs, paths, { folder, path })).toBe(true);
    const once = await readFile(join(path, "SESSION.md"), "utf8");
    expect(once).toContain(NARRATIVE_BEGIN);
    expect(once).toContain(NARRATIVE_END);

    await writeSessionNarrative(fs, paths, { folder, path });
    const twice = await readFile(join(path, "SESSION.md"), "utf8");
    // Un solo bloque, no dos anidados: los marcadores acotan exactamente lo que
    // esta función escribió la vez anterior.
    expect(twice.split(NARRATIVE_BEGIN)).toHaveLength(2);
    expect(twice).toBe(once);

    // Y lo que el bloque dice no vuelve a entrar como contenido: el objetivo sigue
    // siendo el de `## Objective`, no la línea que el bloque imprimió.
    const rebuilt = await buildSessionNarrative(fs, paths, { folder, path });
    expect(rebuilt.objective?.text).toBe("Arreglar el parser de estado de planes");
    expect(rebuilt.tasks).toHaveLength(2);
  });

  it("un bloque previo se reemplaza sin comerse lo que lo rodea", () => {
    const document = `# SESSION\n\n## Objective\nx\n\n${NARRATIVE_BEGIN}\nviejo\n${NARRATIVE_END}\n\n## Notas\nmías\n`;
    const next = upsertNarrativeBlock(document, `${NARRATIVE_BEGIN}\nnuevo\n${NARRATIVE_END}`);
    expect(next).toContain("nuevo");
    expect(next).not.toContain("viejo");
    expect(next).toContain("## Notas\nmías");
  });

  it("session-artifacts y resume contestan lo mismo, y el detalle técnico sigue disponible", async () => {
    const folder = "007-arreglo-parser-quick";
    await session(folder, RESUMED);
    const env = new FakeEnv(workdir, workdir);

    const artifacts = await runArtifactsCommand(fs, env, paths, { code: "007" });
    if ("sessionError" in artifacts) throw new Error("esperaba resolver la sesión");
    const resumed = await runResume(fs, env, paths, { code: "007" });
    if (resumed.status !== "proposal") throw new Error("esperaba una propuesta");

    expect(artifacts.narrative?.objective?.text).toBe(resumed.proposal.objective);
    expect(resumed.proposal.next).toBe(artifacts.narrative?.next?.text);
    // Los inventarios no se van: siguen ahí, debajo del recorrido.
    expect(artifacts.artifacts.decisiones_count).toBeGreaterThanOrEqual(0);
    expect(artifacts.artifacts.session?.criterios_count).toBe(2);

    const technical = await runArtifactsCommand(fs, env, paths, { code: "007", noNarrative: true });
    if ("sessionError" in technical) throw new Error("esperaba resolver la sesión");
    expect(technical.narrative).toBeUndefined();
    expect(technical.artifacts).toEqual(artifacts.artifacts);
  });
});
