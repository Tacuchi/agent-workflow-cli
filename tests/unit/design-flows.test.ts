import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import {
  resolveBaselineReference,
  resolveTaskReference,
} from "../../src/application/design/design-resolver-service.js";
import type { DesignArtifact } from "../../src/domain/design/artifact.js";
import { computeClosure, notReadyForHandoff } from "../../src/domain/design/closure.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import {
  parseSpecDesignReferences,
  parseTaskDesignReferences,
} from "../../src/domain/design/reference.js";
import {
  BUILTIN_DEFAULT_SKILLS,
  RETIRED_SKILL_IDENTITIES,
  SKILL_ROLES,
} from "../../src/domain/skills.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The flows stopped containing design (AC-FLW-01..03).
 *
 * F6 already proved the closure math and F3 the resolution rules. What is new
 * here is the DOCUMENTS: a spec that keeps three lines, a plan that pins exact
 * roots, and the walk from that Markdown down to a maturity verdict. If the
 * shape the doctrine tells the loops to write does not survive that walk, the
 * doctrine is wrong no matter how well the domain behaves.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");
const readRel = (rel: string): Promise<string> => readFile(join(SKILL_ROOT, rel), "utf8");

/**
 * The prose with its wrapping collapsed. Doctrine is hard-wrapped at 80
 * columns, so matching the raw text would pin the WRAPPING, not the rule.
 */
const flat = async (rel: string): Promise<string> => (await readRel(rel)).replace(/\s+/g, " ");

/**
 * One `##` section of a doctrine file, flattened.
 *
 * Scoping matters: the same words recur across sections of the same document,
 * so a whole-file match can pass on a sentence that says the opposite of what
 * the guard is about.
 *
 * Fenced blocks are NOT boundaries. Half the doctrine's sections carry a
 * ```markdown skeleton whose lines start with `## …`, and cutting there returns
 * the section's first paragraph while claiming to be the section.
 */
async function section(rel: string, heading: string): Promise<string> {
  const text = await readRel(rel);
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`'${rel}' no tiene la sección '${heading}'`);

  const body: string[] = [];
  let fenced = false;
  for (const line of text.slice(start + heading.length + 2).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && /^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").replace(/\s+/g, " ");
}

/** Every `.md` under the doctrine bundle — the whole live surface. */
async function everyDoctrineFile(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) out.push(full.slice(SKILL_ROOT.length + 1));
    }
  }
  await walk(SKILL_ROOT);
  return out.sort();
}

const WS = "/ws";
const PKG = "docs/designs/007-design-alta-familia";
const SPEC = "docs/specs/046-spec-alta-familia.md";
const PLAN_A = "docs/plans/031-plan-alta-familia.md";
const PLAN_B = "docs/plans/032-plan-panel-familias.md";

const DIGEST_R1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_R2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const ASSET = "sha256:5555555555555555555555555555555555555555555555555555555555555555";

/**
 * The package as they really are: thirteen screens, three of them promoted
 * because one plan is about to implement exactly those three.
 */
function mixedPackage(): {
  manifest: DesignManifest;
  read: (path: string) => DesignArtifact | null;
} {
  const raw = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
  const catalog = raw.catalog as Record<string, Array<Record<string, unknown>>>;

  catalog.screens = [];
  for (let n = 1; n <= 13; n++) {
    const id = `SCR-${String(n).padStart(3, "0")}`;
    catalog.screens.push({
      id,
      revision: 1,
      path: `screens/${id}-r001-pantalla.md`,
      supersedes: null,
      maturity: n <= 3 ? "handoff" : "outline",
      states: ["default"],
    });
  }
  catalog.flows = [
    {
      id: "FLW-001",
      revision: 1,
      path: "flows/FLW-001-r001-alta-familia.md",
      supersedes: null,
      maturity: "handoff",
    },
  ];
  raw.currentness = [];
  (raw.governance as { reviews: Array<Record<string, unknown>> }).reviews[0].target = "DES-001@r1";
  (raw.governance as { revocations: unknown[] }).revocations = [];
  (raw.relations as { specs: string[]; plans: string[] }).specs = [SPEC];
  (raw.relations as { specs: string[]; plans: string[] }).plans = [PLAN_A, PLAN_B];

  const parsed = validateDesignManifest(raw);
  if (!parsed.ok || parsed.value === null) {
    throw new Error(`el fixture no valida: ${parsed.failures[0]?.message}`);
  }

  const documents = new Map<string, DesignArtifact>();
  documents.set("flows/FLW-001-r001-alta-familia.md", {
    kind: "flow",
    schema: "workline.ui-flow/v1",
    id: "DES-001/FLW-001",
    revision: 1,
    maturity: "handoff",
    supersedes: null,
    purpose: "alta de familia",
    platform: "web",
    actors: ["operador"],
    entry: "DES-001/SCR-001@r1#default",
    nodes: [
      "DES-001/SCR-001@r1#default",
      "DES-001/SCR-002@r1#default",
      "DES-001/SCR-003@r1#default",
    ],
    edges: [],
    dependencies: [],
    trace: [],
    unknowns: [],
    external: [],
    not_applicable: {},
  });
  for (const n of [1, 2, 3]) {
    const id = `SCR-${String(n).padStart(3, "0")}`;
    documents.set(`screens/${id}-r001-pantalla.md`, {
      kind: "screen",
      schema: "workline.ui-screen/v1",
      id: `DES-001/${id}`,
      revision: 1,
      maturity: "handoff",
      supersedes: null,
      title: id,
      purpose: "pantalla",
      platform: "web",
      default_state: "default",
      states: [{ anchor: "default", purpose: "base" }],
      flow_refs: [],
      dependencies: {
        rules: n === 1 ? ["DES-001/RUL-001@r1"] : [],
        tokens: [],
        assets: n === 1 ? [ASSET] : [],
      },
      trace: [],
      unknowns: [],
      external: [],
      not_applicable: {},
    });
  }

  return { manifest: parsed.value, read: (path) => documents.get(path) ?? null };
}

/** The reference block a spec or a plan keeps — the only design it carries. */
function referenceBlock(revision: number, digest: string): string {
  return [
    "## Design references",
    "",
    `- package: \`DES-001@r${revision}\``,
    `  baseline_hint: \`${PKG}/baselines/DES-001-r${String(revision).padStart(3, "0")}.json\``,
    `  digest: \`${digest}\``,
    "",
  ].join("\n");
}

/**
 * The spec `spec-refine` leaves behind: the requirement, and three lines of
 * reference. No screens, no regions, no mockups.
 */
const SPEC_DOC = [
  "---",
  "status: ready-for-plan",
  "---",
  "",
  "# Spec 046 — alta-familia",
  "",
  "## Requirement",
  "",
  "Una persona da de alta una familia desde el panel.",
  "",
  referenceBlock(2, DIGEST_R2),
  "## Decisions",
  "",
  "El diseño vive en su propio dossier.",
  "",
].join("\n");

/** Plan A implements the three promoted screens, and pins them one by one. */
const PLAN_A_DOC = [
  "# Plan 031 — alta-familia",
  "",
  "> Estado: open",
  "",
  referenceBlock(2, DIGEST_R2),
  "## Tasks",
  "",
  "### F1 — El alta se completa desde el formulario",
  "",
  "> Estado: pendiente",
  "",
  "**Trabajo:**",
  "- [ ] T1.1 — Formulario de alta · DES-001@r2 / SCR-001@r1#default",
  "- [ ] T1.2 — Confirmación · DES-001@r2 / SCR-002@r1#default",
  "- [ ] T1.3 — Resultado · DES-001@r2 / SCR-003@r1#default",
  "",
].join("\n");

/** Plan B shares the package and pins the EARLIER baseline. */
const PLAN_B_DOC = [
  "# Plan 032 — panel-familias",
  "",
  "> Estado: open",
  "",
  referenceBlock(1, DIGEST_R1),
  "## Tasks",
  "",
  "### F1 — El panel lista familias",
  "",
  "> Estado: pendiente",
  "",
  "**Trabajo:**",
  "- [ ] T1.1 — Listado · DES-001@r1 / SCR-001@r1#default",
  "",
].join("\n");

/** The closure roots a plan document pins, in the closure's own notation. */
function taskRoots(doc: string): string[] {
  return parseTaskDesignReferences(doc, PLAN_A).references.map((r) => {
    const { package: pkg, artifact, revision, state } = r.artifact;
    return `${pkg}/${artifact}@r${revision}${state === undefined ? "" : `#${state}`}`;
  });
}

function workspace(): MemFs {
  const { manifest } = mixedPackage();
  return new MemFs()
    .file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest))
    .file(`${WS}/${SPEC}`, SPEC_DOC)
    .file(`${WS}/${PLAN_A}`, PLAN_A_DOC)
    .file(`${WS}/${PLAN_B}`, PLAN_B_DOC);
}

describe("la spec guarda la referencia y no el diseño (AC-FLW-01)", () => {
  it("su `## Design references` resuelve contra el baseline exacto que fija", async () => {
    const parsed = parseSpecDesignReferences(SPEC_DOC, SPEC);
    expect(parsed.failures).toEqual([]);
    expect(parsed.references).toHaveLength(1);

    const reference = parsed.references[0];
    if (reference === undefined) throw new Error("la spec no declaró ninguna referencia");
    expect(reference.baseline).toEqual({ package: "DES-001", revision: 2 });
    expect(reference.digest).toBe(DIGEST_R2);

    const index = await readDesignIndex(workspace(), WS);
    const resolved = resolveBaselineReference(index, reference, SPEC);
    if (!resolved.ok) throw new Error(resolved.failure.message);
    expect(resolved.value.hint).toBe("valid");
    expect(resolved.value.package_path).toBe(PKG);
  });

  it("y no incrusta diseño: ninguna sección de UI, ningún mockup", () => {
    // El fallo que el package existe para terminar. Se comprueba por AUSENCIA
    // porque es lo único que distingue «referencia» de «copia».
    expect(SPEC_DOC).not.toContain("## UI spec");
    expect(SPEC_DOC).toMatch(/^##\s+Design references$/m);
    expect(SPEC_DOC).not.toMatch(/!\[|\.png|\.fig\b/);

    const section = SPEC_DOC.split("## Design references")[1]?.split(/^##\s/m)[0] ?? "";
    const keys = [...section.matchAll(/^\s*[-*]?\s*([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(["package", "baseline_hint", "digest"]);
  });
});

describe("el plan promueve solo lo que consume y fija raíces exactas (AC-FLW-02)", () => {
  it("cada tarea pinta una raíz exacta contra un baseline que el plan declara", async () => {
    const declared = parseSpecDesignReferences(PLAN_A_DOC, PLAN_A);
    expect(declared.failures).toEqual([]);

    const roots = parseTaskDesignReferences(PLAN_A_DOC, PLAN_A);
    expect(roots.failures).toEqual([]);
    expect(roots.references.map((r) => r.raw)).toEqual([
      "DES-001@r2 / SCR-001@r1#default",
      "DES-001@r2 / SCR-002@r1#default",
      "DES-001@r2 / SCR-003@r1#default",
    ]);

    const index = await readDesignIndex(workspace(), WS);
    for (const root of roots.references) {
      const resolved = resolveTaskReference(index, root, declared.references, PLAN_A);
      if (!resolved.ok) throw new Error(`${root.raw}: ${resolved.failure.message}`);
      expect(resolved.value.state).toBe("default");
    }
  });

  it("la clausura de esas raíces son esas tres y sus dependencias, y nada más", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, taskRoots(PLAN_A_DOC), read);
    expect(closure.failures).toEqual([]);
    expect(closure.members.map((m) => m.ref).sort()).toEqual([
      "DES-001/RUL-001@r1",
      "DES-001/SCR-001@r1",
      "DES-001/SCR-002@r1",
      "DES-001/SCR-003@r1",
    ]);
    expect(closure.assets).toEqual([ASSET]);
    expect(notReadyForHandoff(manifest, closure)).toEqual([]);
  });

  it("y las diez screens en outline conservan su revisión fuera de la clausura", () => {
    const { manifest, read } = mixedPackage();
    const reached = new Set(
      computeClosure(manifest, taskRoots(PLAN_A_DOC), read).members.map((m) => m.ref),
    );

    const outline = manifest.catalog.screens.filter((s) => s.maturity === "outline");
    expect(outline).toHaveLength(10);
    for (const screen of outline) {
      expect(reached.has(`DES-001/${screen.id}@r${screen.revision}`)).toBe(false);
    }
  });

  it("una raíz que consume una screen en outline NO se declara implementable", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/SCR-007@r1"], read);
    expect(notReadyForHandoff(manifest, closure).map((m) => m.ref)).toEqual(["DES-001/SCR-007@r1"]);
  });
});

describe("un refine mueve un plan y no al otro (AC-FLW-03)", () => {
  it("los dos planes comparten el package y cada uno resuelve la revisión que fijó", async () => {
    const index = await readDesignIndex(workspace(), WS);

    for (const [doc, path, revision, digest] of [
      [PLAN_A_DOC, PLAN_A, 2, DIGEST_R2],
      [PLAN_B_DOC, PLAN_B, 1, DIGEST_R1],
    ] as const) {
      const declared = parseSpecDesignReferences(doc, path);
      expect(declared.failures).toEqual([]);
      const reference = declared.references[0];
      if (reference === undefined) throw new Error(`${path} no declaró referencia`);
      expect(reference.baseline.revision).toBe(revision);

      const resolved = resolveBaselineReference(index, reference, path);
      if (!resolved.ok) throw new Error(`${path}: ${resolved.failure.message}`);
      expect(resolved.value.digest).toBe(digest);
    }
  });

  it("y la referencia del plan B seguiría siendo válida si el hint quedara viejo", async () => {
    const moved = new MemFs().file(
      `${WS}/docs/designs/099-design-renombrado/design-manifest.json`,
      JSON.stringify(mixedPackage().manifest),
    );
    const reference = parseSpecDesignReferences(PLAN_B_DOC, PLAN_B).references[0];
    if (reference === undefined) throw new Error("el plan B no declaró referencia");

    const resolved = resolveBaselineReference(await readDesignIndex(moved, WS), reference, PLAN_B);
    if (!resolved.ok) throw new Error(resolved.failure.message);
    expect(resolved.value.hint).toBe("stale");
    expect(resolved.value.revision).toBe(1);
  });
});

describe("la doctrina de cada flow dice lo que el flow hace ahora", () => {
  it("spec-new registra la necesidad y NO crea package (T9.1)", async () => {
    const text = await flat("commands/spec-new.md");
    expect(text).toMatch(/creates \*\*no design package\*\*/);
    expect(text).toMatch(/writes no `## Design references`/);
    // El esqueleto del refinado tiene que nombrar la sección nueva, no la vieja.
    expect(text).toMatch(/inserts before `Open questions`\*\* `## Design references`/);
    expect(text).not.toMatch(/`## UI spec` is authored in `spec-refine`/);
  });

  it("spec-refine compone `design` y deja solo la referencia (T9.2)", async () => {
    const composes = await section("loops/spec-refine-loop/LOOP.md", "## Composes");
    expect(composes).toMatch(/composed \*\*`design`\*\* capability/);
    expect(composes).toMatch(/reuse a compatible baseline or open an `outline` revision/);
    expect(composes).toMatch(/leave in the spec \*\*only\*\* its `## Design references`/);
    expect(composes).not.toMatch(/\bui-spec\b/);

    // El esquema del entregable es lo que un agente copia: ahí no puede quedar
    // la sección retirada.
    const schema = await section(
      "loops/spec-refine-loop/LOOP.md",
      "## Deliverable schema (the spec, edited in place)",
    );
    expect(schema).toMatch(/## Design references/);
    expect(schema).not.toMatch(/## UI spec/);
  });

  it("plan-new promueve la clausura y fija raíces (T9.3)", async () => {
    const text = await flat("loops/plan-new-loop/LOOP.md");
    expect(text).toMatch(/promote the closure, pin the roots/);
    expect(text).toMatch(/modules\/DESIGN-REFERENCES\.md/);
    // Y su gate de coherencia lo comprueba, en vez de comprobar el SPEC viejo.
    expect(text).toMatch(/every screen\/UI task pins an exact root/);
    expect(text).not.toMatch(/traces to its design SPEC/);
  });

  it("plan-refine acota al delta y no reapunta a otros consumidores (T9.4)", async () => {
    const delta = await section(
      "modules/DESIGN-REFERENCES.md",
      "## plan-refine — the delta, and only the delta",
    );
    expect(delta).toMatch(/New revisions only for the artifacts the refine actually affects/);
    expect(delta).toMatch(/\*\*Never re-point another consumer\.\*\*/);
    expect(delta).toMatch(/\*\*Re-point only this plan\*\*/);
    expect(delta).toMatch(/Behavior or acceptance changed → `spec-refine` first/);
  });

  it("el módulo dice que el plan declara sus propios baselines (T9.3)", async () => {
    // Sin esta sección en el plan, `resolveTaskReference` no tiene hint y la
    // raíz de la tarea no resuelve — es la mitad silenciosa del contrato.
    const carries = await section(
      "modules/DESIGN-REFERENCES.md",
      "## PLAN — promote the closure, pin the roots",
    );
    expect(carries).toMatch(/The plan declares its own `## Design references`/);
    expect(carries).toMatch(/after `## Dependencies`, before `## Tasks`/);
    expect(await flat("loops/plan-new-loop/LOOP.md")).toMatch(
      /## Design references\s+the baselines this plan's roots pin/,
    );
  });
});

describe("el camino legacy quedó retirado, sin alias que lo reactive (F11)", () => {
  /** The four files the retired path owned. F11 deletes them; nothing replaces them. */
  const DELETED = [
    "roles/ui-spec/ROLE.md",
    "artifacts/artifacts-design/SPEC.md",
    "modules/PLAN-DESIGN-SPECS.md",
    "modules/PLAN-REFINE-DESIGN-SPECS.md",
  ];

  it("los cuatro archivos del camino retirado ya no están en el bundle", async () => {
    const live = new Set(await everyDoctrineFile());
    expect(DELETED.filter((rel) => live.has(rel))).toEqual([]);
  });

  it("y nada apunta a ellos: un enlace muerto es peor que una lápida", async () => {
    const offenders: string[] = [];
    for (const rel of await everyDoctrineFile()) {
      const text = await readRel(rel);
      for (const gone of ["ui-spec/ROLE.md", "artifacts-design", "DESIGN-SPECS.md"]) {
        if (text.includes(gone)) offenders.push(`${rel} → ${gone}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ninguna superficie viva manda producir un design SPEC por pantalla", async () => {
    const instructs = (text: string): boolean =>
      /(?:invoke|invokes|author|authors|produce|produces)[^.]{0,80}design SPEC/i.test(
        text.replace(/\s+/g, " "),
      );

    // El detector no es vacuo: dispara sobre la instrucción que el camino viejo
    // llevaba. Sin esta mitad, una guarda cuyo patrón no casa con nada pasa por
    // el motivo equivocado — y los archivos que la disparaban ya no existen.
    expect(
      instructs("The loop invokes the capability and it authors one design SPEC per screen"),
    ).toBe(true);

    const offenders: string[] = [];
    for (const rel of await everyDoctrineFile()) {
      if (instructs(await readRel(rel))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("los nombres retirados solo aparecen para ser rechazados, nunca como implementación", async () => {
    const offenders: string[] = [];
    for (const rel of await everyDoctrineFile()) {
      const text = await flat(rel);
      if (!/\bui-(design|spec)\b/.test(text)) continue;
      // Nombrarlos es legítimo SOLO en la frase que los retira. Cualquier otra
      // mención es un alias de hecho.
      const rejects = /(retired|rejected|retirada|no alias|not aliases|is not a role)/i.test(text);
      if (!rejects) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("el role de diseño no reaparece en el catálogo de la CLI", async () => {
    expect(SKILL_ROLES as readonly string[]).not.toContain("ui-design");
    expect(Object.keys(BUILTIN_DEFAULT_SKILLS)).not.toContain("ui-design");
    expect([...RETIRED_SKILL_IDENTITIES.keys()].sort()).toEqual(["ui-design", "ui-spec"]);
  });
});

describe("la frontera docs/ admite el package sin volverse un export (T9.2/T9.3)", () => {
  it("el chasis lo declara y dice por qué no es lo mismo que exportar", async () => {
    const boundary = await section(
      "loops/CHASSIS.md",
      "## docs/ boundary — no auto-export (hard rule)",
    );
    expect(boundary).toMatch(/UI Design Package\*\* under `docs\/designs`/);
    // La distinción ES la regla: publicar no es graduar, y lo que decide es el
    // origen del artefacto, no la carpeta donde cae.
    expect(boundary).toMatch(/\*\*Published, never graduated\*\*/);
    expect(boundary).toMatch(/the test is the origin, not the folder/);
    // La regla de export sigue viva: la enmienda añade, no la afloja.
    expect(boundary).toMatch(/No loop \*\*graduates\/promotes artifacts\*\* into `docs\/`/);
  });

  it("y los tres loops que lo escriben lo dicen en su propio `## Writes`", async () => {
    for (const rel of [
      "loops/spec-refine-loop/LOOP.md",
      "loops/plan-new-loop/LOOP.md",
      "loops/plan-refine-loop/LOOP.md",
    ]) {
      const writes = await section(rel, "## Writes");
      expect(writes, rel).toMatch(/docs\/designs/);
      // Escribir el package no aflojó la regla: todo lo demás sigue siendo export.
      expect(writes, rel).toMatch(
        /never graduates\/exports anything else to `docs\/` — that is separate `export-\*` work/,
      );
    }
  });
});

describe("el MANIFEST entrega los módulos nuevos y solo bajo su señal (T9.5)", () => {
  interface Manifest {
    signals: Record<string, string>;
    commands: Record<string, { modules: Array<{ path: string; signal: string }> }>;
  }
  const manifest = async (): Promise<Manifest> =>
    JSON.parse(await readRel("context/MANIFEST.json")) as Manifest;

  it("cada comando que compone `design` declara su módulo bajo `ui`", async () => {
    const commands = (await manifest()).commands;
    for (const [command, module] of [
      ["spec-refine", "modules/DESIGN-REFERENCES.md"],
      ["plan-new", "modules/DESIGN-REFERENCES.md"],
      ["plan-refine", "modules/DESIGN-REFERENCES.md"],
      // F10: los dos consumidores nuevos — plan-exec para su gate, quick para leer.
      ["plan-exec", "modules/DESIGN-REFERENCES.md"],
      ["quick", "modules/DESIGN-REFERENCES.md"],
    ] as const) {
      const entry = commands[command]?.modules.find((m) => m.path === module);
      expect(entry, `${command} → ${module}`).toBeDefined();
      expect(entry?.signal).toBe("ui");
    }
  });

  it("`ui` ya no entrega ninguna lápida: un módulo que dice «no me sigas» no se carga", async () => {
    const commands = (await manifest()).commands;
    const tombstones = Object.entries(commands).flatMap(([command, entry]) =>
      entry.modules
        .filter((m) => /DESIGN-SPECS\.md$/.test(m.path))
        .map((m) => `${command} → ${m.path}`),
    );
    expect(tombstones).toEqual([]);
  });

  it("no inventa una señal: `ui` ya significaba exactamente este caso", async () => {
    const parsed = await manifest();
    expect(parsed.signals.ui).toBe("the run produces or changes a user interface");
    const design = Object.values(parsed.commands).flatMap((c) =>
      c.modules.filter((m) => m.path.includes("DESIGN")),
    );
    expect(design.length).toBeGreaterThan(0);
    expect([...new Set(design.map((m) => m.signal))]).toEqual(["ui"]);
  });

  it("y los módulos nuevos no viajan en el `core` de ningún comando", async () => {
    const raw = JSON.parse(await readRel("context/MANIFEST.json")) as {
      commands: Record<string, { core: string[] }>;
    };
    for (const [command, entry] of Object.entries(raw.commands)) {
      expect(
        entry.core.filter((p) => p.includes("DESIGN")),
        command,
      ).toEqual([]);
    }
  });
});

describe("la doctrina de F10: fallar cerrado, avisar, y no rediseñar", () => {
  it("el gate de plan-exec enumera las cuatro causas de bloqueo y la de aviso (T10.1)", async () => {
    const gate = await section(
      "loops/plan-exec-loop/LOOP.md",
      "## Design precondition gate (fail-closed, per task)",
    );
    for (const cause of [
      /does not resolve/,
      /digest no longer matches/,
      /\*\*revoked\*\*/,
      /does not reach `handoff`/,
    ]) {
      expect(gate, String(cause)).toMatch(cause);
    }
    expect(gate).toMatch(/names the artifact and the corrective action/);
    expect(gate).toMatch(/One cause only warns.*superseded/);
    expect(gate).toMatch(/stays executable/);
    expect(gate).toMatch(/`plan-exec` never redesigns/);
    expect(gate).toMatch(/aw designs --plan/);
  });

  it("y manda la corrección al refine que la posee, nunca a la implementación", async () => {
    const gate = await section(
      "loops/plan-exec-loop/LOOP.md",
      "## Design precondition gate (fail-closed, per task)",
    );
    expect(gate).toMatch(/\/w:plan-refine/);
    expect(gate).toMatch(/\/w:spec-refine.*behavior or acceptance/);
  });

  it("guardar documento y revisión es UNA transición, y lo no transaccional se declara (T10.4)", async () => {
    const gate = await section(
      "loops/plan-exec-loop/LOOP.md",
      "## Design precondition gate (fail-closed, per task)",
    );
    expect(gate).toMatch(/same\*\* all-or-nothing batch/);
    expect(gate).toMatch(/pending\s+reconciliation/);
    expect(gate).toMatch(/never reported as published/);
  });

  it("plan-exec dejó de decir que lee design SPECs de sesión (residuo de F9)", async () => {
    const text = await flat("loops/plan-exec-loop/LOOP.md");
    expect(text).not.toMatch(/design SPECs/);
    expect(text).not.toMatch(/artifacts-design/);
    expect(text).toMatch(/UI Design Package/);
    const command = await flat("commands/plan-exec.md");
    expect(command).not.toMatch(/PLAN-DESIGN-SPECS/);
    expect(command).toMatch(/modules\/DESIGN-REFERENCES\.md/);
  });

  it("quick lee y valida, y escalar es la única salida si cambiaría el package (T10.3)", async () => {
    const rule = await section(
      "modules/DESIGN-REFERENCES.md",
      "## quick — read it, never rewrite it",
    );
    expect(rule).toMatch(/\*\*reads and validates\*\*/);
    expect(rule).toMatch(/aw designs/);
    expect(rule).toMatch(/escalates with the\s+evidence it gathered/);
    expect(rule).toMatch(/`plan-refine` for the package/);
    expect(rule).toMatch(/`spec-refine` when behavior\s+or acceptance moves/);
  });

  it("y su comando distingue leer de escribir en docs/, que es lo que sí puede hacer", async () => {
    const text = await flat("commands/quick.md");
    expect(text).toMatch(/It never writes `docs\/`/);
    expect(text).toMatch(/may READ a design package/);
    // La frase vieja prohibía leer sin querer: si vuelve, la contradicción vuelve.
    expect(text).not.toMatch(/It never touches `docs\/`/);
  });

  it("persist encamina a SPEC primero y no publica una Screen Specification (T10.5)", async () => {
    const text = await flat("modules/PERSIST-ROUTING.md");
    expect(text).toMatch(/\*\*Durable UI idea\*\*/);
    expect(text).toMatch(/`spec` \*\*first\*\*/);
    expect(text).toMatch(/never a Screen Specification \*instead of\* the Requirement/);
    expect(text).toMatch(/`persist` writes no package/);
  });
});

describe("una raíz que el plan no declaró no resuelve", () => {
  it("fijar un baseline ausente de `## Design references` falla nombrando la acción", async () => {
    const doc = `${referenceBlock(2, DIGEST_R2)}\n- [ ] T1.1 — DES-002@r1 / SCR-001@r1`;
    const roots = parseTaskDesignReferences(doc, PLAN_A);
    const root = roots.references[0];
    if (root === undefined) throw new Error("no se parseó la raíz");

    const declared = parseSpecDesignReferences(doc, PLAN_A).references;
    const resolved = resolveTaskReference(
      await readDesignIndex(workspace(), WS),
      root,
      declared,
      PLAN_A,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.failure.action).toContain("## Design references");
  });
});
