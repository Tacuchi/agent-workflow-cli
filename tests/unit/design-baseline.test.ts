import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/application/semantic-operation/protocol.js";
import {
  type DesignBaseline,
  checkBaselineAuthority,
  checkPublicationBase,
  computeBaselineDigest,
  validateDesignBaseline,
} from "../../src/domain/design/baseline.js";
import { type DesignManifest, validateDesignManifest } from "../../src/domain/design/manifest.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

/** Item `i` of an array, without a non-null assertion the linter forbids. */
function at(list: unknown, index: number): Record<string, unknown> {
  return (list as Array<Record<string, unknown>>)[index] as Record<string, unknown>;
}

const RAW_BASELINE = fixture("baseline-DES-001-r002.json");
const RAW_MANIFEST = fixture("manifest-maximal.json");
const DOC = "docs/designs/001-design-alta/baselines/DES-001-r002.json";

type Obj = Record<string, unknown>;

function baseline(apply?: (b: Obj) => void): Obj {
  const doc = JSON.parse(RAW_BASELINE) as Obj;
  apply?.(doc);
  return doc;
}

/** Re-seal after a mutation, so a test about content is not a test about the seal. */
function resealed(apply: (b: Obj) => void): Obj {
  const doc = baseline(apply);
  doc.digest = computeBaselineDigest(doc as unknown as DesignBaseline);
  return doc;
}

function codes(raw: unknown): string[] {
  return validateDesignBaseline(raw, DOC).failures.map((f) => f.code);
}

/** The manifest, with r2 indexed at the digest the baseline fixture actually seals. */
function manifest(apply?: (m: Obj) => void): DesignManifest {
  const doc = JSON.parse(RAW_MANIFEST) as Obj;
  const sealed = (JSON.parse(RAW_BASELINE) as Obj).digest as string;
  at(doc.baselines, 1).digest = sealed;
  (doc.current_baseline as Obj).digest = sealed;
  apply?.(doc);
  const result = validateDesignManifest(doc);
  if (!result.ok || result.value === null) {
    throw new Error(`el manifest del test no valida: ${result.failures[0]?.message}`);
  }
  return result.value;
}

describe("validateDesignBaseline — el baseline sellado", () => {
  it("acepta el fixture y devuelve su selección cerrada", () => {
    const result = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC);
    expect(result.failures).toEqual([]);
    const value = result.value as DesignBaseline;
    expect(value.package).toBe("DES-001");
    expect(value.revision).toBe(2);
    expect(value.parent_baseline).toBe("DES-001@r1");
    expect(value.selection).toHaveLength(6);
    expect(value.selection.find((s) => s.path.startsWith("assets/"))?.revision).toBeNull();
  });

  it("rechaza un digest que no corresponde al contenido", () => {
    const result = validateDesignBaseline(
      baseline((b) => {
        b.digest = `sha256:${"0".repeat(64)}`;
      }),
      DOC,
    );
    expect(result.failures[0]?.code).toBe("DESIGN_DIGEST_MISMATCH");
    expect(result.failures[0]?.action).toContain("sin el campo 'digest'");
  });
});

describe("el digest no se refiere a sí mismo", () => {
  // Si `digest` entrara en su propio cálculo no habría forma de calcularlo.
  it("cambiar el campo 'digest' no cambia el digest que se calcula", () => {
    const uno = computeBaselineDigest(JSON.parse(RAW_BASELINE) as DesignBaseline);
    const otro = computeBaselineDigest(
      baseline((b) => {
        b.digest = `sha256:${"f".repeat(64)}`;
      }) as unknown as DesignBaseline,
    );
    expect(otro).toBe(uno);
  });

  it("pero cambiar CUALQUIER otra cosa sí lo cambia", () => {
    const original = computeBaselineDigest(JSON.parse(RAW_BASELINE) as DesignBaseline);
    for (const mutation of [
      (b: Obj) => {
        b.published = "2026-08-03";
      },
      (b: Obj) => {
        b.parent_baseline = null;
      },
      (b: Obj) => {
        at(b.selection, 0).sha256 = `sha256:${"9".repeat(64)}`;
      },
      (b: Obj) => {
        (b.selection as Obj[]).pop();
      },
    ]) {
      expect(computeBaselineDigest(baseline(mutation) as unknown as DesignBaseline)).not.toBe(
        original,
      );
    }
  });

  it("y el orden de las claves no lo cambia: el JSON es canónico", () => {
    const original = JSON.parse(RAW_BASELINE) as Obj;
    const reordenado = Object.fromEntries(Object.entries(original).reverse());
    expect(computeBaselineDigest(reordenado as unknown as DesignBaseline)).toBe(
      computeBaselineDigest(original as unknown as DesignBaseline),
    );
  });
});

describe("la validación de fase: tocar el índice no altera una revisión publicada", () => {
  // El digest se calcula sobre los campos sellados y NADA más. Meterle al
  // archivo una copia del índice mutable no lo mueve — que es la forma fuerte
  // de decir que un cambio de catálogo no altera una revisión ya publicada.
  it("el digest ignora todo lo que no sea la selección sellada", () => {
    const antes = computeBaselineDigest(JSON.parse(RAW_BASELINE) as DesignBaseline);
    const conIndicePegado = baseline((b) => {
      b.manifest_snapshot = JSON.parse(RAW_MANIFEST);
      b.catalog_size = 12;
    });
    expect(computeBaselineDigest(conIndicePegado as unknown as DesignBaseline)).toBe(antes);

    // Y ese contrabando se rechaza igual, por otra vía: el objeto es cerrado.
    expect(codes(conIndicePegado)).toContain("DESIGN_KEY_UNKNOWN");
  });

  // Y la razón por la que es estable: no puede sellar el índice ni las proyecciones.
  it.each([
    ["design-manifest.json", "índice mutable"],
    ["PACKAGE.md", "proyección"],
    ["design-system/DESIGN.md", "proyección"],
    ["governance/reviews/REV-001.json", "record de gobierno"],
  ])("una selección que intenta sellar '%s' se rechaza", (path) => {
    const result = validateDesignBaseline(
      resealed((b) => {
        (b.selection as Obj[]).push({ path, revision: 1, sha256: `sha256:${"1".repeat(64)}` });
      }),
      DOC,
    );
    expect(result.failures[0]?.code).toBe("DESIGN_SELECTION_FORBIDDEN");
    expect(result.failures[0]?.action.length).toBeGreaterThan(0);
  });

  it("y tampoco sella nada fuera de las carpetas de artefactos normativos", () => {
    expect(
      codes(
        resealed((b) => {
          (b.selection as Obj[]).push({
            path: "notas/borrador.md",
            revision: 1,
            sha256: `sha256:${"1".repeat(64)}`,
          });
        }),
      ),
    ).toContain("DESIGN_SELECTION_FORBIDDEN");
  });
});

describe("la selección declara la revisión que su nombre lleva", () => {
  it("rechaza una revisión que el nombre del archivo contradice", () => {
    const result = validateDesignBaseline(
      resealed((b) => {
        at(b.selection, 0).revision = 9;
      }),
      DOC,
    );
    expect(result.failures[0]?.code).toBe("DESIGN_RELATION_BROKEN");
    expect(result.failures[0]?.action).toContain("-r009-");
  });

  it("un asset no lleva revisión: es content-addressed", () => {
    expect(
      codes(
        resealed((b) => {
          const assets = (b.selection as Obj[]).find((s) =>
            (s.path as string).startsWith("assets/"),
          ) as Obj;
          assets.revision = 1;
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("rechaza el mismo archivo seleccionado dos veces", () => {
    expect(
      codes(
        resealed((b) => {
          const selection = b.selection as Obj[];
          selection.push({ ...at(selection, 0) });
        }),
      ),
    ).toContain("DESIGN_ID_DUPLICATE");
  });
});

describe("la línea de baselines no se bifurca", () => {
  it("solo la primera revisión no tiene padre", () => {
    expect(
      codes(
        resealed((b) => {
          b.parent_baseline = null;
        }),
      ),
    ).toContain("DESIGN_RELATION_BROKEN");
  });

  it("el padre es la revisión inmediatamente anterior", () => {
    const result = validateDesignBaseline(
      resealed((b) => {
        b.revision = 5;
      }),
      DOC,
    );
    expect(result.failures[0]?.message).toContain("su padre es r4");
    expect(result.failures[0]?.action).toContain("no se saltean revisiones ni se bifurca");
  });

  it("el padre pertenece al mismo package: una divergencia crea OTRO package", () => {
    const result = validateDesignBaseline(
      resealed((b) => {
        b.parent_baseline = "DES-002@r1";
      }),
      DOC,
    );
    expect(result.failures[0]?.action).toContain("derived_from");
  });
});

describe("checkPublicationBase — compare-and-swap", () => {
  it("acepta publicar la siguiente sobre la base vigente", () => {
    const sobreR1 = manifest((m) => {
      (m.baselines as Obj[]).pop();
      m.current_baseline = {
        revision: 1,
        path: "baselines/DES-001-r001.json",
        digest: at(m.baselines, 0).digest,
      };
      (m.governance as { revocations: unknown[] }).revocations = [];
      at((m.governance as { reviews: Obj[] }).reviews, 0).target = "DES-001@r1";
      (m.catalog as { flows: Obj[] }).flows.pop();
      (m.currentness as unknown[]).length = 0;
    });
    const candidate = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC).value as DesignBaseline;
    expect(checkPublicationBase(sobreR1, candidate, DOC)).toBeNull();
  });

  it("rechaza republicar una revisión que ya está publicada", () => {
    const yaEnR2 = manifest();
    const candidate = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC).value as DesignBaseline;
    const failure = checkPublicationBase(yaEnR2, candidate, DOC);
    expect(failure?.code).toBe("DESIGN_BASE_STALE");
    expect(failure?.message).toContain("r2 ya está publicada");
    expect(failure?.action).toContain("no se republica");
  });

  // El caso que justifica el mecanismo: alguien publicó mientras preparabas la
  // tuya, así que tu r3 cuelga de r1 y la línea ya va por r2.
  it("rechaza publicar sobre una base que se movió", () => {
    const yaEnR2 = manifest();
    const desdeR1 = {
      ...(JSON.parse(RAW_BASELINE) as Obj),
      revision: 3,
      parent_baseline: "DES-001@r1",
    } as unknown as DesignBaseline;
    const failure = checkPublicationBase(yaEnR2, desdeR1, DOC);
    expect(failure?.code).toBe("DESIGN_BASE_STALE");
    expect(failure?.message).toContain("la vigente es DES-001@r2");
    expect(failure?.action).toContain("publicó mientras preparabas");
  });

  it("rechaza un baseline de otro package nombrando el conflicto real", () => {
    const ajeno = {
      ...(JSON.parse(RAW_BASELINE) as Obj),
      package: "DES-777",
    } as unknown as DesignBaseline;
    const failure = checkPublicationBase(manifest(), ajeno, DOC);
    expect(failure?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
    expect(failure?.message).toContain("DES-777");
  });

  it("rechaza una numeración que no sigue a la vigente", () => {
    const sobreR1 = manifest((m) => {
      (m.baselines as Obj[]).pop();
      m.current_baseline = {
        revision: 1,
        path: "baselines/DES-001-r001.json",
        digest: at(m.baselines, 0).digest,
      };
      (m.governance as { revocations: unknown[] }).revocations = [];
      at((m.governance as { reviews: Obj[] }).reviews, 0).target = "DES-001@r1";
      (m.catalog as { flows: Obj[] }).flows.pop();
      (m.currentness as unknown[]).length = 0;
    });
    const saltada = {
      ...(JSON.parse(RAW_BASELINE) as Obj),
      revision: 7,
    } as unknown as DesignBaseline;
    expect(checkPublicationBase(sobreR1, saltada, DOC)?.message).toContain(
      "la siguiente de la línea es r2",
    );
  });
});

describe("checkBaselineAuthority — la contradicción no se concilia en silencio", () => {
  it("no reporta nada cuando manifest y baseline coinciden", () => {
    const value = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC).value as DesignBaseline;
    expect(checkBaselineAuthority(manifest(), value, DOC)).toEqual([]);
  });

  it("el baseline es la autoridad del digest, y el manifest que discrepa se reporta", () => {
    const value = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC).value as DesignBaseline;
    const conflicto = manifest((m) => {
      at(m.baselines, 1).digest = `sha256:${"3".repeat(64)}`;
      (m.current_baseline as Obj).digest = `sha256:${"3".repeat(64)}`;
    });
    const failures = checkBaselineAuthority(conflicto, value, DOC);
    expect(failures[0]?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
    expect(failures[0]?.action).toContain("el baseline es la autoridad");
  });

  it("un baseline que sella algo que el catálogo no conoce se reporta", () => {
    const value = validateDesignBaseline(
      resealed((b) => {
        (b.selection as Obj[]).push({
          path: "flows/FLW-009-r001-ajeno.md",
          revision: 1,
          sha256: `sha256:${"7".repeat(64)}`,
        });
      }),
      DOC,
    ).value as DesignBaseline;
    const failures = checkBaselineAuthority(manifest(), value, DOC);
    expect(failures.some((f) => f.message.includes("FLW-009-r001-ajeno.md"))).toBe(true);
  });

  it("un baseline de otro package no se mezcla", () => {
    const value = validateDesignBaseline(
      resealed((b) => {
        b.package = "DES-002";
        b.parent_baseline = "DES-002@r1";
      }),
      DOC,
    ).value as DesignBaseline;
    expect(checkBaselineAuthority(manifest(), value, DOC)[0]?.message).toContain("DES-002");
  });
});

/**
 * El digest de un baseline solo sirve si CUALQUIERA puede recalcularlo y
 * compararlo. Eso obliga a que el JSON canónico sea el mismo en toda máquina.
 */
describe("el JSON canónico no depende del locale de quien lo calcula", () => {
  // `localeCompare` es dependiente del locale y del ICU del runtime: en sueco
  // 'ä' ordena después de la 'z' y en alemán junto a la 'a'. Con ese orden, dos
  // máquinas calcularían digests distintos del MISMO archivo y un baseline
  // publicado leería como adulterado. El orden es por unidades de código.
  it("ordena las claves por unidad de código, no por colación", () => {
    expect(canonicalJson({ ö: 1, z: 2 })).toBe('{"z":2,"ö":1}');
    expect(canonicalJson({ b: 1, A: 2 })).toBe('{"A":2,"b":1}');
  });

  it("y el digest no se mueve al reordenar la fuente", () => {
    const uno = computeBaselineDigest({ ...(JSON.parse(RAW_BASELINE) as Obj) } as never);
    const otro = computeBaselineDigest(
      Object.fromEntries(Object.entries(JSON.parse(RAW_BASELINE) as Obj).reverse()) as never,
    );
    expect(otro).toBe(uno);
  });
});

describe("los agujeros que cazó el review gate", () => {
  // El peor: la exclusión era "por construcción" y un `..` la derribaba entera.
  it.each([
    "flows/../governance/reviews/REV-001.json",
    "flows/../design-manifest.json",
    "flows/../../otro-package/flows/x.md",
    "screens/./SCR-001-r001-x.md",
  ])("un traversal en la selección se rechaza antes que nada: '%s'", (path) => {
    const result = validateDesignBaseline(
      resealed((b) => {
        (b.selection as Obj[]).push({ path, revision: 1, sha256: `sha256:${"1".repeat(64)}` });
      }),
      DOC,
    );
    expect(result.failures[0]?.code).toBe("DESIGN_PATH_UNSAFE");
  });

  // Reordenar el array es un no-cambio: una selección es un conjunto.
  it("el digest no depende del orden de la selección", () => {
    const original = JSON.parse(RAW_BASELINE) as Obj;
    const alReves = {
      ...original,
      selection: [...(original.selection as Obj[])].reverse(),
    };
    expect(computeBaselineDigest(alReves as unknown as DesignBaseline)).toBe(
      computeBaselineDigest(original as unknown as DesignBaseline),
    );
  });

  it("un asset se sella content-addressed o no se sella", () => {
    expect(
      codes(
        resealed((b) => {
          (b.selection as Obj[]).push({
            path: "assets/logo.svg",
            revision: null,
            sha256: `sha256:${"1".repeat(64)}`,
          });
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("una selección vacía no sella una revisión", () => {
    expect(
      codes(
        resealed((b) => {
          b.selection = [];
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("'published' tiene que ser un día que existe", () => {
    expect(
      codes(
        resealed((b) => {
          b.published = "2026-13-45";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
    expect(
      codes(
        resealed((b) => {
          b.published = "2026-02-30";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("el sha256 de cada archivo sellado se comprueba", () => {
    expect(
      codes(
        resealed((b) => {
          at(b.selection, 0).sha256 = "abc";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("la autoridad compara también el padre y la fecha, no solo el digest", () => {
    const value = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC).value as DesignBaseline;
    const conPadreDistinto = manifest((m) => {
      at(m.baselines as Obj[], 1).parent_baseline = null;
    });
    expect(
      checkBaselineAuthority(conPadreDistinto, value, DOC).some((f) =>
        f.message.includes("parent_baseline"),
      ),
    ).toBe(true);

    const conFechaDistinta = manifest((m) => {
      at(m.baselines as Obj[], 1).published = "2026-01-01";
    });
    expect(
      checkBaselineAuthority(conFechaDistinta, value, DOC).some((f) =>
        f.message.includes("published"),
      ),
    ).toBe(true);
  });

  // Sin esto, borrar una comprobación de campo pasaría igual: el digest deja de
  // coincidir y el baseline falla de todos modos, con el diagnóstico equivocado.
  it.each([
    ["package", "no-es-un-id", "package"],
    ["revision", 0, "revision"],
    ["parent_baseline", "no-es-un-baseline", "parent_baseline"],
    ["published", "2026-13-45", "published"],
  ])("el campo '%s' se comprueba por sí mismo, no vía el digest", (field, value, named) => {
    const result = validateDesignBaseline(
      resealed((b) => {
        (b as Obj)[field] = value;
      }),
      DOC,
    );
    expect(result.failures.length, field).toBeGreaterThan(0);
    expect(
      result.failures.some((f) => f.message.includes(named)),
      `ningún diagnóstico nombra '${named}'`,
    ).toBe(true);
    expect(
      result.failures.every((f) => f.code === "DESIGN_DIGEST_MISMATCH"),
      "solo falló el digest: la comprobación del campo no existe",
    ).toBe(false);
  });
});

describe("lo que el review gate dejó abierto", () => {
  // Un espacio al final y una grafía NFD son el MISMO archivo en disco. Sellarlo
  // dos veces con dos SHA-256 deja a nadie en condiciones de decir cuál vale.
  it("deduplica sobre el path normalizado, no sobre la cadena cruda", () => {
    const conEspacio = validateDesignBaseline(
      resealed((b) => {
        (b.selection as Obj[]).push({
          path: "flows/FLW-001-r002-alta-miembro.md ",
          revision: 2,
          sha256: `sha256:${"9".repeat(64)}`,
        });
      }),
      DOC,
    );
    expect(conEspacio.failures.map((f) => f.code)).toContain("DESIGN_ID_DUPLICATE");
  });

  it("y normaliza Unicode: NFC y NFD del mismo nombre son un solo archivo", () => {
    const nfc = "flows/FLW-002-r001-añadir.md".normalize("NFC");
    const nfd = "flows/FLW-002-r001-añadir.md".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    const result = validateDesignBaseline(
      resealed((b) => {
        (b.selection as Obj[]).push(
          { path: nfc, revision: 1, sha256: `sha256:${"1".repeat(64)}` },
          { path: nfd, revision: 1, sha256: `sha256:${"2".repeat(64)}` },
        );
      }),
      DOC,
    );
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_ID_DUPLICATE");
  });

  // Un `includes("-r001-")` acepta un nombre que lleva dos revisiones, y un flow
  // archivado bajo `screens/`. La regla de nombre es UNA y vive en naming.ts.
  it.each([
    ["dos revisiones en el nombre", "flows/FLW-001-r002-nota-r001-vieja.md", 1],
    ["un flow bajo screens/", "screens/FLW-001-r001-esto-es-un-flow.md", 1],
    ["un nombre que no es un slug", "flows/FLW-003-r001-CUALQUIER COSA.md", 1],
  ])("la revisión de la selección se comprueba con la regla de nombre: %s", (_n, path, rev) => {
    const result = validateDesignBaseline(
      resealed((b) => {
        (b.selection as Obj[]).push({ path, revision: rev, sha256: `sha256:${"1".repeat(64)}` });
      }),
      DOC,
    );
    expect(result.failures.length, path).toBeGreaterThan(0);
  });

  it("el mensaje distingue una proyección de un índice y de una carpeta ajena", () => {
    const message = (path: string): string =>
      validateDesignBaseline(
        resealed((b) => {
          (b.selection as Obj[]).push({ path, revision: 1, sha256: `sha256:${"1".repeat(64)}` });
        }),
        DOC,
      ).failures[0]?.message ?? "";
    expect(message("PACKAGE.md")).toContain("proyección regenerable");
    expect(message("design-manifest.json")).toContain("índice mutable");
    expect(message("notas/x-r001-y.md")).toContain("carpeta de artefactos normativos");
  });

  it("un baseline huérfano del catálogo se reporta", () => {
    const value = validateDesignBaseline(JSON.parse(RAW_BASELINE), DOC).value as DesignBaseline;
    const sinIndexar = manifest((m) => {
      (m.baselines as Obj[]).pop();
      m.current_baseline = {
        revision: 1,
        path: "baselines/DES-001-r001.json",
        digest: at(m.baselines as Obj[], 0).digest,
      };
      (m.governance as { revocations: unknown[] }).revocations = [];
      at((m.governance as { reviews: Obj[] }).reviews, 0).target = "DES-001@r1";
      (m.catalog as { flows: Obj[] }).flows.pop();
      (m.currentness as unknown[]).length = 0;
    });
    const failures = checkBaselineAuthority(sinIndexar, value, DOC);
    expect(failures.some((f) => f.message.includes("no cataloga r2"))).toBe(true);
  });
});
