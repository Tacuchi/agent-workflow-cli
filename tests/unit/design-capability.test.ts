import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import "../../src/application/capability/design-handler.js";
import {
  type DispatchContext,
  type DispatchResult,
  dispatchCapability,
} from "../../src/application/capability/dispatcher.js";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { resolveSkills } from "../../src/application/skills-resolver-service.js";
import { skillsCommand } from "../../src/cli/commands/skills.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { validateDesignArtifact } from "../../src/domain/design/artifact.js";
import { validateDesignBaseline } from "../../src/domain/design/baseline.js";
import {
  CANONICAL_SCHEMAS,
  DESIGN_CAPABILITY,
  DESIGN_OPERATIONS,
} from "../../src/domain/design/capability.js";
import {
  validateDesignReview,
  validateDesignRevocation,
} from "../../src/domain/design/governance.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import {
  BUILTIN_DEFAULT_SKILLS,
  RETIRED_SKILL_IDENTITIES,
  SKILL_ROLES,
} from "../../src/domain/skills.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");
const readRel = (rel: string): Promise<string> => readFile(join(SKILL_ROOT, rel), "utf8");

/**
 * The prose with its line wrapping collapsed.
 *
 * Doctrine is hard-wrapped at 80 columns, so any claim long enough to matter
 * spans a newline. Matching the raw text pins the WRAPPING, not the rule: a
 * reflow would fail a guard that has nothing to do with reflowing.
 */
const flat = async (rel: string): Promise<string> => (await readRel(rel)).replace(/\s+/g, " ");

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

describe("hay exactamente UNA identidad pública de la capacidad (AC-CAP-01)", () => {
  it("el catálogo de roles tiene 'design' y no tiene 'ui-design'", () => {
    expect(SKILL_ROLES).toContain("design");
    expect(SKILL_ROLES).not.toContain("ui-design");
    expect(DESIGN_CAPABILITY).toBe("design");
  });

  it("y su implementación por defecto ya no es 'ui-spec'", () => {
    expect(BUILTIN_DEFAULT_SKILLS.design).toBe("design");
    expect(Object.values(BUILTIN_DEFAULT_SKILLS)).not.toContain("ui-spec");
  });

  it("el built-in por defecto existe en el bundle: el floor no depende de nadie (AC-CAP-03)", async () => {
    const role = await readRel(join("roles", BUILTIN_DEFAULT_SKILLS.design, "ROLE.md"));
    expect(role).toContain("name: design");
  });
});

describe("un nombre retirado no es un nombre aceptado (AC-CAP-01)", () => {
  let home: string;
  let cwd: string;
  let paths: PathsService;
  const fs = new NodeFileSystem();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cap-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cap-cwd-"));
    paths = new PathsService(normalizeNamespace("workflow"), home, cwd);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function bind(toml: string): void {
    mkdirSync(join(cwd, ".workflow"), { recursive: true });
    writeFileSync(paths.cwdSkillsToml(), toml);
  }

  it("'design = \"ui-spec\"' se RECHAZA y el role queda en su default", async () => {
    bind('[skills]\ndesign = "ui-spec"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    // Honrarlo lo convertiría en un alias: es exactamente lo que el contrato prohíbe.
    expect(skills.design.skill).toBe("design");
    expect(skills.design.source).toBe("default");
    expect(warnings.join(" ")).toContain("retirado");
  });

  it("y el rechazo NO apaga la capacidad: el floor sigue vivo (AC-CAP-03)", async () => {
    bind('[skills]\ndesign = "ui-spec"\n');
    const { skills } = await resolveSkills(fs, paths);
    expect(skills.design.enabled).toBe(true);
  });

  it("cambiarle las mayúsculas no lo cuela: se compara igual que 'off'", async () => {
    // Dos reglas de comparación en la misma función es una costura por donde
    // pasa el nombre entero.
    bind('[skills]\ndesign = "UI-Spec"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(skills.design.skill).toBe("design");
    expect(warnings.join(" ")).toContain("retirado");
  });

  it("el aviso NO promete un default: la cascada puede haber bindeado el role", async () => {
    // Global bindea legítimamente; workspace nombra lo retirado. Se ignora la
    // LÍNEA, así que lo vigente sigue siendo lo del global — no el built-in.
    mkdirSync(join(home, ".workflow"), { recursive: true });
    writeFileSync(paths.userSkillsToml(), '[skills]\ndesign = "acme/figma-spec"\n');
    bind('[skills]\ndesign = "ui-spec"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(skills.design.skill).toBe("acme/figma-spec");
    expect(warnings.join(" ")).toContain("Se ignora la línea");
    expect(warnings.join(" ")).not.toContain("Queda en");
  });

  it("'ui-design = ...' se ignora diciendo adónde se mudó, no como clave desconocida", async () => {
    bind('[skills]\nui-design = "acme/figma-spec"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(skills.design.skill).toBe("design");
    expect(warnings.join(" ")).toContain("'design'");
    expect(warnings.join(" ")).not.toContain("unknown role");
  });

  it("una mejora externa legítima SÍ se acepta: lo retirado es el nombre, no la extensión", async () => {
    bind('[skills]\ndesign = "acme/figma-spec"\n');
    const { skills, warnings } = await resolveSkills(fs, paths);
    expect(skills.design.skill).toBe("acme/figma-spec");
    expect(warnings).toEqual([]);
  });

  it("y 'off' sigue siendo 'off': el rechazo no se come la desactivación", async () => {
    bind('[skills]\ndesign = "off"\n');
    const { skills } = await resolveSkills(fs, paths);
    expect(skills.design).toEqual({
      role: "design",
      skill: null,
      source: "workspace",
      enabled: false,
    });
  });

  it("los dos nombres retirados llevan su motivo, no un código", () => {
    expect([...RETIRED_SKILL_IDENTITIES.keys()].sort()).toEqual(["ui-design", "ui-spec"]);
    for (const reason of RETIRED_SKILL_IDENTITIES.values()) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe("ninguna superficie viva nombra 'ui-spec' como implementación (AC-CAP-01)", () => {
  /** The legacy render's own file, and the pointers that must keep reaching it. */
  const LEGACY_OWN = "roles/ui-spec/ROLE.md";

  it("nada declara un binding de 'design' a 'ui-spec'", async () => {
    const offenders: string[] = [];
    for (const rel of await everyDoctrineFile()) {
      const text = await readRel(rel);
      // `design = "ui-spec"` en cualquier ejemplo de skills.toml.
      if (/design\s*=\s*"ui-spec"/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("ni presenta 'ui-spec' como el default de un role", async () => {
    const offenders: string[] = [];
    for (const rel of await everyDoctrineFile()) {
      const text = await readRel(rel);
      if (/built-in default (?:implementation )?(?:for |of )?[`']?ui-spec/i.test(text)) {
        offenders.push(rel);
      }
      if (/default built-in[^\n|]*\bui-spec\b/i.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("y donde sigue nombrándolo, lo declara legacy en la misma superficie", async () => {
    const offenders: string[] = [];
    for (const rel of await everyDoctrineFile()) {
      const text = await readRel(rel);
      if (!/\bui-spec\b/.test(text)) continue;
      // Nombrarlo está permitido; nombrarlo sin decir que se retira, no.
      if (!/legacy|LEGACY|retir/i.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("y su archivo ya no existe: F11 lo retiró sin dejar alias", async () => {
    // F8 aseveraba el CONTENIDO de esta lápida («no implementa ningún role»).
    // F11 la borra, así que la promesa se demuestra por AUSENCIA — que es más
    // fuerte: un archivo que no está no puede volver a instruir a nadie.
    expect(await everyDoctrineFile()).not.toContain(LEGACY_OWN);
  });
});

describe("`aw skills` ya no lista 'ui-design'", () => {
  it("el comando enumera los roles vivos y ninguno es el retirado", async () => {
    const fs = new MemFs();
    const env = new FakeEnv("/home/u", "/ws");
    const ctx = {
      fs,
      env,
      paths: new PathsService("workflow", "/home/u", "/ws"),
    } as unknown as CliContext;

    const result = await skillsCommand.execute(parseArgv(["skills"]), ctx);
    const data = result.data as { skills: Record<string, { skill: string | null }> };

    expect(result.ok).toBe(true);
    expect(Object.keys(data.skills).sort()).toEqual([...SKILL_ROLES].sort());
    expect(Object.keys(data.skills)).not.toContain("ui-design");
    expect(data.skills.design?.skill).toBe("design");
  });
});

describe("las cinco operaciones caen sobre el MISMO package (AC-CAP-02)", () => {
  it("son exactamente cinco y están nombradas", () => {
    expect([...DESIGN_OPERATIONS]).toEqual(["create", "update", "validate", "render", "record"]);
  });

  it("la doctrina las declara sobre un único formato, sin «direct package»", async () => {
    const role = await readRel(join("roles", "design", "ROLE.md"));
    for (const operation of DESIGN_OPERATIONS) {
      expect(role).toContain(`\`${operation}\``);
    }

    const prose = await flat(join("roles", "design", "ROLE.md"));
    expect(prose).toMatch(/one format, one authority\*\*/);
    expect(prose).toMatch(/no «direct package»/i);
  });
});

describe("el registro canónico y los schemas publicados nombran lo mismo (AC-CAP-03)", () => {
  it("seis formatos, uno por schema en disco", async () => {
    const files = (await readdir(join(SKILL_ROOT, "schemas", "design"))).filter((f) =>
      f.endsWith(".schema.json"),
    );
    expect(files).toHaveLength(Object.keys(CANONICAL_SCHEMAS).length);
  });

  it("y cada schema publicado fija exactamente el id que el registro declara", async () => {
    const declared = new Set<string>(Object.values(CANONICAL_SCHEMAS));
    const published = new Set<string>();
    for (const file of await readdir(join(SKILL_ROOT, "schemas", "design"))) {
      if (!file.endsWith(".schema.json")) continue;
      const raw = JSON.parse(await readFile(join(SKILL_ROOT, "schemas", "design", file), "utf8"));
      const schema = raw.properties?.schema?.const;
      expect(schema, `${file} no fija su id con un const`).toBeTypeOf("string");
      published.add(schema as string);
    }
    expect([...published].sort()).toEqual([...declared].sort());
  });
});

describe("un formato paralelo se rechaza, no se tolera (AC-CAP-02)", () => {
  /** A document that declares a schema of its own — the failure mode being closed. */
  const PARALLEL = "workline.direct-design-package/v1";

  it("una screen que declara su propio schema no valida", () => {
    const result = validateDesignArtifact(
      `---\nschema: ${PARALLEL}\nid: DES-001/SCR-001\n---\n\n## Purpose and context\n\nalgo\n`,
      "screen",
      "paralelo.md",
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("DESIGN_SCHEMA_UNKNOWN");
    expect(result.failures[0]?.action).toContain(CANONICAL_SCHEMAS.screen);
  });

  it("y tampoco un flow, un manifest, un baseline, un review ni una revocación", () => {
    const cases = [
      {
        name: "flow",
        run: () => validateDesignArtifact(`---\nschema: ${PARALLEL}\n---\n`, "flow", "f.md"),
      },
      { name: "manifest", run: () => validateDesignManifest({ schema: PARALLEL }, "m.json") },
      { name: "baseline", run: () => validateDesignBaseline({ schema: PARALLEL }, "b.json") },
      { name: "review", run: () => validateDesignReview({ schema: PARALLEL }, "r.json") },
      { name: "revocation", run: () => validateDesignRevocation({ schema: PARALLEL }, "v.json") },
    ];
    for (const { name, run } of cases) {
      const result = run();
      expect(result.ok, `${name} aceptó un formato paralelo`).toBe(false);
      expect(
        result.failures.some((f) => f.code === "DESIGN_SCHEMA_UNKNOWN"),
        `${name} no lo rechazó por schema`,
      ).toBe(true);
    }
  });

  it("nadie escribe ni lee un id canónico a mano: todos salen del registro", async () => {
    // Los cuatro LECTORES y, sobre todo, el único ESCRITOR. Que el escritor
    // faltara aquí no era una laguna teórica: la puerta de cierre de esta fase
    // dejó un `/v9` en `sealBaseline`, la publicación entera se cayó y este
    // guard siguió verde. Y el sufijo va suelto (`/v\d+`) porque anclarlo a la
    // versión vigente dejaba pasar justamente ese caso.
    const files = [
      resolve(__dirname, "..", "..", "src", "domain", "design", "artifact.ts"),
      resolve(__dirname, "..", "..", "src", "domain", "design", "baseline.ts"),
      resolve(__dirname, "..", "..", "src", "domain", "design", "manifest.ts"),
      resolve(__dirname, "..", "..", "src", "domain", "design", "governance.ts"),
      resolve(__dirname, "..", "..", "src", "application", "design", "design-publish-service.ts"),
    ];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, `${file} escribe un id canónico como literal`).not.toMatch(
        /"workline\.(?:design-|ui-)[a-z]+\/v\d+"/,
      );
    }
  });
});

describe("la frontera con la Spec 014 está escrita y no duplicada (AC-CAP-04)", () => {
  /**
   * ONE `##` section, flattened — not the whole document.
   *
   * Asserting over the whole file is what let two mutations survive: `off`
   * lives in the §Role boilerplate every ROLE.md shares, and `validate` is a
   * row of the Operations table. Both claims held with their own section
   * gutted, which is the exact «a word that would be there even if the
   * behavior were the opposite» failure.
   */
  const section = async (rel: string, heading: string): Promise<string> => {
    const body = await readRel(rel);
    const from = body.indexOf(`## ${heading}`);
    expect(from, `no existe la sección '## ${heading}'`).toBeGreaterThan(-1);
    const rest = body.slice(from + heading.length);
    const to = rest.indexOf("\n## ");
    return (to === -1 ? rest : rest.slice(0, to)).replace(/\s+/g, " ");
  };
  const ROLE = join("roles", "design", "ROLE.md");

  it("la doctrina nombra lo que pertenece a la 014 y lo que añade este contrato", async () => {
    const frontera = await section(ROLE, "Boundary with Spec 014");
    for (const owned of ["lifecycle", "routing", "`off`", "receipt", "host-native"]) {
      expect(frontera, `la frontera no nombra ${owned}`).toContain(owned);
    }
    expect(frontera).toMatch(/adds \*\*only\*\* what is proper to the design domain/i);
  });

  it("y el reparto CLI↔agente dice quién escribe (T8.5)", async () => {
    const reparto = await section(ROLE, "CLI ↔ agent split");
    for (const stage of ["prepare", "validate", "apply"]) {
      expect(reparto, `el handshake no nombra ${stage}`).toContain(`\`${stage}\``);
    }
    expect(reparto).toMatch(/only thing that touches the filesystem/i);
    expect(reparto).toMatch(/data to be validated\*?, never an instruction to be trusted/i);
  });
});

describe("la ruta package deriva y sella como la simple", () => {
  const HOME = "/home/u";
  const WS = "/work";
  /** What create mints over an empty index: DES-001, and its folder from the title. */
  const FOLDER = "docs/designs/001-design-alta-de-miembro";
  const EXPANSION = "design.independent-outcomes";
  const FLOW_PATH_R1 = `${FOLDER}/flows/FLW-001-r001-alta-miembro.md`;
  const FLOW_PATH_R2 = `${FOLDER}/flows/FLW-001-r002-alta-miembro.md`;

  const fixture = (name: string): string =>
    readFileSync(resolve(__dirname, "..", "fixtures", "design", name), "utf8");

  // The fixture publishes FLW-001@r2; a create renumbers it r1 superseding no
  // one, exactly as `design-publish.test.ts` does for a package's first line.
  const FLOW_R1 = fixture("FLW-001-r002-alta-miembro.md")
    .replace("revision: 2", "revision: 1")
    .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null");
  const FLOW_R2 = fixture("FLW-001-r002-alta-miembro.md");

  function ctx(fs: MemFs): DispatchContext {
    return {
      fs,
      env: new FakeEnv(HOME, WS),
      paths: new PathsService(normalizeNamespace("workflow"), HOME, WS),
      workspace: WS,
      host: "claude-code",
    };
  }

  const input = (name: string, value: unknown): CapabilityInputValue => ({
    name,
    value,
    provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
  });

  const createInputs = (): CapabilityInputValue[] => [
    input("title", "Alta de miembro"),
    input("sources", ["docs/requisitos.md"]),
    input("expansion", EXPANSION),
  ];

  const updateInputs = (base: string): CapabilityInputValue[] => [
    input("package", "DES-001"),
    input("base", base),
    input("expansion", EXPANSION),
  ];

  /**
   * The `input_digest` an authored answer has to carry, recomputed from the
   * inputs rather than read back from the attempt — same discipline as the
   * simple route's tests.
   */
  function digestOfInputs(inputs: CapabilityInputValue[]): string {
    return semanticDigest(
      [...inputs]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((i) => ({ name: i.name, value: i.value })),
    );
  }

  function answer(
    inputs: CapabilityInputValue[],
    operation: string,
    artifacts: Array<{ path: string; content: string }>,
  ): string {
    return JSON.stringify({
      version: 1,
      operation,
      input_digest: digestOfInputs(inputs),
      state: "proposed",
      artifacts,
    });
  }

  async function validateWith(
    fs: MemFs,
    operation: string,
    inputs: CapabilityInputValue[],
    artifacts: Array<{ path: string; content: string }>,
  ): Promise<DispatchResult> {
    return dispatchCapability(
      {
        verb: "validate",
        capability: "design",
        operation,
        route: "direct",
        inputs,
        answer: answer(inputs, `design.${operation}`, artifacts),
      },
      ctx(fs),
    );
  }

  async function applyValidated(
    fs: MemFs,
    validated: DispatchResult,
    operation: string,
  ): Promise<DispatchResult> {
    if (!validated.ok) throw new Error("validate falló antes de apply");
    const plan = validated.attempt.plan;
    if (plan === null) throw new Error("validate no produjo plan");
    return dispatchCapability(
      {
        verb: "apply",
        capability: "design",
        operation,
        route: "direct",
        request: validated.attempt.request,
        plan,
        approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
      },
      ctx(fs),
    );
  }

  /** A package with its r1 published, as the update scenarios start from. */
  async function publishCreate(fs: MemFs): Promise<void> {
    const inputs = createInputs();
    const validated = await validateWith(fs, "create", inputs, [
      { path: FLOW_PATH_R1, content: FLOW_R1 },
    ]);
    const applied = await applyValidated(fs, validated, "create");
    if (!applied.ok || applied.attempt.receipt.outcome !== "completed") {
      throw new Error("el create de partida no aplicó");
    }
  }

  /** Nothing under `docs/` — the lock the mechanism writes is not the package. */
  const docWrites = (fs: MemFs): string[] =>
    [...fs.writes.keys()].filter((p) => p.includes("/docs/"));

  it("create prepare → validate → apply deja un package íntegro, sellado por el CLI", async () => {
    const fs = new MemFs();
    const inputs = createInputs();

    const prepared = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "create", route: "direct", inputs },
      ctx(fs),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.outcome).toBe("needs_input");
    const gaps = prepared.attempt.receipt.gaps.join("\n");
    // El contrato ya fija el id y la carpeta, y dice qué NO se autora.
    expect(gaps).toContain("DES-001");
    expect(gaps).toContain(FOLDER);
    expect(gaps).toContain("design-manifest.json");
    expect(gaps).toContain(`input_digest: ${digestOfInputs(inputs)}`);

    const validated = await validateWith(fs, "create", inputs, [
      { path: FLOW_PATH_R1, content: FLOW_R1 },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.attempt.plan).not.toBeNull();
    // Nada escrito todavía: el manifest y el baseline llegan con el apply.
    expect(docWrites(fs)).toEqual([]);
    expect(validated.attempt.output?.completeness).toBe("partial");
    const fields = (
      validated.attempt.output?.value as {
        design: { package: string | null; path: string | null; baseline: unknown };
      }
    ).design;
    expect(fields.package).toBe("DES-001");
    expect(fields.path).toBe(FOLDER);
    expect(fields.baseline).toEqual({ revision: 1, digest: expect.any(String) });

    const applied = await applyValidated(fs, validated, "create");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");

    // El índice lo lee íntegro — la ruta verbatim dejaba el árbol sin sellar.
    const index = await readDesignIndex(fs, WS);
    const entry = index.packages.find((p) => p.id === "DES-001");
    expect(entry?.ok).toBe(true);
    expect(entry?.mode).toBe("package");
    expect(entry?.current_baseline?.revision).toBe(1);

    // Y el baseline lo escribió el CLI: la respuesta no traía ni manifest ni baseline.
    const baseline = validateDesignBaseline(
      JSON.parse(await fs.readText(`${WS}/${FOLDER}/baselines/DES-001-r001.json`)),
      "baselines/DES-001-r001.json",
    );
    expect(baseline.failures).toEqual([]);
    expect(baseline.value?.digest).toBe(entry?.current_baseline?.digest);
    expect(baseline.value?.selection.map((s) => s.path)).toEqual([
      "flows/FLW-001-r001-alta-miembro.md",
    ]);
    const manifest = validateDesignManifest(
      JSON.parse(await fs.readText(`${WS}/${FOLDER}/design-manifest.json`)),
      "design-manifest.json",
    );
    expect(manifest.failures).toEqual([]);
  });

  it("un documento que viola el gate sale blocked en validate y no se escribe nada", async () => {
    const fs = new MemFs();
    const inputs = createInputs();
    // Claves de SCREEN en el trace de un flow: el contrato del documento las cierra.
    const broken = FLOW_R1.replace(
      "    source: docs/specs/046-spec-nacimiento-familias.md",
      [
        "    source: docs/specs/046-spec-nacimiento-familias.md",
        "    classification: visual",
        "    states: [default]",
        "    renditions: [DES-001/VIS-001@r1]",
        "    reason: null",
      ].join("\n"),
    );

    const validated = await validateWith(fs, "create", inputs, [
      { path: FLOW_PATH_R1, content: broken },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.attempt.receipt.outcome).toBe("blocked");
    expect(validated.attempt.receipt.error?.code).toBe("DESIGN_KEY_UNKNOWN");
    expect(validated.attempt.plan).toBeNull();
    expect(docWrites(fs)).toEqual([]);
  });

  it.each(["design-manifest.json", "baselines/DES-001-r001.json", "PACKAGE.md"])(
    "autorar '%s' a mano sale blocked: lo deriva y sella el CLI",
    async (derived) => {
      const fs = new MemFs();
      const inputs = createInputs();
      const validated = await validateWith(fs, "create", inputs, [
        { path: FLOW_PATH_R1, content: FLOW_R1 },
        { path: `${FOLDER}/${derived}`, content: "{}\n" },
      ]);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      expect(validated.attempt.receipt.outcome).toBe("blocked");
      expect(validated.attempt.receipt.error?.code).toBe("DESIGN_FIELD_INVALID");
      expect(validated.attempt.receipt.error?.action).toContain("deriva y sella");
      expect(docWrites(fs)).toEqual([]);
    },
  );

  it("update con la base vigente publica r2 con su parent_baseline", async () => {
    const fs = new MemFs();
    await publishCreate(fs);

    const inputs = updateInputs("DES-001@r1");
    const prepared = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "update", route: "direct", inputs },
      ctx(fs),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.outcome).toBe("needs_input");

    const validated = await validateWith(fs, "update", inputs, [
      { path: FLOW_PATH_R2, content: FLOW_R2 },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.attempt.plan).not.toBeNull();

    const applied = await applyValidated(fs, validated, "update");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");

    const baseline = validateDesignBaseline(
      JSON.parse(await fs.readText(`${WS}/${FOLDER}/baselines/DES-001-r002.json`)),
      "baselines/DES-001-r002.json",
    );
    expect(baseline.failures).toEqual([]);
    expect(baseline.value?.revision).toBe(2);
    expect(baseline.value?.parent_baseline).toBe("DES-001@r1");

    const index = await readDesignIndex(fs, WS);
    const entry = index.packages.find((p) => p.id === "DES-001");
    expect(entry?.ok).toBe(true);
    expect(entry?.current_baseline?.revision).toBe(2);
  });

  it("y una base que no es la vigente frena el update antes de pedir contenido", async () => {
    const fs = new MemFs();
    await publishCreate(fs);
    const antes = docWrites(fs);

    const prepared = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "update",
        route: "direct",
        inputs: updateInputs("DES-001@r9"),
      },
      ctx(fs),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.outcome).toBe("blocked");
    expect(prepared.attempt.receipt.error?.code).toBe("DESIGN_BASE_STALE");
    expect(docWrites(fs)).toEqual(antes);
  });
});
