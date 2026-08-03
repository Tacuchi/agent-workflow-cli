import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import { dispatchCapability } from "../../src/application/capability/dispatcher.js";
import { buildCapabilityInventory } from "../../src/application/capability/installed-inventory.js";
import { PathsService } from "../../src/application/paths-service.js";
import { validateCapabilityDescriptor } from "../../src/domain/capability/descriptor.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";
import { reportRetiredDesign } from "../../src/domain/design/retired.js";
import { RETIRED_SKILL_IDENTITIES } from "../../src/domain/skills.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const RETIRED = ["ui-design", "ui-spec"] as const;
const ROOT = "/home/u/.claude/skills";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("un nombre retirado falla en toda superficie de entrada, sin fallback", () => {
  it("el catálogo de retirados es exactamente esos dos y ninguno es design", () => {
    expect([...RETIRED_SKILL_IDENTITIES.keys()].sort()).toEqual([...RETIRED].sort());
    expect(RETIRED_SKILL_IDENTITIES.has("design")).toBe(false);
  });

  it.each(RETIRED)("un descriptor publicado como '%s' se rechaza", (name) => {
    const result = validateCapabilityDescriptor({ ...DESIGN_DESCRIPTOR, name });
    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.code === "CAPABILITY_NAME_RETIRED");
    expect(failure?.action).toContain("nombre vigente");
  });

  it.each(RETIRED)("una invocación de '%s' falla con la acción de adopción", async (name) => {
    const result = await dispatchCapability(
      { verb: "prepare", capability: name, operation: "validate", route: "direct" },
      {
        fs: new MemFs(),
        env: new FakeEnv("/home/u", "/work"),
        paths: new PathsService(normalizeNamespace("workflow"), "/home/u", "/work"),
        workspace: "/work",
        host: "claude-code",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("CAPABILITY_NAME_RETIRED");
    expect(result.failure.action).toContain("design");
  });

  it.each(RETIRED)("un directorio instalado llamado '%s' queda misconfigured", async (name) => {
    const fs = new MemFs().file(
      join(ROOT, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: legacy\nmetadata:\n  workline-capability-descriptor: "c.json#sha256=${"a".repeat(64)}"\n---\n`,
    );
    const inventory = await buildCapabilityInventory(fs, new FakeEnv("/home/u", "/work"));
    const instance = inventory.capabilities.find((c) => c.name === name);
    expect(instance?.state).toBe("misconfigured");
    expect(instance?.failure?.code).toBe("CAPABILITY_NAME_RETIRED");
    // Y no resuelve en silencio a otra identidad.
    expect(instance?.descriptor).toBeNull();
  });
});

describe("el material legacy es unsupported como fuente y nadie lo lee", () => {
  it("una spec con '## UI spec' se reporta y no se convierte", () => {
    const failures = reportRetiredDesign(
      "# Spec\n\n## UI spec\n\npantalla de alta\n",
      "docs/specs/001-spec.md",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.action).toContain("no hay importador");
  });

  it("un design SPEC de sesión se reporta igual", () => {
    const failures = reportRetiredDesign("ver 003-SPEC-ALTA-MIEMBRO.md", "docs/plans/x.md");
    expect(failures).toHaveLength(1);
  });

  it("un documento vigente no dispara nada", () => {
    expect(reportRetiredDesign("# Plan\n\n## Tasks\n", "docs/plans/x.md")).toEqual([]);
  });

  // Ningún formato retirado satisface un gate: lo que devuelve son FALLAS, no
  // un contrato parseado. Si alguna vez devolviera contenido, esto lo cazaría.
  it("lo que devuelve el reporte son fallas, nunca contenido interpretado", () => {
    const failures = reportRetiredDesign("## UI spec\n", "x.md");
    for (const f of failures) {
      expect(Object.keys(f).sort()).toEqual(["action", "artifact", "code", "message"]);
    }
  });
});

describe("guard de ausencia: no entró ni alias, ni dual-read, ni importador", () => {
  /** Every `.ts` under src/, read once. */
  function sources(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (path.endsWith(".ts"))
          out.push([path.slice(repoRoot.length), readFileSync(path, "utf8")]);
      }
    };
    walk(join(repoRoot, "src"));
    return out;
  }

  // Verified by STRUCTURE, not by convention: a retired name may be MENTIONED
  // (the catalog that refuses it has to name it), but nothing may map it onto a
  // live identity. That mapping is what an alias IS.
  it("ningún módulo mapea un nombre retirado a la identidad vigente", () => {
    const offenders: string[] = [];
    for (const [path, text] of sources()) {
      for (const retired of RETIRED) {
        // `"ui-spec": "design"`, `ui_spec => design`, `alias`… any arrow from the
        // retired name to the live one.
        const alias = new RegExp(`["']${retired}["']\\s*(?::|=>|=)\\s*["']design["']`);
        if (alias.test(text)) offenders.push(`${path}: alias ${retired} → design`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no hay importador, conversor ni migración de material retirado", () => {
    const banned = [
      /function\s+import(?:Ui|Legacy|Design)\w*/,
      /function\s+convert(?:Ui|Legacy)\w*/,
      /migrateOnTouch/,
      /function\s+migrateLegacyDesign\w*/,
      /dualRead|dual_read/,
    ];
    const offenders: string[] = [];
    for (const [path, text] of sources()) {
      for (const pattern of banned) {
        if (pattern.test(text)) offenders.push(`${path}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // La retirada no destruye. Nada en el árbol borra un documento por presentar
  // material retirado — el módulo que lo reporta no escribe en absoluto.
  it("el módulo que reporta material retirado no escribe ni borra nada", () => {
    const text = readFileSync(join(repoRoot, "src/domain/design/retired.ts"), "utf8");
    expect(text).not.toMatch(/writeFile|rm\(|unlink|mkdir|fs\./);
    expect(text).toContain("Retirement is not destruction");
  });
});
