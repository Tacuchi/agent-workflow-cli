import { describe, expect, it } from "vitest";
import { type YamlValue, parseYamlSubset } from "../../src/domain/design/yaml-subset.js";

function value(source: string): Record<string, YamlValue> {
  const result = parseYamlSubset(source);
  if (!result.ok)
    throw new Error(`esperaba parseo válido y falló en la línea ${result.line}: ${result.why}`);
  return result.value;
}

function rejection(source: string): { line: number; why: string } {
  const result = parseYamlSubset(source);
  if (result.ok) throw new Error("esperaba un rechazo y el parser aceptó el documento");
  return { line: result.line, why: result.why };
}

describe("parseYamlSubset — escalares", () => {
  it("distingue texto, entero, booleano y null", () => {
    expect(
      value(
        ["title: Edit user", "revision: 3", "draft: true", "supersedes: null", "extra: ~"].join(
          "\n",
        ),
      ),
    ).toEqual({ title: "Edit user", revision: 3, draft: true, supersedes: null, extra: null });
  });

  it("una clave sin valor ni bloque es null, igual que escribir null", () => {
    expect(value("unknowns:\nplatform: web")).toEqual({ unknowns: null, platform: "web" });
  });

  it("conserva las comillas como delimitador y no como contenido", () => {
    expect(value(`a: "con: dos puntos"\nb: 'con # numeral'`)).toEqual({
      a: "con: dos puntos",
      b: "con # numeral",
    });
  });

  it("desescapa \\n y comillas dentro de comillas dobles, y '' dentro de simples", () => {
    expect(value(`a: "linea\\nnueva"\nb: "dijo \\"hola\\""\nc: 'it''s'`)).toEqual({
      a: "linea\nnueva",
      b: 'dijo "hola"',
      c: "it's",
    });
  });
});

describe("parseYamlSubset — comentarios y el anchor de estado", () => {
  // El caso que rompería todo el contrato: `#empty` es parte del identificador,
  // no un comentario. En YAML un '#' solo comenta si viene después de espacio.
  it("NO corta la referencia en el '#' de un anchor de estado", () => {
    expect(value("entry: DES-001/SCR-001@r2#default")).toEqual({
      entry: "DES-001/SCR-001@r2#default",
    });
    expect(value("nodes: [DES-001/SCR-002@r2#empty, DES-001/SCR-002@r2#error]")).toEqual({
      nodes: ["DES-001/SCR-002@r2#empty", "DES-001/SCR-002@r2#error"],
    });
  });

  it("sí corta un comentario real, precedido por espacio o al inicio de línea", () => {
    expect(value("# encabezado\nplatform: web  # solo web por ahora\nid: DES-001/FLW-001")).toEqual(
      {
        platform: "web",
        id: "DES-001/FLW-001",
      },
    );
  });

  it("no corta un '#' dentro de comillas", () => {
    expect(value(`title: "tablero #1"`)).toEqual({ title: "tablero #1" });
  });
});

describe("parseYamlSubset — bloques anidados", () => {
  it("lee un mapping anidado", () => {
    expect(
      value(
        [
          "dependencies:",
          "  rules: [RUL-001]",
          "  tokens: []",
          "  assets: []",
          "platform: web",
        ].join("\n"),
      ),
    ).toEqual({
      dependencies: { rules: ["RUL-001"], tokens: [], assets: [] },
      platform: "web",
    });
  });

  it("lee una secuencia de escalares, indentada o al ras de su clave", () => {
    expect(value("actors:\n  - operator\n  - admin")).toEqual({ actors: ["operator", "admin"] });
    expect(value("actors:\n- operator\n- admin")).toEqual({ actors: ["operator", "admin"] });
  });

  it("lee una secuencia de mappings multilínea", () => {
    const source = [
      "edges:",
      "  - from: DES-001/SCR-001@r2#default",
      "    trigger: submit",
      "    to: DES-001/SCR-002@r1#success",
      "  - from: DES-001/SCR-001@r2#default",
      "    trigger: cancel",
      "    to: DES-001/SCR-003@r1#default",
      "trace: []",
    ].join("\n");
    expect(value(source)).toEqual({
      edges: [
        {
          from: "DES-001/SCR-001@r2#default",
          trigger: "submit",
          to: "DES-001/SCR-002@r1#success",
        },
        {
          from: "DES-001/SCR-001@r2#default",
          trigger: "cancel",
          to: "DES-001/SCR-003@r1#default",
        },
      ],
      trace: [],
    });
  });

  it("lee un mapping dentro de un ítem de secuencia", () => {
    const source = [
      "states:",
      "  - anchor: empty",
      "    meta:",
      "      role: status",
      "      level: 2",
      "  - anchor: error",
      "    meta:",
      "      role: alert",
    ].join("\n");
    expect(value(source)).toEqual({
      states: [
        { anchor: "empty", meta: { role: "status", level: 2 } },
        { anchor: "error", meta: { role: "alert" } },
      ],
    });
  });
});

describe("parseYamlSubset — flow style", () => {
  it("lee secuencias y mappings vacíos", () => {
    expect(value("unknowns: []\nnot_applicable: {}")).toEqual({ unknowns: [], not_applicable: {} });
  });

  it("lee un mapping en flow style y uno anidado", () => {
    expect(
      value("not_applicable: {localization: sin i18n, responsive_and_adaptation: solo desktop}"),
    ).toEqual({
      not_applicable: { localization: "sin i18n", responsive_and_adaptation: "solo desktop" },
    });
    expect(value("trace: [{criterion: AC-01, kind: visual}]")).toEqual({
      trace: [{ criterion: "AC-01", kind: "visual" }],
    });
  });

  it("respeta comas y corchetes dentro de comillas", () => {
    expect(value(`items: ["a, b", 'c]d']`)).toEqual({ items: ["a, b", "c]d"] });
  });
});

describe("parseYamlSubset — todo lo que queda fuera del subconjunto se RECHAZA", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["anclas", "a: &ancla valor", /anclas/],
    ["alias", "a: *ancla", /alias/],
    ["tags", "a: !!str valor", /tags/],
    ["block scalar folded", "description: >-\n  texto largo", /block scalars/],
    ["block scalar literal", "description: |\n  texto largo", /block scalars/],
    ["merge keys", "<<: base", /merge keys/],
    ["claves complejas", "? clave\n: valor", /claves complejas/],
    ["multi-documento", "a: 1\n---\nb: 2", /'---'/],
    ["tabulaciones", "a:\n\tb: 1", /tabulaciones/],
    ["clave repetida", "a: 1\na: 2", /repetida/],
    ["comilla sin cerrar", 'a: "sin cierre', /comilla doble/],
    ["flow sin cerrar", "a: [1, 2", /sin cerrar/],
    ["línea que no es clave: valor", "esto no tiene dos puntos", /se esperaba 'clave: valor'/],
    ["documento indentado", "  a: 1", /arranca indentado/],
    ["ítem de secuencia vacío", "a:\n  -\n  - b", /ítem de secuencia vacío/],
    ["ítem vacío en flow style", "a: [1, ]", /ítem vacío/],
    ["coma sola en flow style", "a: [,]", /ítem vacío/],
    ["anidamiento patológico", `a: ${"[".repeat(40)}1${"]".repeat(40)}`, /anidamiento/],
    ["frontmatter gigante", `a: ${"x".repeat(70000)}`, /supera/],
    ["carácter de control", `a: w${String.fromCharCode(0)}eb`, /carácter de control/],
  ];

  it.each(cases)("rechaza %s", (_name, source, expected) => {
    const failure = rejection(source);
    expect(failure.why).toMatch(expected);
    expect(failure.line).toBeGreaterThan(0);
  });

  // `007` se leía 7 y `revision: 007` pasaba como entero. Ahora queda string y el
  // validador de dominio lo rechaza nombrando el campo, en vez de coaccionar.
  it("el rechazo apunta a la línea exacta", () => {
    expect(rejection("a: 1\nb: 2\nc: &x 3").line).toBe(3);
  });
});

describe("parseYamlSubset — un frontmatter de flow completo", () => {
  it("resuelve identidad, grafo y trazabilidad sin interpretar prosa", () => {
    const source = [
      "schema: workline.ui-flow/v1",
      "id: DES-001/FLW-001",
      "revision: 2",
      "maturity: handoff",
      "supersedes: DES-001/FLW-001@r1",
      "purpose: Alta de un miembro nuevo",
      "platform: web",
      "actors: [operator]",
      "entry: DES-001/SCR-001@r2#default",
      "nodes:",
      "  - DES-001/SCR-001@r2#default",
      "  - DES-001/SCR-002@r1#success",
      "edges:",
      "  - from: DES-001/SCR-001@r2#default",
      "    trigger: submit",
      "    action: crear miembro",
      "    to: DES-001/SCR-002@r1#success",
      "dependencies: []",
      "trace:",
      "  - criterion: S046/AC-01",
      "    kind: visual",
      "unknowns: []",
      "not_applicable: {}",
    ].join("\n");

    const parsed = value(source);
    expect(parsed.schema).toBe("workline.ui-flow/v1");
    expect(parsed.revision).toBe(2);
    expect(parsed.nodes).toHaveLength(2);
    expect((parsed.edges as YamlValue[])[0]).toMatchObject({ trigger: "submit" });
    expect(parsed.entry).toBe("DES-001/SCR-001@r2#default");
    expect(parsed.not_applicable).toEqual({});
  });
});

describe("parseYamlSubset — lo que NO se coacciona", () => {
  // Los editores agregan BOM sin avisar. Tolerarlo es lo correcto: no cambia
  // ningún valor, y rechazarlo sería castigar al autor por su editor.
  it("tolera un BOM al inicio sin alterar nada", () => {
    expect(value(`${String.fromCharCode(0xfeff)}platform: web`)).toEqual({ platform: "web" });
  });

  it("no coacciona enteros no canónicos: quedan como texto", () => {
    expect(value("a: 007\nb: +2\nc: 1_000\nd: 0x10\ne: 42")).toEqual({
      a: "007",
      b: "+2",
      c: "1_000",
      d: "0x10",
      e: 42,
    });
  });

  it("no coacciona yes/no/on/off: solo true y false son booleanos", () => {
    expect(value("a: yes\nb: no\nc: on\nd: true")).toEqual({
      a: "yes",
      b: "no",
      c: "on",
      d: true,
    });
  });
});

describe("parseYamlSubset — los defectos que cazó el review gate", () => {
  // El más grave: mi test solo tenía la secuencia AL FINAL del documento. En un
  // frontmatter real siempre hay una clave después, y eso reventaba.
  it("una secuencia al ras de su clave termina donde empieza la clave siguiente", () => {
    expect(value("actors:\n- operator\nplatform: web")).toEqual({
      actors: ["operator"],
      platform: "web",
    });
    expect(value("nodes:\n- a\n- b\nedges:\n- from: a\n  to: b\ntrace: []")).toEqual({
      nodes: ["a", "b"],
      edges: [{ from: "a", to: "b" }],
      trace: [],
    });
  });

  it("rechaza anclas, alias y tags también DENTRO de secuencias y flow style", () => {
    expect(rejection("edges:\n  - from: &ancla x").why).toMatch(/anclas/);
    expect(rejection("actors: [!!str operator]").why).toMatch(/tags/);
    expect(rejection("nodes: [*ref]").why).toMatch(/alias/);
  });

  it("un apóstrofo en un escalar plano no se traga el comentario", () => {
    expect(value("purpose: it's a form  # nota")).toEqual({ purpose: "it's a form" });
    // Y la comilla que SÍ abre un escalar sigue protegiendo su contenido.
    expect(value("a: 'con # numeral'  # nota")).toEqual({ a: "con # numeral" });
  });

  // `out["__proto__"] = v` sobre un objeto literal REESCRIBE el prototipo, y
  // `"constructor" in out` es true sin que nadie haya escrito esa clave.
  it("las claves heredadas de Object.prototype no son duplicados ni contaminan", () => {
    expect(value("constructor: web\ntoString: x")).toEqual({ constructor: "web", toString: "x" });
    const parsed = value("__proto__:\n  polluted: true");
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(Object.keys({}).length).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
