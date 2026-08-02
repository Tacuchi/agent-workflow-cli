import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MANIFEST_SCHEMA_ID,
  type DesignManifest,
  validateDesignManifest,
} from "../../src/domain/design/manifest.js";

const MAXIMAL = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/design/manifest-maximal.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

type Obj = Record<string, unknown>;

/** A maximal manifest with one surgical mutation — nothing else drifts. */
function mutate(apply: (m: Obj) => void): Obj {
  const copy = structuredClone(MAXIMAL);
  apply(copy);
  return copy;
}

/** Item `i` of the array at `m[path]` / `m.catalog[path]` / `m.governance[path]`. */
function at(list: unknown, index: number): Obj {
  return (list as Obj[])[index] as Obj;
}

function catalogOf(m: Obj, key: string): unknown {
  return (m.catalog as Obj)[key];
}

function codes(raw: unknown): string[] {
  return validateDesignManifest(raw).failures.map((f) => f.code);
}

describe("validateDesignManifest — el manifest válido", () => {
  it("acepta el fixture maximal y devuelve el modelo tipado", () => {
    const result = validateDesignManifest(MAXIMAL);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const value = result.value as DesignManifest;
    expect(value.id).toBe("DES-001");
    expect(value.current_baseline?.revision).toBe(2);
    expect(value.catalog.flows).toHaveLength(2);
    expect(value.relations.plans).toEqual(["docs/plans/012-plan-paquete-diseno-ui-y-flows.md"]);
  });

  it("acepta un package que todavía no publicó (sin baseline y con catálogo vacío)", () => {
    const fresh = {
      schema: DESIGN_MANIFEST_SCHEMA_ID,
      id: "DES-007",
      title: "Nuevo",
      created: "2026-08-02",
      derived_from: null,
      current_baseline: null,
      baselines: [],
      catalog: { flows: [], screens: [], rules: [], tokens: [], renditions: [], assets: [] },
      currentness: [],
      governance: { reviews: [], revocations: [] },
      relations: { specs: [], plans: [] },
    };
    expect(validateDesignManifest(fresh).ok).toBe(true);
  });
});

describe("validateDesignManifest — la versión de formato es la primera puerta", () => {
  it("rechaza una versión desconocida sin reportar nada derivado de ella", () => {
    const result = validateDesignManifest(
      mutate((m) => {
        m.schema = "workline.design-manifest/v2";
        m.id = "no-es-un-id"; // habría fallado también, pero no debe aparecer
      }),
    );
    expect(result.failures.map((f) => f.code)).toEqual(["DESIGN_SCHEMA_UNKNOWN"]);
    expect(result.failures[0]?.action).toContain(DESIGN_MANIFEST_SCHEMA_ID);
  });

  it("rechaza lo que no es un objeto JSON", () => {
    expect(codes("DES-001")).toEqual(["DESIGN_MANIFEST_NOT_OBJECT"]);
    expect(codes([])).toEqual(["DESIGN_MANIFEST_NOT_OBJECT"]);
  });
});

describe("validateDesignManifest — la identidad no deriva de nada", () => {
  it("rechaza un id tomado del slug o del path", () => {
    expect(
      codes(
        mutate((m) => {
          m.id = "001-design-alta";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
    expect(
      codes(
        mutate((m) => {
          m.id = "DES-1";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("exige título y fecha de creación", () => {
    expect(
      codes(
        mutate((m) => {
          m.title = "  ";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
    expect(
      codes(
        mutate((m) => {
          m.created = "02/08/2026";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("admite derived_from solo como baseline de otro package", () => {
    expect(
      validateDesignManifest(
        mutate((m) => {
          m.derived_from = "DES-000@r3";
        }),
      ).ok,
    ).toBe(true);
    expect(
      codes(
        mutate((m) => {
          m.derived_from = "DES-000";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });
});

describe("validateDesignManifest — paths inseguros", () => {
  it("rechaza el escape del package en un baseline", () => {
    const result = validateDesignManifest(
      mutate((m) => {
        at(m.baselines, 0).path = "../../etc/passwd";
      }),
    );
    const failure = result.failures.find((f) => f.code === "DESIGN_PATH_UNSAFE");
    expect(failure?.message).toContain("segmentos relativos");
    expect(failure?.action).toContain("nunca salen de él");
  });

  it("rechaza un path absoluto y uno con separador de Windows", () => {
    expect(
      codes(
        mutate((m) => {
          at(catalogOf(m, "flows"), 0).path = "/tmp/flow.md";
        }),
      ),
    ).toContain("DESIGN_PATH_UNSAFE");
    expect(
      codes(
        mutate((m) => {
          at(catalogOf(m, "flows"), 0).path = "flows\\a.md";
        }),
      ),
    ).toContain("DESIGN_PATH_UNSAFE");
  });

  it("rechaza una relación hacia fuera del workspace", () => {
    expect(
      codes(
        mutate((m) => {
          (m.relations as Obj).specs = ["../otro-workspace/docs/specs/001.md"];
        }),
      ),
    ).toContain("DESIGN_PATH_UNSAFE");
  });
});

describe("validateDesignManifest — identidades duplicadas", () => {
  it("rechaza dos veces la misma revisión de baseline", () => {
    expect(
      codes(
        mutate((m) => {
          at(m.baselines, 1).revision = 1;
        }),
      ),
    ).toContain("DESIGN_ID_DUPLICATE");
  });

  it("rechaza dos veces la misma revisión de un artefacto", () => {
    expect(
      codes(
        mutate((m) => {
          at(catalogOf(m, "flows"), 1).revision = 1;
        }),
      ),
    ).toContain("DESIGN_ID_DUPLICATE");
  });

  it("rechaza un asset catalogado dos veces", () => {
    expect(
      codes(
        mutate((m) => {
          const assets = catalogOf(m, "assets") as Obj[];
          assets.push(structuredClone(at(assets, 0)));
        }),
      ),
    ).toContain("DESIGN_ID_DUPLICATE");
  });
});

describe("validateDesignManifest — relaciones internas rotas", () => {
  it("rechaza un current_baseline que no está publicado", () => {
    const result = validateDesignManifest(
      mutate((m) => {
        (m.current_baseline as Obj).revision = 9;
      }),
    );
    const failure = result.failures.find((f) => f.code === "DESIGN_RELATION_BROKEN");
    expect(failure?.message).toContain("r9");
  });

  it("rechaza un current_baseline que contradice su entrada en baselines", () => {
    expect(
      codes(
        mutate((m) => {
          (m.current_baseline as Obj).digest = `sha256:${"9".repeat(64)}`;
        }),
      ),
    ).toContain("DESIGN_RELATION_BROKEN");
  });

  it("rechaza currentness sobre una revisión que el catálogo no tiene", () => {
    expect(
      codes(
        mutate((m) => {
          at(m.currentness, 0).ref = "DES-001/SCR-009@r1";
        }),
      ),
    ).toContain("DESIGN_RELATION_BROKEN");
  });

  it("rechaza currentness sobre artefactos de otro package", () => {
    expect(
      codes(
        mutate((m) => {
          at(m.currentness, 0).ref = "DES-002/FLW-001@r1";
        }),
      ),
    ).toContain("DESIGN_RELATION_BROKEN");
  });

  it("rechaza un record de gobierno que decide sobre un baseline inexistente", () => {
    expect(
      codes(
        mutate((m) => {
          at((m.governance as Obj).reviews, 0).target = "DES-001@r8";
        }),
      ),
    ).toContain("DESIGN_RELATION_BROKEN");
  });
});

describe("validateDesignManifest — revisiones y content-addressing", () => {
  it("rechaza la revisión 0: las revisiones lógicas empiezan en 1", () => {
    expect(
      codes(
        mutate((m) => {
          at(catalogOf(m, "screens"), 0).revision = 0;
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });

  it("exige madurez en flows y screens, y no la admite en rules", () => {
    expect(
      codes(
        mutate((m) => {
          Reflect.deleteProperty(at(catalogOf(m, "screens"), 0), "maturity");
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
    // La madurez pertenece a flows y screens: declararla en una rule es un dato
    // sin propietario, y el objeto es cerrado igual que en el schema publicado.
    expect(
      codes(
        mutate((m) => {
          at(catalogOf(m, "rules"), 0).maturity = "handoff";
        }),
      ),
    ).toContain("DESIGN_KEY_UNKNOWN");
  });

  it("exige que el nombre del asset lleve su propio digest", () => {
    const result = validateDesignManifest(
      mutate((m) => {
        at(catalogOf(m, "assets"), 0).path = "assets/logo.svg";
      }),
    );
    const failure = result.failures.find((f) => f.code === "DESIGN_FIELD_INVALID");
    expect(failure?.action).toContain("5555");
  });

  it("exige que supersedes sea una referencia completa", () => {
    expect(
      codes(
        mutate((m) => {
          at(catalogOf(m, "flows"), 1).supersedes = "FLW-001@r1";
        }),
      ),
    ).toContain("DESIGN_FIELD_INVALID");
  });
});

describe("validateDesignManifest — los objetos son cerrados", () => {
  it("rechaza una clave que el schema no declara, en la raíz y en un item", () => {
    const root = validateDesignManifest(
      mutate((m) => {
        m.maturity = "handoff";
      }),
    );
    expect(root.failures[0]?.code).toBe("DESIGN_KEY_UNKNOWN");
    expect(root.failures[0]?.action).toContain("relations");
    expect(
      codes(
        mutate((m) => {
          at((m.governance as Obj).reviews, 0).decision = "approved";
        }),
      ),
    ).toContain("DESIGN_KEY_UNKNOWN");
  });
});

describe("validateDesignManifest — cada fallo nombra artefacto y acción", () => {
  it("no emite ningún diagnóstico sin salida", () => {
    const broken = mutate((m) => {
      m.created = "ayer";
      at(m.baselines, 0).digest = "abc";
      (m.relations as Obj).plans = ["/etc/passwd"];
    });
    const result = validateDesignManifest(broken, "docs/designs/001-design-x/design-manifest.json");
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
    for (const failure of result.failures) {
      expect(failure.artifact.length).toBeGreaterThan(0);
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.action.length).toBeGreaterThan(0);
    }
  });
});
