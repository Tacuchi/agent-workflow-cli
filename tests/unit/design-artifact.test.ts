import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DesignDocKind } from "../../src/domain/design/artifact-body.js";
import {
  type DesignArtifact,
  type FlowArtifact,
  type ScreenArtifact,
  splitDesignDocument,
  validateDesignArtifact,
} from "../../src/domain/design/artifact.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const FLOW = fixture("FLW-001-r002-alta-miembro.md");
const SCREEN = fixture("SCR-001-r002-formulario-alta.md");

function validate(text: string, kind: DesignDocKind) {
  return validateDesignArtifact(text, kind, `${kind}s/artefacto.md`);
}

function codes(text: string, kind: DesignDocKind): string[] {
  return validate(text, kind).failures.map((f) => f.code);
}

/**
 * Mutate the fixture surgically. Both helpers ABORT when the replacement finds
 * nothing: a test that silently mutates nothing would assert over the untouched
 * fixture and pass for the wrong reason — the classic way a rejection battery
 * rots into decoration.
 */
function swap(source: string, find: string | RegExp, replace: string, where: string): string {
  const out = source.replace(find, replace);
  if (out === source) {
    throw new Error(`la edición no encontró '${String(find)}' en el ${where} del fixture`);
  }
  return out;
}

function editFront(text: string, find: string | RegExp, replace: string): string {
  const split = splitDesignDocument(text);
  if (split === null) throw new Error("el fixture perdió su frontmatter");
  return `---\n${swap(split.frontmatter, find, replace, "frontmatter")}\n---\n${split.body}`;
}

function editBody(text: string, find: string | RegExp, replace: string): string {
  const split = splitDesignDocument(text);
  if (split === null) throw new Error("el fixture perdió su frontmatter");
  return `---\n${split.frontmatter}\n---\n${swap(split.body, find, replace, "cuerpo")}`;
}

describe("validateDesignArtifact — los fixtures válidos", () => {
  it("acepta el flow y resuelve su grafo sin leer el cuerpo", () => {
    const result = validate(FLOW, "flow");
    expect(result.failures).toEqual([]);
    const flow = result.value as FlowArtifact;
    expect(flow.id).toBe("DES-001/FLW-001");
    expect(flow.revision).toBe(2);
    expect(flow.entry).toBe("DES-001/SCR-001@r2#default");
    expect(flow.nodes).toHaveLength(3);
    expect(flow.edges).toHaveLength(3);
    expect(flow.edges[0]?.trigger).toBe("submit");
    expect(flow.edges[1]?.action).toBeNull();
    expect(flow.not_applicable.permissions_and_privacy).toContain("guard de admin");
  });

  it("acepta la screen y resuelve sus estados y dependencias sin leer el cuerpo", () => {
    const result = validate(SCREEN, "screen");
    expect(result.failures).toEqual([]);
    const screen = result.value as ScreenArtifact;
    expect(screen.title).toBe("Alta de miembro");
    expect(screen.default_state).toBe("default");
    expect(screen.states.map((s) => s.anchor)).toEqual(["default", "error"]);
    expect(screen.flow_refs).toEqual(["DES-001/FLW-001@r2"]);
    expect(screen.dependencies.tokens).toEqual(["DES-001/TOK-001@r1"]);
    expect(screen.dependencies.assets[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("un flow declarado como screen no pasa: el schema identifica el tipo", () => {
    expect(codes(FLOW, "screen")).toEqual(["DESIGN_SCHEMA_UNKNOWN"]);
  });
});

describe("validateDesignArtifact — el documento y su frontmatter", () => {
  it("exige el frontmatter cercado", () => {
    expect(codes("## Goal and outcome\n\nAlgo.", "flow")).toEqual(["DESIGN_FRONTMATTER_MISSING"]);
    expect(codes("---\nschema: workline.ui-flow/v1\n", "flow")).toEqual([
      "DESIGN_FRONTMATTER_MISSING",
    ]);
  });

  it("reporta el YAML fuera del subconjunto con su línea", () => {
    const broken = editFront(FLOW, "platform: web", "platform: &ancla web");
    const failure = validate(broken, "flow").failures[0];
    expect(failure?.code).toBe("DESIGN_FRONTMATTER_UNREADABLE");
    expect(failure?.message).toContain("anclas");
  });

  it("la versión de formato es la primera puerta y no reporta nada derivado", () => {
    const other = editFront(FLOW, "workline.ui-flow/v1", "workline.ui-flow/v2");
    expect(codes(other, "flow")).toEqual(["DESIGN_SCHEMA_UNKNOWN"]);
  });

  it("rechaza una clave que el contrato no declara", () => {
    expect(
      codes(editFront(FLOW, "platform: web", "platform: web\nfidelity: high"), "flow"),
    ).toContain("DESIGN_KEY_UNKNOWN");
  });
});

describe("validateDesignArtifact — identidad, revisión y supersedes", () => {
  it("exige la identidad calificada del tipo correcto", () => {
    expect(codes(editFront(FLOW, "id: DES-001/FLW-001", "id: FLW-001"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
    expect(codes(editFront(FLOW, "id: DES-001/FLW-001", "id: DES-001/SCR-001"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
  });

  it("rechaza la revisión 0 y la madurez inventada", () => {
    expect(codes(editFront(FLOW, "revision: 2", "revision: 0"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
    expect(codes(editFront(FLOW, "maturity: handoff", "maturity: final"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
  });

  it("una revisión solo supersede a una revisión ANTERIOR de sí misma", () => {
    const otro = editFront(
      FLOW,
      "supersedes: DES-001/FLW-001@r1",
      "supersedes: DES-001/FLW-002@r1",
    );
    const failure = validate(otro, "flow").failures.find(
      (f) => f.code === "DESIGN_RELATION_BROKEN",
    );
    expect(failure?.action).toContain("de sí misma");

    const posterior = editFront(
      FLOW,
      "supersedes: DES-001/FLW-001@r1",
      "supersedes: DES-001/FLW-001@r5",
    );
    expect(codes(posterior, "flow")).toContain("DESIGN_RELATION_BROKEN");
  });
});

describe("validateDesignArtifact — el grafo del flow cierra sobre sí mismo", () => {
  it("exige que 'entry' apunte a un ESTADO y esté entre los nodos", () => {
    const sinAnchor = editFront(
      FLOW,
      "entry: DES-001/SCR-001@r2#default",
      "entry: DES-001/SCR-001@r2",
    );
    expect(codes(sinAnchor, "flow")).toContain("DESIGN_FIELD_INVALID");

    const fuera = editFront(
      FLOW,
      "entry: DES-001/SCR-001@r2#default",
      "entry: DES-001/SCR-009@r1#default",
    );
    const failure = validate(fuera, "flow").failures.find(
      (f) => f.code === "DESIGN_RELATION_BROKEN",
    );
    expect(failure?.message).toContain("no está en 'nodes'");
  });

  it("rechaza una arista cuyo destino nadie declaró como nodo", () => {
    const rota = editFront(
      FLOW,
      "    to: DES-001/SCR-002@r1#success",
      "    to: DES-001/SCR-007@r1#ok",
    );
    expect(codes(rota, "flow")).toContain("DESIGN_RELATION_BROKEN");
  });

  it("exige trigger en cada arista", () => {
    expect(codes(editFront(FLOW, "    trigger: corregir", "    trigger: ''"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
  });
});

describe("validateDesignArtifact — los estados de la screen", () => {
  it("exige que 'default_state' sea uno de los estados declarados", () => {
    const fuera = editFront(SCREEN, "default_state: default", "default_state: vacio");
    const failure = validate(fuera, "screen").failures.find(
      (f) => f.code === "DESIGN_RELATION_BROKEN",
    );
    expect(failure?.message).toContain("no está entre los states declarados");
  });

  it("rechaza dos estados con el mismo anchor: la referencia quedaría ambigua", () => {
    const duplicado = editFront(SCREEN, "  - anchor: error", "  - anchor: default");
    const failure = validate(duplicado, "screen").failures.find(
      (f) => f.code === "DESIGN_ID_DUPLICATE",
    );
    expect(failure?.action).toContain("un solo estado");
  });

  it("rechaza un anchor con forma inválida", () => {
    expect(codes(editFront(SCREEN, "  - anchor: error", "  - anchor: '-mal'"), "screen")).toContain(
      "DESIGN_FIELD_INVALID",
    );
  });

  it("exige digest en los assets: las dependencias son content-addressed", () => {
    const porNombre = editFront(SCREEN, /assets: \[sha256:[0-9a-f]{64}\]/, "assets: [logo.svg]");
    expect(codes(porNombre, "screen")).toContain("DESIGN_FIELD_INVALID");
  });
});

describe("validateDesignArtifact — la no-aplicabilidad tiene precio", () => {
  it("una sección ESENCIAL no se puede declarar no aplicable", () => {
    const prohibido = editFront(
      FLOW,
      /not_applicable: \{[^}]*\}/,
      "not_applicable: {main_journey: no hace falta}",
    );
    const failure = validate(prohibido, "flow").failures.find(
      (f) => f.code === "DESIGN_NOT_APPLICABLE_FORBIDDEN",
    );
    expect(failure?.action).toContain("preconditions_and_entry");
  });

  it("una razón vacía no satisface el contrato", () => {
    const sinRazon = editFront(
      FLOW,
      /not_applicable: \{[^}]*\}/,
      "not_applicable: {permissions_and_privacy: ''}",
    );
    expect(codes(sinRazon, "flow")).toContain("DESIGN_NOT_APPLICABLE_NO_REASON");
  });

  it("una clave que no es sección de este tipo se rechaza", () => {
    const ajena = editFront(
      FLOW,
      /not_applicable: \{[^}]*\}/,
      "not_applicable: {localization: no hay i18n}",
    );
    expect(codes(ajena, "flow")).toContain("DESIGN_NOT_APPLICABLE_FORBIDDEN");
  });
});

describe("validateDesignArtifact — el cuerpo se contrasta contra el frontmatter", () => {
  it("rechaza una referencia del cuerpo que el frontmatter no declara", () => {
    const colgante = editBody(
      FLOW,
      "El operador incorpora",
      "Continúa en DES-001/SCR-099@r1#default. El operador incorpora",
    );
    const failure = validate(colgante, "flow").failures.find(
      (f) => f.code === "DESIGN_BODY_REFERENCE_UNKNOWN",
    );
    expect(failure?.message).toContain("DES-001/SCR-099@r1#default");
    // La acción nombra los campos que ESE tipo tiene: una screen no tiene 'nodes'.
    expect(failure?.action).toContain("'nodes'");
    const enScreen = validate(
      editBody(
        SCREEN,
        "Es la única superficie",
        "Ver DES-002/SCR-001@r1#default. Es la única superficie",
      ),
      "screen",
    ).failures.find((f) => f.code === "DESIGN_BODY_REFERENCE_UNKNOWN");
    expect(enScreen?.action).toContain("'flow_refs'");
    expect(enScreen?.action).not.toContain("'nodes'");
  });

  it("rechaza que el cuerpo cite un estado propio que 'states' no declara", () => {
    const inventado = editBody(SCREEN, "DES-001/SCR-001@r2#error", "DES-001/SCR-001@r2#cargando");
    const failure = validate(inventado, "screen").failures.find(
      (f) => f.code === "DESIGN_RELATION_BROKEN",
    );
    expect(failure?.message).toContain("#cargando");
  });

  it("una mención informal no cuenta como referencia, en ninguna dirección", () => {
    const informal = editBody(
      FLOW,
      "El operador incorpora",
      "Ver la pantalla de alta (SCR-001). El operador incorpora",
    );
    expect(validate(informal, "flow").failures).toEqual([]);
  });

  it("el cuerpo puede citarse a sí mismo sin declararse en 'nodes'", () => {
    const propio = editBody(
      SCREEN,
      "Es la única superficie",
      "DES-001/SCR-001@r2#default. Es la única superficie",
    );
    expect(validate(propio, "screen").failures).toEqual([]);
  });
});

describe("validateDesignArtifact — el cuerpo mantiene su contrato", () => {
  it("rechaza una sección omitida, duplicada o fuera de orden", () => {
    expect(codes(editBody(FLOW, "## Traceability", "## Rastreo"), "flow")).toContain(
      "DESIGN_HEADING_MISSING",
    );
    expect(codes(`${FLOW}\n\n## Main journey\n\nOtra vez.`, "flow")).toContain(
      "DESIGN_HEADING_DUPLICATE",
    );
  });

  it("rechaza 'N/A' aunque la sección esté declarada en not_applicable", () => {
    const naLibre = editBody(
      FLOW,
      /## Permissions and privacy\n\nNo aplica:[\s\S]*?\n\n## Traceability/,
      "## Permissions and privacy\n\nN/A\n\n## Traceability",
    );
    expect(codes(naLibre, "flow")).toContain("DESIGN_SECTION_PLACEHOLDER");
  });
});

describe("validateDesignArtifact — todo diagnóstico es accionable", () => {
  it("ningún fallo sale sin artefacto, mensaje y acción", () => {
    const roto = editFront(
      editBody(FLOW, "## Traceability", "## Rastreo"),
      "revision: 2",
      "revision: 0",
    );
    const result = validate(roto, "flow");
    expect(result.failures.length).toBeGreaterThanOrEqual(2);
    for (const failure of result.failures) {
      expect(failure.artifact).toBe("flows/artefacto.md");
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.action.length).toBeGreaterThan(0);
    }
    expect(result.value as DesignArtifact | null).toBeNull();
  });
});

describe("la Condición de salida de la fase: el frontmatter manda", () => {
  // La fase promete que identidad, grafo, estados, dependencias y trazabilidad
  // se resuelven SIN interpretar prosa. La forma honesta de demostrarlo es
  // reescribir el cuerpo diciendo otra cosa y comprobar que el modelo no se movió.
  it("reescribir la prosa no cambia nada de lo que el modelo resuelve", () => {
    const original = validate(FLOW, "flow").value as FlowArtifact;

    const split = splitDesignDocument(FLOW);
    if (split === null) throw new Error("el fixture perdió su frontmatter");
    const contradictorio = split.body
      .replace(/Dar de alta|El operador incorpora un miembro nuevo/g, "Otra cosa completamente")
      .replace(/formulario/gi, "asistente de tres pasos")
      .replace(/documento/gi, "identificador biométrico");
    const reescrito = `---\n${split.frontmatter}\n---\n${contradictorio}`;
    expect(reescrito).not.toBe(FLOW);

    const despues = validate(reescrito, "flow").value as FlowArtifact;
    expect(despues).toEqual(original);
  });

  it("lo mismo para la screen: estados y dependencias vienen del frontmatter", () => {
    const original = validate(SCREEN, "screen").value as ScreenArtifact;
    const split = splitDesignDocument(SCREEN);
    if (split === null) throw new Error("el fixture perdió su frontmatter");
    const reescrito = `---\n${split.frontmatter}\n---\n${split.body.replace(/vacío/gi, "precargado")}`;
    expect(reescrito).not.toBe(SCREEN);
    expect(validate(reescrito, "screen").value as ScreenArtifact).toEqual(original);
  });
});

describe("los huecos que encontró la auditoría del contrato", () => {
  it("un campo del frontmatter tampoco se declara no aplicable con 'N/A'", () => {
    const failure = validate(editFront(FLOW, /^purpose: .*$/m, "purpose: N/A"), "flow").failures[0];
    expect(failure?.code).toBe("DESIGN_FIELD_PLACEHOLDER");
    expect(failure?.action).toContain("no se declara no aplicable");
    expect(codes(editFront(SCREEN, /^title: .*$/m, "title: TBD"), "screen")).toContain(
      "DESIGN_FIELD_PLACEHOLDER",
    );
  });

  it("'supersedes' apunta a una revisión entera, nunca a uno de sus estados", () => {
    const conAnchor = editFront(
      FLOW,
      "supersedes: DES-001/FLW-001@r1",
      "supersedes: DES-001/FLW-001@r1#default",
    );
    const failure = validate(conAnchor, "flow").failures[0];
    expect(failure?.code).toBe("DESIGN_FIELD_INVALID");
    expect(failure?.message).toContain("anchor");
  });

  it("omitir una clave obligatoria falla: el schema la declara required", () => {
    expect(
      codes(editFront(FLOW, /^not_applicable: .*$/m, "# sin not_applicable"), "flow"),
    ).toContain("DESIGN_FIELD_INVALID");
    expect(codes(editFront(FLOW, /^actors: .*$/m, "# sin actors"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
    expect(codes(editFront(SCREEN, /^flow_refs: .*$/m, "# sin flow_refs"), "screen")).toContain(
      "DESIGN_FIELD_INVALID",
    );
  });

  it("un criterio narrado en el cuerpo y ausente de 'trace' es trazabilidad que solo existe en prosa", () => {
    const inventado = editBody(FLOW, "Cubre S046/AC-01", "Cubre S046/AC-01 y S046/AC-99");
    const failure = validate(inventado, "flow").failures.find(
      (f) => f.code === "DESIGN_BODY_CRITERION_UNKNOWN",
    );
    expect(failure?.message).toContain("S046/AC-99");
    expect(failure?.action).toContain("'trace'");
  });

  it("un asset citado en el cuerpo y ausente de las dependencias también se reporta", () => {
    const ajeno = editBody(
      SCREEN,
      "Encabezado con el título",
      `Usa sha256:${"a".repeat(64)}. Encabezado con el título`,
    );
    expect(codes(ajeno, "screen")).toContain("DESIGN_BODY_REFERENCE_UNKNOWN");
  });

  // La prosa antes del primer `##` no pertenece a ninguna sección. Prohibirla
  // sería una regla que la spec no enuncia; cosecharla cierra el hueco sin
  // inventar nada — que era el punto.
  it("la prosa antes de la primera sección se cosecha, no se prohíbe", () => {
    const split = splitDesignDocument(FLOW);
    if (split === null) throw new Error("el fixture perdió su frontmatter");

    const conTitulo = `---\n${split.frontmatter}\n---\n# Alta de miembro\n${split.body}`;
    expect(validate(conTitulo, "flow").failures).toEqual([]);

    const conRefColgante = `---\n${split.frontmatter}\n---\nVer DES-001/SCR-099@r1#default.\n${split.body}`;
    expect(codes(conRefColgante, "flow")).toContain("DESIGN_BODY_REFERENCE_UNKNOWN");

    const conCriterioColgante = `---\n${split.frontmatter}\n---\nCubre S046/AC-99.\n${split.body}`;
    expect(codes(conCriterioColgante, "flow")).toContain("DESIGN_BODY_CRITERION_UNKNOWN");
  });

  // El defecto más caro que encontró la auditoría: la doctrina y los propios
  // fixtures llevan ejemplos del formato dentro de fences. Cosecharlos como si
  // fueran afirmaciones haría que todo documento que ENSEÑA el formato fallara.
  it.each(["```", "~~~"])(
    "un ejemplo dentro de un fence %s es documentación, no una afirmación",
    (fence) => {
      const ejemplo = [
        "",
        "Así se declara una transición:",
        "",
        `${fence}yaml`,
        "nodes: [DES-999/SCR-999@r9#inexistente]",
        "trace: [{criterion: S999/AC-99}]",
        `assets: [sha256:${"b".repeat(64)}]`,
        fence,
      ].join("\n");
      const conEjemplo = editBody(
        FLOW,
        "\n\n## Alternatives and recovery",
        `${ejemplo}\n\n## Alternatives and recovery`,
      );

      // El documento entero sigue siendo válido: el fence no aportó ninguna
      // referencia, ningún criterio y ningún asset.
      expect(validate(conEjemplo, "flow").failures).toEqual([]);
    },
  );

  it("pero fuera del fence, la misma referencia sí se cosecha", () => {
    const afuera = editBody(
      FLOW,
      "\n\n## Alternatives and recovery",
      "\n\nVer DES-999/SCR-999@r9#inexistente.\n\n## Alternatives and recovery",
    );
    expect(codes(afuera, "flow")).toContain("DESIGN_BODY_REFERENCE_UNKNOWN");
  });
});

describe("los finales de línea no cambian el significado", () => {
  it("el mismo documento en CRLF valida igual y produce el mismo modelo", () => {
    const crlf = FLOW.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(FLOW);
    expect(validate(crlf, "flow").failures).toEqual([]);
    expect(validate(crlf, "flow").value).toEqual(validate(FLOW, "flow").value);
  });
});

describe("más hallazgos confirmados por el review gate", () => {
  it("los nodos de un flow son ESTADOS de pantalla, como exige el schema", () => {
    const sinAnchor = editFront(FLOW, "  - DES-001/SCR-002@r1#success", "  - DES-001/SCR-002@r1");
    const failure = validate(sinAnchor, "flow").failures.find(
      (f) => f.code === "DESIGN_FIELD_INVALID",
    );
    expect(failure?.message).toContain("no lleva anchor");
  });

  it("y las listas que referencian revisiones enteras rechazan el anchor", () => {
    const conAnchor = editFront(
      SCREEN,
      "flow_refs: [DES-001/FLW-001@r2]",
      "flow_refs: [DES-001/FLW-001@r2#paso]",
    );
    const failure = validate(conAnchor, "screen").failures.find(
      (f) => f.code === "DESIGN_FIELD_INVALID",
    );
    expect(failure?.message).toContain("lleva un anchor");
  });

  it("omitir 'supersedes' falla: el schema la declara obligatoria", () => {
    expect(codes(editFront(FLOW, /^supersedes: .*$/m, "# sin supersedes"), "flow")).toContain(
      "DESIGN_FIELD_INVALID",
    );
  });

  it("'N/A' tampoco pasa en trazabilidad, en el propósito de un estado ni en un actor", () => {
    expect(
      codes(
        editFront(
          FLOW,
          "    source: docs/specs/046-spec-nacimiento-familias.md",
          "    source: N/A",
        ),
        "flow",
      ),
    ).toContain("DESIGN_FIELD_PLACEHOLDER");
    expect(
      codes(editFront(FLOW, "  - criterion: S046/AC-01", "  - criterion: TBD"), "flow"),
    ).toContain("DESIGN_FIELD_PLACEHOLDER");
    expect(codes(editFront(FLOW, "actors: [operador]", "actors: [N/A]"), "flow")).toContain(
      "DESIGN_FIELD_PLACEHOLDER",
    );
    expect(
      codes(
        editFront(
          SCREEN,
          "    purpose: Formulario vacío, listo para completar",
          "    purpose: TBD",
        ),
        "screen",
      ),
    ).toContain("DESIGN_FIELD_PLACEHOLDER");
  });

  it("la razón de una no-aplicabilidad tampoco puede ser un placeholder", () => {
    const naPlaceholder = editFront(
      FLOW,
      /not_applicable: \{[^}]*\}/,
      "not_applicable: {permissions_and_privacy: N/A}",
    );
    expect(codes(naPlaceholder, "flow")).toContain("DESIGN_NOT_APPLICABLE_NO_REASON");
  });
});

describe("el último hallazgo del review gate: la acción correctiva tiene que ser la correcta", () => {
  // Una arista sin anchor ya fallaba por pertenencia a 'nodes', pero el consejo
  // era agregar la referencia sin anchor a 'nodes' — que ahora también falla.
  // Un diagnóstico que manda al autor a un callejón no cumple el contrato.
  it("un extremo de arista sin anchor se diagnostica por el anchor, no por la pertenencia", () => {
    const sinAnchor = editFront(
      FLOW,
      "    to: DES-001/SCR-002@r1#success",
      "    to: DES-001/SCR-002@r1",
    );
    const failures = validate(sinAnchor, "flow").failures;
    const failure = failures.find((f) => f.message.includes("edges['submit']"));
    expect(failure?.message).toContain("conecta ESTADOS");
    expect(failure?.action).toContain("agregá el anchor");
    expect(failures.map((f) => f.action)).not.toContain(
      "agregá ese estado a 'nodes' o corregí la arista",
    );
  });
});
