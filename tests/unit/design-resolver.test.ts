import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import {
  resolveBaselineOnDisk,
  resolveBaselineReference,
  resolveStateAnchor,
  resolveTaskReference,
  staleHintNotice,
} from "../../src/application/design/design-resolver-service.js";
import type { SpecDesignReference } from "../../src/domain/design/reference.js";
import { MemFs } from "../helpers/mem-fs.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const MANIFEST = fixture("manifest-maximal.json");
const SCREEN = fixture("SCR-001-r002-formulario-alta.md");
const DIGESTS = (JSON.parse(MANIFEST) as { baselines: Array<{ digest: string }> }).baselines.map(
  (b) => b.digest,
);
const [DIGEST_R1, DIGEST_R2] = DIGESTS as [string, string];

const WS = "/ws";
const DOC = "docs/specs/046-spec.md";

function workspace(folder = "001-design-alta", manifest = MANIFEST): MemFs {
  return new MemFs().file(`${WS}/docs/designs/${folder}/design-manifest.json`, manifest);
}

function reference(over: Partial<SpecDesignReference> = {}): SpecDesignReference {
  return {
    baseline: { package: "DES-001", revision: 2 },
    baseline_hint: "docs/designs/001-design-alta/baselines/DES-001-r002.json",
    digest: DIGEST_R2,
    ...over,
  };
}

async function resolve(fs: MemFs, ref: SpecDesignReference) {
  return resolveBaselineReference(await readDesignIndex(fs, WS), ref, DOC);
}

describe("resolveBaselineReference — el hint válido", () => {
  it("resuelve y reporta el hint como vigente", async () => {
    const result = await resolve(workspace(), reference());
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.hint).toBe("valid");
    expect(result.value.package_id).toBe("DES-001");
    expect(result.value.revision).toBe(2);
    expect(result.value.path).toBe("docs/designs/001-design-alta/baselines/DES-001-r002.json");
    expect(result.value.declared_hint).toBeUndefined();
  });
});

describe("resolveBaselineReference — el hint stale se repara", () => {
  // El caso que justifica todo el diseño: alguien renombró la carpeta, y una
  // tarea escrita hace un año tiene que seguir resolviendo.
  it("resuelve por identidad y digest, y avisa que el hint quedó viejo", async () => {
    const result = await resolve(workspace("042-design-altas-y-bajas"), reference());
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.hint).toBe("stale");
    expect(result.value.path).toBe(
      "docs/designs/042-design-altas-y-bajas/baselines/DES-001-r002.json",
    );
    expect(result.value.declared_hint).toBe(
      "docs/designs/001-design-alta/baselines/DES-001-r002.json",
    );
    expect(result.value.digest).toBe(DIGEST_R2);
  });
});

describe("resolveBaselineReference — el hint ambiguo y el que no coincide", () => {
  it("falla cuando dos packages reclaman la misma identidad", async () => {
    const fs = workspace();
    fs.file(`${WS}/docs/designs/002-design-copia/design-manifest.json`, MANIFEST);
    const result = await resolve(fs, reference());
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.code).toBe("DESIGN_REFERENCE_AMBIGUOUS");
    expect(result.failure.message).toContain("001-design-alta");
    expect(result.failure.message).toContain("002-design-copia");
  });

  it("falla cuando el package no está", async () => {
    const result = await resolve(new MemFs({ lenient: true }), reference());
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.code).toBe("DESIGN_REFERENCE_MISSING");
    expect(result.failure.action).toContain("aw designs");
  });

  it("falla cuando la revisión no se publicó", async () => {
    const result = await resolve(
      workspace(),
      reference({ baseline: { package: "DES-001", revision: 9 } }),
    );
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.message).toContain("no publicó la revisión r9");
  });

  it("falla cuando el digest no coincide, y dice que no se edita una revisión publicada", async () => {
    const result = await resolve(workspace(), reference({ digest: `sha256:${"9".repeat(64)}` }));
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.code).toBe("DESIGN_REFERENCE_DIGEST_MISMATCH");
    expect(result.failure.action).toContain("creá la siguiente");
  });
});

describe("resolveBaselineReference — publicar la siguiente no pierde la anterior", () => {
  // La condición de salida de la fase: una revisión anterior nunca se pierde al
  // publicar la siguiente. El fixture ya tiene r1 y r2 publicadas.
  it("una referencia fijada en @r1 sigue resolviendo íntegra con @r2 publicada", async () => {
    const fs = workspace();
    const pinned = reference({
      baseline: { package: "DES-001", revision: 1 },
      baseline_hint: "docs/designs/001-design-alta/baselines/DES-001-r001.json",
      digest: DIGEST_R1,
    });

    const result = await resolve(fs, pinned);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.revision).toBe(1);
    expect(result.value.digest).toBe(DIGEST_R1);
    expect(result.value.hint).toBe("valid");

    // Y la vigente sigue siendo r2: fijar r1 no cambia cuál es la actual.
    const current = await resolve(fs, reference());
    if (!current.ok) throw new Error(current.failure.message);
    expect(current.value.revision).toBe(2);
  });
});

describe("resolveTaskReference — el artefacto exacto de una tarea", () => {
  it("resuelve el flow que la tarea fija", async () => {
    const index = await readDesignIndex(workspace(), WS);
    const result = resolveTaskReference(
      index,
      {
        baseline: { package: "DES-001", revision: 2 },
        artifact: { package: "DES-001", artifact: "FLW-001", revision: 2 },
        raw: "DES-001@r2 / FLW-001@r2",
      },
      [reference()],
      "docs/plans/012-plan.md",
    );
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.artifact_id).toBe("FLW-001");
    expect(result.value.artifact_path).toBe(
      "docs/designs/001-design-alta/flows/FLW-001-r002-alta-miembro.md",
    );
  });

  it("falla si el catálogo no tiene esa revisión del artefacto", async () => {
    const index = await readDesignIndex(workspace(), WS);
    const result = resolveTaskReference(
      index,
      {
        baseline: { package: "DES-001", revision: 2 },
        artifact: { package: "DES-001", artifact: "FLW-001", revision: 9 },
        raw: "DES-001@r2 / FLW-001@r9",
      },
      [reference()],
      "docs/plans/012-plan.md",
    );
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.message).toContain("no contiene FLW-001@r9");
  });

  it("falla si la tarea cita un package que su spec no fijó", async () => {
    const index = await readDesignIndex(workspace(), WS);
    const result = resolveTaskReference(
      index,
      {
        baseline: { package: "DES-002", revision: 1 },
        artifact: { package: "DES-002", artifact: "SCR-001", revision: 1 },
        raw: "DES-002@r1 / SCR-001@r1",
      },
      [reference()],
      "docs/plans/012-plan.md",
    );
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.message).toContain("las referencias declaradas son: DES-001@r2");
  });
});

describe("resolveStateAnchor — un estado resuelve solo si su screen lo declara", () => {
  function withScreen(): MemFs {
    const fs = workspace();
    fs.file(`${WS}/docs/designs/001-design-alta/screens/SCR-001-r002-formulario-alta.md`, SCREEN);
    return fs;
  }

  async function resolveState(anchor: string) {
    const fs = withScreen();
    const index = await readDesignIndex(fs, WS);
    const task = resolveTaskReference(
      index,
      {
        baseline: { package: "DES-001", revision: 2 },
        artifact: { package: "DES-001", artifact: "SCR-001", revision: 1, state: anchor },
        raw: `DES-001@r2 / SCR-001@r1#${anchor}`,
      },
      [reference()],
      "docs/plans/012-plan.md",
    );
    if (!task.ok) throw new Error(task.failure.message);
    // El catálogo apunta a r1; el archivo del fixture es r2. Reapuntamos para
    // resolver contra un documento real sin inventar otro fixture.
    return resolveStateAnchor(
      fs,
      WS,
      {
        ...task.value,
        artifact_path: "docs/designs/001-design-alta/screens/SCR-001-r002-formulario-alta.md",
      },
      "docs/plans/012-plan.md",
    );
  }

  it("resuelve un anchor que la screen declara", async () => {
    const result = await resolveState("error");
    expect(result.ok).toBe(true);
  });

  it("falla nombrando los estados que sí existen", async () => {
    const result = await resolveState("cargando");
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.message).toContain("no declara el estado '#cargando'");
    expect(result.failure.action).toContain("default, error");
  });

  it("falla cuando el archivo que el catálogo promete no está", async () => {
    const index = await readDesignIndex(workspace(), WS);
    const result = await resolveStateAnchor(
      workspace(),
      WS,
      {
        hint: "valid",
        package_id: "DES-001",
        package_path: "docs/designs/001-design-alta",
        revision: 2,
        digest: DIGEST_R2,
        path: "docs/designs/001-design-alta/baselines/DES-001-r002.json",
        artifact_id: "SCR-001",
        artifact_revision: 1,
        artifact_path: "docs/designs/001-design-alta/screens/SCR-001-r001-formulario-alta.md",
        state: "default",
      },
      "docs/plans/012-plan.md",
    );
    expect(index.packages).toHaveLength(1);
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.message).toContain("no existe");
  });
});

describe("resolveBaselineReference — la llave es el TRIPLE, no el id", () => {
  // La spec busca "una coincidencia única por package, revisión y digest".
  // Con dos carpetas reclamando la identidad pero una sola publicando ESTA
  // revisión con ESTE digest, hay una sola respuesta — y una referencia escrita
  // hace un año se la merece.
  it("resuelve cuando dos packages comparten id y solo uno publicó esa revisión", async () => {
    const otro = MANIFEST.replace(
      /"baselines": \[[\s\S]*?\n {2}\],/,
      [
        '"baselines": [',
        "    {",
        '      "revision": 1,',
        '      "path": "baselines/DES-001-r001.json",',
        `      "digest": "sha256:${"7".repeat(64)}",`,
        '      "parent_baseline": null,',
        '      "published": "2026-07-30"',
        "    }",
        "  ],",
      ].join("\n"),
    )
      .replace(/"current_baseline": \{[\s\S]*?\n {2}\},/, '"current_baseline": null,')
      .replace(/"currentness": \[[\s\S]*?\n {2}\],/, '"currentness": [],')
      .replace(
        /"governance": \{[\s\S]*?\n {2}\},/,
        '"governance": { "reviews": [], "revocations": [] },',
      )
      .replace(/"flows": \[[\s\S]*?\n {4}\],/, '"flows": [],')
      .replace(/"screens": \[[\s\S]*?\n {4}\],/, '"screens": [],');

    const fs = workspace();
    fs.file(`${WS}/docs/designs/077-design-homonimo/design-manifest.json`, otro);

    const result = await resolve(fs, reference());
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.package_path).toBe("docs/designs/001-design-alta");
    expect(result.value.digest).toBe(DIGEST_R2);
  });

  it("una carpeta que declara la identidad y no valida se nombra como rota, no como ausente", async () => {
    const fs = new MemFs().file(
      `${WS}/docs/designs/003-design-roto/design-manifest.json`,
      MANIFEST.replace('"created": "2026-08-02"', '"created": "ayer"'),
    );
    const result = await resolve(fs, reference());
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.code).toBe("DESIGN_REFERENCE_PACKAGE_INVALID");
    expect(result.failure.message).toContain("003-design-roto");
    expect(result.failure.message).toContain("declara DES-001");
  });

  it("cuando la revisión no existe, la acción enumera las que sí", async () => {
    const result = await resolve(
      workspace(),
      reference({ baseline: { package: "DES-001", revision: 9 } }),
    );
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.action).toContain("r1, r2");
  });
});

describe("los fail-open que cazó el review gate", () => {
  it("la tarea resuelve contra el baseline que ELLA fija, no contra el de la spec", async () => {
    const index = await readDesignIndex(workspace(), WS);
    const enR1 = resolveTaskReference(
      index,
      {
        baseline: { package: "DES-001", revision: 1 },
        artifact: { package: "DES-001", artifact: "FLW-001", revision: 1 },
        raw: "DES-001@r1 / FLW-001@r1",
      },
      [reference()], // la spec fija @r2
      "docs/plans/012-plan.md",
    );
    if (enR1.ok) throw new Error("esperaba un fallo: @r1 no está declarada");
    expect(enR1.failure.message).toContain("la tarea fija DES-001@r1");

    // Con el baseline declarado, resuelve contra ESA revisión.
    const declarado = reference({
      baseline: { package: "DES-001", revision: 1 },
      baseline_hint: "docs/designs/001-design-alta/baselines/DES-001-r001.json",
      digest: DIGEST_R1,
    });
    const ok = resolveTaskReference(
      index,
      {
        baseline: { package: "DES-001", revision: 1 },
        artifact: { package: "DES-001", artifact: "FLW-001", revision: 1 },
        raw: "DES-001@r1 / FLW-001@r1",
      },
      [reference(), declarado],
      "docs/plans/012-plan.md",
    );
    if (!ok.ok) throw new Error(ok.failure.message);
    expect(ok.value.revision).toBe(1);
    expect(ok.value.digest).toBe(DIGEST_R1);
  });

  it("el hint viejo se REPORTA con acción correctiva, no solo se marca", async () => {
    const result = await resolve(workspace("042-design-altas-y-bajas"), reference());
    if (!result.ok) throw new Error(result.failure.message);
    const notice = staleHintNotice(result.value, DOC);
    expect(notice?.code).toBe("DESIGN_HINT_STALE");
    expect(notice?.action).toContain("042-design-altas-y-bajas");
    expect(notice?.action).toContain("sigue siendo válida");

    // Y sobre un hint vigente no inventa un aviso.
    const vigente = await resolve(workspace(), reference());
    if (!vigente.ok) throw new Error(vigente.failure.message);
    expect(staleHintNotice(vigente.value, DOC)).toBeNull();
  });

  it("un dossier movido a una SUBCARPETA de docs/designs/ sigue resolviendo", async () => {
    const fs = new MemFs().file(
      `${WS}/docs/designs/familia/alta/001-design-alta/design-manifest.json`,
      MANIFEST,
    );
    const result = await resolve(fs, reference());
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.hint).toBe("stale");
    expect(result.value.path).toBe(
      "docs/designs/familia/alta/001-design-alta/baselines/DES-001-r002.json",
    );
  });
});

describe("la condición de salida, DEMOSTRADA publicando", () => {
  // El test anterior usaba un fixture que ya venía con r1 y r2. Eso afirma la
  // propiedad, no la demuestra. Acá se parte de un package con SOLO r1, se fija
  // una referencia, se publica r2, y se vuelve a resolver la MISMA referencia.
  it("publicar @r2 no toca una referencia fijada en @r1", async () => {
    const soloR1 = JSON.parse(MANIFEST) as Record<string, unknown>;
    const todos = soloR1.baselines as Array<Record<string, unknown>>;
    soloR1.baselines = [todos[0]];
    soloR1.current_baseline = {
      revision: 1,
      path: "baselines/DES-001-r001.json",
      digest: DIGEST_R1,
    };
    (soloR1.governance as { revocations: unknown[] }).revocations = [];
    (soloR1.governance as { reviews: Array<Record<string, unknown>> }).reviews[0].target =
      "DES-001@r1";

    const antes = workspace("001-design-alta", JSON.stringify(soloR1));
    const fijada = reference({
      baseline: { package: "DES-001", revision: 1 },
      baseline_hint: "docs/designs/001-design-alta/baselines/DES-001-r001.json",
      digest: DIGEST_R1,
    });

    const primero = await resolve(antes, fijada);
    if (!primero.ok) throw new Error(primero.failure.message);
    expect(primero.value.revision).toBe(1);

    // Ahora se publica r2: el manifest completo del fixture ES ese estado.
    const despues = workspace("001-design-alta", MANIFEST);
    const segundo = await resolve(despues, fijada);
    if (!segundo.ok) throw new Error(segundo.failure.message);
    expect(segundo.value).toEqual(primero.value);
  });
});

describe("resolveStateAnchor — el documento que no valida como screen", () => {
  it("falla cerrado y cita el primer defecto del documento", async () => {
    const fs = workspace();
    fs.file(
      `${WS}/docs/designs/001-design-alta/screens/SCR-001-r002-formulario-alta.md`,
      SCREEN.replace("schema: workline.ui-screen/v1", "schema: workline.ui-screen/v9"),
    );
    const result = await resolveStateAnchor(
      fs,
      WS,
      {
        hint: "valid",
        package_id: "DES-001",
        package_path: "docs/designs/001-design-alta",
        revision: 2,
        digest: DIGEST_R2,
        path: "docs/designs/001-design-alta/baselines/DES-001-r002.json",
        artifact_id: "SCR-001",
        artifact_revision: 2,
        artifact_path: "docs/designs/001-design-alta/screens/SCR-001-r002-formulario-alta.md",
        state: "default",
      },
      DOC,
    );
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failure.message).toContain("no valida como screen");
    expect(result.failure.action).toContain("versión de formato");
  });
});

describe("resolveBaselineOnDisk — resolver no es lo mismo que existir", () => {
  it("confirma el archivo cuando está", async () => {
    const fs = workspace();
    fs.file(`${WS}/docs/designs/001-design-alta/baselines/DES-001-r002.json`, "{}");
    const resolved = await resolve(fs, reference());
    if (!resolved.ok) throw new Error(resolved.failure.message);
    expect((await resolveBaselineOnDisk(fs, WS, resolved.value, DOC)).ok).toBe(true);
  });

  it("falla cerrado cuando el manifest promete un archivo que no está", async () => {
    const fs = workspace();
    const resolved = await resolve(fs, reference());
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const onDisk = await resolveBaselineOnDisk(fs, WS, resolved.value, DOC);
    if (onDisk.ok) throw new Error("esperaba un fallo");
    expect(onDisk.failure.code).toBe("DESIGN_REFERENCE_FILE_MISSING");
    expect(onDisk.failure.message).toContain("DES-001-r002.json");
  });
});
