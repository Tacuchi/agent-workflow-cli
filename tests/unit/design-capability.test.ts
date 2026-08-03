import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSkills } from "../../src/application/skills-resolver-service.js";
import { skillsCommand } from "../../src/cli/commands/skills.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
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
      if (rel === LEGACY_OWN) continue;
      const text = await readRel(rel);
      if (!/\bui-spec\b/.test(text)) continue;
      // Nombrarlo está permitido; nombrarlo sin decir que se retira, no.
      if (!/legacy|LEGACY|retir/i.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("el propio archivo legacy declara que no implementa ningún role", async () => {
    const text = await readRel(LEGACY_OWN);
    expect(text).toMatch(/## Role\s*\n\s*\n\*\*None\.\*\*/);
    expect(await flat(LEGACY_OWN)).toMatch(
      /neither an alias of `design` nor an alternative implementation/,
    );
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
