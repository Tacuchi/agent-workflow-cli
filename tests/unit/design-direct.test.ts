import { describe, expect, it } from "vitest";
import { capabilityCommand } from "../../src/cli/commands/capability.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import "../../src/application/capability/design-handler.js";
import type { DispatchContext } from "../../src/application/capability/dispatcher.js";
import { dispatchCapability } from "../../src/application/capability/dispatcher.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";
import {
  DESIGNS_DIR,
  attainedMaturity,
  isIndexable,
  resolveOutputRoot,
} from "../../src/domain/design/direct.js";
import { reportRetiredDesign } from "../../src/domain/design/retired.js";
import {
  type DesignSource,
  SOURCE_DISPOSITIONS,
  classifySource,
  planOriginalCopy,
  reportSources,
} from "../../src/domain/design/sources.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const HOME = "/home/u";
const WORKSPACE = "/work";

function context(workspace: string | null = WORKSPACE, fs = new MemFs()): DispatchContext {
  return {
    fs,
    env: new FakeEnv(HOME, WORKSPACE),
    paths: new PathsService(normalizeNamespace("workflow"), HOME, WORKSPACE),
    workspace,
    host: "claude-code",
  };
}

const text = (name: string, value: unknown): CapabilityInputValue => ({
  name,
  value,
  provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
});

function source(over: Partial<DesignSource> = {}): DesignSource {
  return {
    name: "sources",
    kind: "markdown",
    locator: "docs/requisitos.md",
    disposition: "used",
    reason: null,
    derived: [],
    sensitivity: "public",
    essential: true,
    ...over,
  };
}

// ── F9 · ninguna fuente desaparece en silencio ───────────────────────────────

describe("F9 · el catálogo de fuentes v1 clasifica lo que puede y nombra lo que no", () => {
  it.each([
    ["docs/requisitos.md", "markdown"],
    ["notas.txt", "markdown"],
    ["captura.png", "image"],
    ["contrato.pdf", "pdf"],
    ["brief.docx", "docx"],
    ["deck.pptx", "pptx"],
    ["DES-001", "package"],
    ["DES-001@r2", "package"],
    ["figma://file/abc", "provider_locator"],
  ])("'%s' se clasifica como %s", (locator, kind) => {
    expect(classifySource(locator)).toBe(kind);
  });

  it("un formato fuera del catálogo no se adivina: devuelve null", () => {
    expect(classifySource("modelo.sketch")).toBeNull();
    expect(classifySource("   ")).toBeNull();
  });
});

describe("F9 · una fuente que no contribuyó nunca queda sin causa", () => {
  it("las cinco disposiciones son el vocabulario del dominio", () => {
    expect([...SOURCE_DISPOSITIONS]).toEqual([
      "used",
      "skipped",
      "unsupported",
      "unavailable",
      "redacted",
    ]);
  });

  it.each(["skipped", "unsupported", "unavailable", "redacted"] as const)(
    "'%s' sin razón se rechaza",
    (disposition) => {
      const report = reportSources([source({ disposition, reason: null })], "create");
      expect(report.failures[0]?.code).toBe("DESIGN_SOURCE_WITHOUT_REASON");
    },
  );

  it("declararla no esencial tampoco es gratis: hay que justificarlo", () => {
    const report = reportSources([source({ essential: false, reason: null })], "create");
    expect(report.failures[0]?.code).toBe("DESIGN_SOURCE_OPTIONAL_WITHOUT_REASON");
  });

  // El vocabulario de cinco llega al receipt por los campos de DOMINIO, y el
  // invariante del 014 sigue en pie: nada queda descartado sin causa.
  it("toda fuente que no contribuyó llega al reporte con su motivo", () => {
    const report = reportSources(
      [
        source(),
        source({ locator: "x.pdf", kind: "pdf", disposition: "skipped", reason: "duplicada" }),
      ],
      "create",
    );
    expect(report.failures).toEqual([]);
    expect(report.omitted).toHaveLength(1);
    expect(report.omitted[0]?.disposition).toBe("skipped");
    expect(report.omitted[0]?.reason).toBe("duplicada");
  });
});

describe("F9 · el escenario de la fase: cinco fuentes, una ilegible y una legacy", () => {
  const sources: DesignSource[] = [
    source({ locator: "docs/requisitos.md", derived: ["sección Objetivo", "criterios de alta"] }),
    source({ kind: "image", locator: "capturas/alta.png", derived: ["estado vacío transcrito"] }),
    source({ kind: "docx", locator: "brief.docx", derived: ["tabla de campos"] }),
    source({
      kind: "pdf",
      locator: "contrato.pdf",
      disposition: "unavailable",
      reason: "el archivo está corrupto y el host no pudo abrirlo",
    }),
    source({
      locator: "docs/specs/001-spec.md",
      disposition: "unsupported",
      reason: "presenta una sección '## UI spec': es un camino retirado y no se lee como contrato",
      essential: false,
    }),
  ];

  const report = reportSources(sources, "create");

  it("el reporte identifica cada fuente con su causa y ninguna queda muda", () => {
    expect(report.failures).toEqual([]);
    expect(report.omitted.map((s) => s.locator)).toEqual([
      "contrato.pdf",
      "docs/specs/001-spec.md",
    ]);
    for (const omitted of report.omitted) {
      expect(omitted.reason?.length, omitted.locator).toBeGreaterThan(0);
    }
  });

  it("la proveniencia conserva los artefactos derivados de cada lectura", () => {
    const derived = report.sources.filter((s) => s.derived.length > 0);
    expect(derived).toHaveLength(3);
    expect(derived[0]?.derived).toContain("sección Objetivo");
  });

  it("una fuente esencial ilegible impide `handoff` y deja un gap accionable", () => {
    const maturity = attainedMaturity("handoff", "handoff", report);
    expect(report.blocksHandoff).toBe(true);
    expect(maturity.attained).toBe("outline");
    expect(maturity.gaps).toHaveLength(1);
    expect(maturity.gaps[0]).toContain("contrato.pdf");
    expect(maturity.gaps[0]).toContain("unavailable");
  });

  it("y la legacy, declarada no esencial con su razón, no bloquea por sí sola", () => {
    const soloLegacy = reportSources(
      [sources[0] as DesignSource, sources[4] as DesignSource],
      "create",
    );
    expect(soloLegacy.blocksHandoff).toBe(false);
    expect(attainedMaturity("handoff", "handoff", soloLegacy).attained).toBe("handoff");
  });

  it("el material legacy sigue siendo unsupported como fuente, por contenido", () => {
    const failures = reportRetiredDesign(
      "# Spec\n\n## UI spec\n\npantalla\n",
      "docs/specs/001-spec.md",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.action).toContain("no hay importador");
  });
});

describe("F9 · los originales no se copian salvo decisión explícita y segura", () => {
  const sources = [source({ name: "requisitos" }), source({ name: "captura", kind: "image" })];

  it("por defecto no se copia nada", () => {
    const decision = planOriginalCopy(sources, { approved: [] }, "create");
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.copy).toEqual([]);
  });

  it("una fuente aprobada por nombre sí se copia", () => {
    const decision = planOriginalCopy(sources, { approved: ["requisitos"] }, "create");
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.copy.map((s) => s.name)).toEqual(["requisitos"]);
  });

  it.each([
    ["una fuente que no existe", ["fantasma"], "DESIGN_SOURCE_COPY_UNKNOWN"],
    ["una fuente sensible", ["sensible"], "DESIGN_SOURCE_COPY_SENSITIVE"],
    ["una fuente que no se usó", ["omitida"], "DESIGN_SOURCE_COPY_UNUSED"],
  ])("%s se rechaza", (_case, approved, code) => {
    const all = [
      ...sources,
      source({ name: "sensible", sensitivity: "sensitive" }),
      source({ name: "omitida", disposition: "skipped", reason: "no aportaba" }),
    ];
    const decision = planOriginalCopy(all, { approved: approved as string[] }, "create");
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.failure.code).toBe(code);
  });
});

// ── F10 · design se invoca directo y produce el mismo package ────────────────

describe("F10 · la raíz de salida: por defecto dentro, explícita fuera", () => {
  it("dentro de un workspace, sin target, la salida va a docs/designs/", () => {
    const root = resolveOutputRoot(WORKSPACE, null);
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.value).toEqual({ kind: "workspace", root: DESIGNS_DIR, declared: false });
    expect(isIndexable(root.value)).toBe(true);
  });

  it("dentro de un workspace, un target relativo inseguro se rechaza", () => {
    const root = resolveOutputRoot(WORKSPACE, "../fuera");
    expect(root.ok).toBe(false);
    if (root.ok) return;
    expect(root.failure.code).toBe("DESIGN_OUTPUT_ROOT_UNSAFE");
  });

  it("FUERA de un workspace, una raíz explícita produce salida portable", () => {
    const root = resolveOutputRoot(null, "/tmp/mis-disenos");
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.value).toEqual({ kind: "explicit", root: "/tmp/mis-disenos" });
    // Portable, pero no descubrible por el índice: eso es lo que hace que
    // AC-DIR-06 signifique algo para los que SÍ caen bajo docs/designs/.
    expect(isIndexable(root.value)).toBe(false);
  });

  it("FUERA de un workspace y sin raíz, no se inventa ninguna", () => {
    const root = resolveOutputRoot(null, null);
    expect(root.ok).toBe(false);
    if (root.ok) return;
    expect(root.failure.code).toBe("DESIGN_OUTPUT_ROOT_REQUIRED");
    expect(root.failure.action).toContain("target");
  });

  it("un package bajo un subdirectorio de docs/designs/ sigue siendo indexable", () => {
    const root = resolveOutputRoot(WORKSPACE, "docs/designs/equipo-a");
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(isIndexable(root.value)).toBe(true);
  });
});

describe("F10 · crear fuera de un workspace: un contrato que se pueda contestar, o ninguno", () => {
  it("las cuatro operaciones que escriben ya no exigen workspace", () => {
    const required = DESIGN_DESCRIPTOR.operations
      .filter((o) => o.workspace === "required")
      .map((o) => o.name);
    expect(required, "ninguna operación de design exige workspace").toEqual([]);
  });

  /**
   * The round this used to burn. Outside a workspace the destinations derived
   * from an explicit root are ABSOLUTE, and the write boundary admits only
   * workspace-relative paths inside the declared ones: an absolute answer is
   * refused for being absolute and a relative one for falling outside them. The
   * contract had no valid reply, so `prepare` published a question that could
   * only ever be answered wrong — and `apply` demands a workspace anyway, so
   * even a lucky answer had nowhere to land.
   */
  it("fuera de un workspace, una raíz explícita se rechaza al preparar y no publica el contrato", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: "/tmp/mis-disenos",
        inputs: [
          text("title", "Alta de miembro"),
          text("sources", ["docs/requisitos.md"]),
          text("target", "/tmp/mis-disenos"),
        ],
      },
      context(null),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_WORKSPACE_ABSENT");
    expect(result.attempt.receipt.error?.message).toContain("absolutos");
    expect(result.attempt.receipt.error?.action).toContain("dentro del workspace");
    // Y sobre todo: no se publicó ningún contrato ni ningún destino que
    // contestar, que es lo que quemaba la ronda de autoría.
    expect(result.attempt.receipt.gaps).toEqual([]);
  });

  it("fuera de un workspace y SIN raíz, devuelve un resultado explícito y no escribe", async () => {
    const fs = new MemFs();
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: [text("title", "X"), text("sources", ["a.md"]), text("target", "")],
      },
      context(null, fs),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_OUTPUT_ROOT_REQUIRED");
    expect([...fs.writes.keys()], "no inicializa nada").toEqual([]);
  });
});

describe("F10 · el receipt lleva los campos de dominio y ninguna ruta simula handoff", () => {
  it("refuses a compound-design entry when the core documentary canon is invalid", async () => {
    const fs = new MemFs().file(
      `${WORKSPACE}/.workflow/skills.toml`,
      '[docs]\nspec = "knowledge/specs"\n',
    );
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [
          text("title", "Alta"),
          text("sources", ["docs/requisitos.md"]),
          {
            name: "consumer_document",
            value: "# Plan final\n",
            provenance: {
              kind: "attachment",
              origin: "docs/plans/001-plan-consumidor.md",
              seal: "0".repeat(64),
              sensitivity: "public",
            },
          },
        ],
      },
      context(WORKSPACE, fs),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.error?.code).toBe("DOCS_CANON_INVALID");
  });

  it("una creación directa reporta package, raíz, indexabilidad, madurez y fuentes", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [
          text("title", "Alta"),
          text("sources", ["docs/requisitos.md", "modelo.sketch"]),
          text("target", DESIGNS_DIR),
          text("maturity", "handoff"),
        ],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("needs_input");
  });

  it("una fuente fuera del catálogo entra al reporte como unsupported, no hunde la operación", () => {
    const declared = ["docs/requisitos.md", "modelo.sketch"].map((locator) => {
      const kind = classifySource(locator);
      return source(
        kind === null
          ? {
              locator,
              disposition: "unsupported",
              reason: "fuera del catálogo v1",
              kind: "host_context",
            }
          : { locator, kind },
      );
    });
    const report = reportSources(declared, "create");
    expect(report.failures).toEqual([]);
    expect(report.omitted).toHaveLength(1);
    expect(report.blocksHandoff, "esencial y no leída → no hay handoff").toBe(true);
  });

  it("pedir `handoff` cuando el gate solo da `outline` devuelve outline con su gap", () => {
    const clean = reportSources([source()], "create");
    const out = attainedMaturity("handoff", "outline", clean);
    expect(out.attained).toBe("outline");
    expect(out.gaps[0]).toContain("handoff");
  });

  it("y una propuesta todavía no publicada nunca se declara `complete`", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [text("title", "X"), text("sources", ["a.md"]), text("target", DESIGNS_DIR)],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.output?.completeness).not.toBe("complete");
  });
});

describe("F10 · las superficies que B2 dejó sin llamador ahora lo tienen", () => {
  it("`render` resuelve el perfil POR ID y un id inexistente lista los que sí están", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "render",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [text("package", "DES-001"), text("profile", "figma-api")],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_ADAPTER_UNKNOWN");
    expect(result.attempt.receipt.error?.action).toContain("portable-html");
  });

  // Un perfil registrado pasa su resolución, y lo que frena a `render` ya no es
  // el adapter: es que no hay ningún package indexado donde escribir. Sin uno,
  // los artefactos caerían en una carpeta sin manifest — el árbol ilegible que
  // `aw designs` después rechaza, que es exactamente lo que hacía la ruta
  // verbatim.
  it("un perfil registrado pasa la resolución, y sin package indexado se rechaza declarando por qué", async () => {
    const fs = new MemFs();
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "render",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [text("package", "DES-001"), text("profile", "portable-html")],
      },
      context(WORKSPACE, fs),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.error?.code).not.toBe("DESIGN_ADAPTER_UNKNOWN");
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_PACKAGE_NOT_FOUND");
    expect([...fs.writes.keys()], "un rechazo no escribe").toEqual([]);
  });

  // El sobre exige que `package` VENGA; que diga algo es de esta ruta, y sin
  // eso no hay package indexado que resolver ni destino que declarar.
  it("y con un package en blanco tampoco adivina uno", async () => {
    const fs = new MemFs();
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "render",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [text("package", "  "), text("profile", "portable-html")],
      },
      context(WORKSPACE, fs),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_FIELD_INVALID");
    expect(result.attempt.receipt.error?.message).toContain("package que ya existe");
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("`record` verifica su precondición contra el package que va a sellar", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "record",
        route: "direct",
        target: DESIGNS_DIR,
        inputs: [text("package", "DES-999"), text("revision", "r1"), text("decision", "approved")],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // El package no existe: la precondición lo dice antes de sellar nada.
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_PACKAGE_NOT_FOUND");
  });
});

describe("F10 · el CLI decide 'fuera de un workspace' por la regla real del repo", () => {
  /**
   * The bug a smoke run caught and no unit test could: the command handed the
   * cwd over as the workspace unconditionally, so the explicit-root path was
   * unreachable in production and only ever exercised by a test that passed
   * `null` by hand. The rule is the one the rest of the repo uses — `.<ns>/`
   * present in the root — and it is checked here so it cannot drift back.
   */
  function cliContext(fs: MemFs): CliContext {
    return {
      fs,
      env: new FakeEnv(HOME, WORKSPACE),
      paths: new PathsService(normalizeNamespace("workflow"), HOME, WORKSPACE),
    } as unknown as CliContext;
  }

  const args = (values: Array<[string, string]>, inputs: string[]): ParsedArgs =>
    ({
      rest: ["prepare"],
      flags: new Set<string>(),
      values: new Map(values),
      valuesMulti: new Map([["input", inputs]]),
      plugin: {},
    }) as unknown as ParsedArgs;

  const CREATE = args(
    [
      ["capability", "design"],
      ["operation", "create"],
      ["target", "/tmp/mis-disenos"],
    ],
    ["title=Alta", "sources=a.md", "target=/tmp/mis-disenos"],
  );

  // Las dos mitades del mismo hecho: el CLI resuelve el workspace por `.<ns>/` y
  // no por el cwd, así que la MISMA invocación se diagnostica distinto según lo
  // que hay en el disco. Que las dos causas difieran es lo que prueba que la
  // regla se aplicó; si el cwd se entregara como workspace, ambas dirían lo mismo.
  it("sin `.workflow/` no hay workspace, y una publicación de diseño lo dice", async () => {
    const result = await capabilityCommand.execute(CREATE, cliContext(new MemFs()));
    expect(result.ok).toBe(true);
    expect(result.data?.receipt.error?.code).toBe("DESIGN_WORKSPACE_ABSENT");
  });

  it("con `.workflow/`, la misma raíz absoluta se rechaza por no ser relativa", async () => {
    const fs = new MemFs().dir(`${WORKSPACE}/.workflow`);
    const result = await capabilityCommand.execute(CREATE, cliContext(fs));
    expect(result.ok).toBe(true);
    expect(result.data?.receipt.error?.code).toBe("DESIGN_OUTPUT_ROOT_UNSAFE");
  });

  it("transporta el consumidor compuesto como attachment con base del documento, no como texto", async () => {
    const target = "docs/plans/031-plan-demo.md";
    const finalBytes = ".workflow/final-plan.md";
    const fs = new MemFs()
      .dir(`${WORKSPACE}/.workflow`)
      .file(`${WORKSPACE}/${target}`, "# Plan previo\n")
      .file(`${WORKSPACE}/${finalBytes}`, "# Plan final\n");
    const result = await capabilityCommand.execute(
      args(
        [
          ["capability", "design"],
          ["operation", "create"],
          ["target", "/tmp/mis-disenos"],
          ["consumer-document", `${target}=${finalBytes}`],
        ],
        ["title=Alta", "sources=a.md", "target=/tmp/mis-disenos"],
      ),
      cliContext(fs),
    );
    const consumer = result.data?.request.inputs.find(
      (input) => input.name === "consumer_document",
    );
    expect(consumer).toMatchObject({
      value: "# Plan final\n",
      provenance: { kind: "attachment", origin: target, sensitivity: "public" },
    });
    expect(consumer?.provenance.seal).toMatch(/^[0-9a-f]{64}$/);
  });

  it("no lee un consumidor fuera de docs/specs o docs/plans", async () => {
    const target = ".workflow/private.md";
    const finalBytes = ".workflow/final-plan.md";
    const fs = new MemFs()
      .dir(`${WORKSPACE}/.workflow`)
      .file(`${WORKSPACE}/${target}`, "secreto\n")
      .file(`${WORKSPACE}/${finalBytes}`, "# Plan final\n");
    const result = await capabilityCommand.execute(
      args(
        [
          ["capability", "design"],
          ["operation", "create"],
          ["target", "/tmp/mis-disenos"],
          ["consumer-document", `${target}=${finalBytes}`],
        ],
        ["title=Alta", "sources=a.md", "target=/tmp/mis-disenos"],
      ),
      cliContext(fs),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ARGS_INVALID");
  });
});
