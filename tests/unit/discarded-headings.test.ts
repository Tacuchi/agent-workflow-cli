// La lista de descartados del tablero: qué encabezados y qué listas reconoce.
//
// Los dos defectos que estos tests cierran hicieron desaparecer trabajo diferido
// REAL, en silencio: `Deferred`/`Excluded` eran los únicos dos encabezados sin
// forma en español de toda la tabla de alias, y el lector de ítems descartaba una
// lista numerada entera. Los diferidos de tres sesiones consecutivas no existieron
// para `aw status` hasta que se les cambió el encabezado y la lista a mano.

import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 7, 5, 12, 0, 0);

function index(fs: MemFs) {
  return buildWorklineIndex(
    fs,
    fakeEnv,
    new PathsService(normalizeNamespace("workflow"), "/home", "/cwd"),
    { now: NOW },
  );
}

/** Una sesión cerrada con el artefacto que el caso necesita. */
function session(artifact: "BACKLOG" | "CHECKPOINT", body: string): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/.keep", "");
  const dir = "/cwd/.workflow/sessions/010-x-quick";
  fs.file(`${dir}/SESSION.md`, "# SESSION\n\n## Objective\nx\n");
  fs.file(`${dir}/${artifact}.md`, body);
  fs.file(`${dir}/.closed`, "");
  return fs;
}

async function texts(fs: MemFs): Promise<string[]> {
  return (await index(fs)).discarded.map((d) => d.text);
}

describe("lista de descartados — encabezado y forma de lista", () => {
  // Los cuatro casos cruzados: idioma × forma de lista. Antes sólo pasaba el primero.
  it("inglés + guion", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Deferred\n\n- alfa\n- beta\n"))).toEqual([
      "alfa",
      "beta",
    ]);
  });

  it("inglés + lista numerada", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Deferred\n\n1. alfa\n2. beta\n"))).toEqual([
      "alfa",
      "beta",
    ]);
  });

  it("español + guion", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Diferido\n\n- alfa\n- beta\n"))).toEqual([
      "alfa",
      "beta",
    ]);
  });

  it("español + lista numerada", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Diferido\n\n1. alfa\n2. beta\n"))).toEqual([
      "alfa",
      "beta",
    ]);
  });

  it("`## Excluido` del CHECKPOINT también, y se distingue del diferido", async () => {
    const out = await index(session("CHECKPOINT", "# C\n\n## Excluido\n\n- fuera\n"));
    expect(out.discarded).toHaveLength(1);
    expect(out.discarded[0]?.kind).toBe("excluded");
    expect(out.discarded[0]?.text).toBe("fuera");
  });

  it("la variante con `)` en la lista ordenada también cuenta", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Diferido\n\n1) alfa\n2) beta\n"))).toEqual([
      "alfa",
      "beta",
    ]);
  });

  // REGRESIÓN: los artefactos legacy traen el sufijo, y el lector que los toleraba
  // es justo el que se cambió. Si esto rompe, se ganó un idioma a costa del sufijo.
  it("el sufijo legacy sigue reconociéndose, en inglés y en español", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Deferred (text):\n\n- legacy\n"))).toEqual([
      "legacy",
    ]);
    expect(
      await texts(session("BACKLOG", "# B\n\n## Diferido (lista):\n\n1. legacy-es\n")),
    ).toEqual(["legacy-es"]);
  });

  it("el placeholder de plantilla sigue descartándose, sea la lista de guion o numerada", async () => {
    expect(
      await texts(session("BACKLOG", "# B\n\n## Diferido\n\n1. List of deferred items\n2. real\n")),
    ).toEqual(["real"]);
  });

  it("un BACKLOG sin sección de diferidos no aporta nada", async () => {
    expect(await texts(session("BACKLOG", "# B\n\n## Otra cosa\n\n- x\n"))).toEqual([]);
  });
});
