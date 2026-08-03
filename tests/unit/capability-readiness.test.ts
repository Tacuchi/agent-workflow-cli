import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import { capabilityReadiness } from "../../src/application/capability/readiness.js";
import type { CapabilityReadinessReport } from "../../src/application/capability/readiness.js";
import { CAPABILITY_SKILL_MARKER } from "../../src/application/capability/wrapper.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const HOME = "/home/u";
const WORKSPACE = "/work";
const CLAUDE_SKILLS = join(HOME, ".claude", "skills");

const paths = new PathsService(normalizeNamespace("workflow"), HOME, WORKSPACE);
const env = new FakeEnv(HOME, WORKSPACE);

async function readiness(fs: MemFs, host = "claude-code"): Promise<CapabilityReadinessReport> {
  const reports = await capabilityReadiness({ fs, env, paths, host });
  return reports.find((r) => r.capability === "design") as CapabilityReadinessReport;
}

/** Our own wrapper, recognizable by its ownership marker. */
function withWrapper(fs: MemFs): MemFs {
  return fs.file(
    join(CLAUDE_SKILLS, "design", "SKILL.md"),
    `---\nname: design\ndescription: x\n---\n\n> ${CAPABILITY_SKILL_MARKER}.\n`,
  );
}

function skillsToml(binding: string): string {
  return `[skills]\ndesign = "${binding}"\n`;
}

describe("discovery dice qué se puede invocar y en qué estado", () => {
  it("con el wrapper instalado y sin mejoras: ready sobre el floor, ambas rutas", async () => {
    const report = await readiness(withWrapper(new MemFs()));
    expect(report.state).toBe("ready");
    expect(report.floor).toMatchObject({ builtin: true, kind: "core", running: true });
    expect(report.instance).toBeNull();
    expect(report.exposures.direct.state).toBe("ready");
    expect(report.exposures.compose.state).toBe("ready");
    expect(report.operations.map((o) => o.operation)).toEqual([
      "create",
      "update",
      "validate",
      "render",
      "record",
    ]);
  });

  it("sin wrapper instalado, la ruta DIRECTA queda unavailable y compose sigue en pie", async () => {
    const report = await readiness(new MemFs());
    expect(report.exposures.direct.state).toBe("unavailable");
    expect(report.exposures.direct.reason).toContain("wrapper");
    expect(report.exposures.direct.action).toContain("aw self install-skill");
    // Lo que importa: no oculta que compose conserva el floor.
    expect(report.exposures.compose.state).toBe("ready");
    expect(report.floor.running).toBe(true);
  });

  it("una skill extranjera con el nombre deja direct misconfigured y compose intacto", async () => {
    const fs = new MemFs().file(
      join(CLAUDE_SKILLS, "design", "SKILL.md"),
      "---\nname: design\ndescription: skill ajena\n---\najeno\n",
    );
    const report = await readiness(fs);
    expect(report.exposures.direct.state).toBe("misconfigured");
    expect(report.exposures.direct.reason).toContain("no instalamos nosotros");
    expect(report.exposures.direct.action).toContain("reinstalá");
    expect(report.exposures.compose.state).toBe("ready");
  });

  it("con `off`, cuatro operaciones quedan disabled y validate sigue viva", async () => {
    const fs = withWrapper(new MemFs()).file(paths.cwdSkillsToml(), skillsToml("off"));
    const report = await readiness(fs);
    expect(report.state).toBe("disabled");
    const blocked = report.operations.filter((o) => o.state === "disabled").map((o) => o.operation);
    expect(blocked.sort()).toEqual(["create", "record", "render", "update"]);
    const validate = report.operations.find((o) => o.operation === "validate");
    expect(validate?.state).not.toBe("disabled");
    for (const op of report.operations) {
      if (op.state !== "disabled") continue;
      expect(op.reason, op.operation).not.toBeNull();
    }
  });

  it("un binding de reemplazo se reporta degradado con evidencia y acción", async () => {
    const fs = withWrapper(new MemFs()).file(paths.cwdSkillsToml(), skillsToml("acme-design-lab"));
    const report = await readiness(fs);
    expect(report.state).toBe("degraded");
    expect(report.reason).toContain("acme-design-lab");
    expect(report.action).toContain("design");
    expect(report.floor.running).toBe(true);
  });

  it("ningún estado se reporta sin razón ni próxima acción", async () => {
    const fs = withWrapper(new MemFs()).file(paths.cwdSkillsToml(), skillsToml("acme-design-lab"));
    const report = await readiness(fs);
    expect(report.reason).not.toBeNull();
    expect(report.action).not.toBeNull();
  });
});

describe("la sintaxis anunciada es la que el host soporta", () => {
  it("un host sin slash command muestra su forma real, no una inventada", async () => {
    const report = await readiness(withWrapper(new MemFs()), "claude-code");
    expect(report.invocation.kind).toBe("mention");
    expect(report.invocation.form).toBe("design");
    expect(report.invocation.form).not.toBe("/design");
    expect(report.invocation.note.length).toBeGreaterThan(0);
  });

  it("el host con forma tipada verificada la muestra sustituida", async () => {
    const report = await readiness(withWrapper(new MemFs()), "kimi");
    expect(report.invocation.kind).toBe("slash");
    expect(report.invocation.form).toBe("/skill:design");
  });

  it("un host que no está en el catálogo dice 'no disponible' en vez de inventar", async () => {
    const report = await readiness(withWrapper(new MemFs()), "unknown");
    expect(report.invocation.kind).toBe("unavailable");
    expect(report.invocation.form).toBeNull();
    expect(report.exposures.direct.state).toBe("unavailable");
  });
});

describe("no se agregó otra superficie de discovery", () => {
  it("`aw status` no ganó readiness ni catálogo de capacidades", () => {
    const status = ALL_COMMANDS.find((c) => c.name === "status");
    expect(status).toBeDefined();
    expect(status?.describe ?? "").not.toMatch(/readiness|capabilit|capacidad/i);
  });

  it("la readiness vive en `aw skills` y en ninguna otra superficie nueva", () => {
    const carriers = ALL_COMMANDS.filter((c) => /readiness/i.test(c.describe ?? ""));
    expect(carriers.map((c) => c.name)).toEqual(["skills"]);
  });
});

describe("el presupuesto de doctrina declara la activación directa sin reclasificarla", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../skills/w/context/MANIFEST.json", import.meta.url)),
      "utf8",
    ),
  );

  it("design se declara como CAPACIDAD, nunca entre los comandos", () => {
    expect(Object.keys(manifest.capabilities)).toContain("design");
    expect(Object.keys(manifest.commands)).not.toContain("design");
  });

  // Meterla en `commands` la habría reclasificado como el comando single-pass
  // que el contrato dice que no es — y habría roto el guard que empareja cada
  // `commands/<x>.md` con su entrada.
  it("y por eso no necesita un commands/design.md", () => {
    const docs = readdirSync(fileURLToPath(new URL("../../skills/w/commands", import.meta.url)));
    expect(docs).not.toContain("design.md");
  });

  it("su read-set es el contrato de invocación y nada más", () => {
    expect(manifest.capabilities.design.core).toEqual(["roles/design/CONTRACT.md"]);
    expect(manifest.capabilities.design.modules).toEqual([]);
  });

  it("los cinco flows que componen ya declaran el módulo de diseño bajo la señal ui", () => {
    for (const flow of ["spec-refine", "plan-new", "plan-refine", "plan-exec", "quick"]) {
      const ui = manifest.commands[flow].modules.filter(
        (m: { path: string; signal: string }) => m.signal === "ui",
      );
      expect(
        ui.map((m: { path: string }) => m.path),
        flow,
      ).toContain("modules/DESIGN-REFERENCES.md");
    }
  });
});
