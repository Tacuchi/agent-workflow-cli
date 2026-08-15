import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gatePlanDesign } from "../../src/application/design/design-gate-service.js";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import { resolveBaselineReference } from "../../src/application/design/design-resolver-service.js";
import { type DesignBaseline, computeBaselineDigest } from "../../src/domain/design/baseline.js";
import { computeRecordDigest, judgeExecution } from "../../src/domain/design/governance.js";
import type { GovernanceRecord } from "../../src/domain/design/governance.js";
import { type DesignManifest, validateDesignManifest } from "../../src/domain/design/manifest.js";
import { parseSpecDesignReferences } from "../../src/domain/design/reference.js";
import { RETIRED_CODE, reportRetiredDesign } from "../../src/domain/design/retired.js";
import { packageCandidate } from "../helpers/design-package.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The contract's regression suite (T11.5/T11.6).
 *
 * The phases each proved their own piece. This file asserts the nine invariants
 * the CONTRACT makes, at the contract's altitude, so a later change that keeps
 * every unit test green and still breaks the promise gets caught here. Two rules
 * hold throughout: every rejection names the artifact AND the corrective action,
 * and no rejection is allowed to read, convert or promote a retired format.
 */

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";
const PLAN = "docs/plans/012-plan-alta.md";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

type Json = Record<string, unknown>;

const raw = (patch: (m: Json) => void = () => {}): Json => {
  const m = JSON.parse(fixture("manifest-maximal.json")) as Json;
  patch(m);
  return m;
};

/** Every rejection owes the same two things, whatever produced it. */
function expectActionable(
  failures: ReadonlyArray<{ code: string; artifact: string; message: string; action: string }>,
): void {
  expect(failures.length).toBeGreaterThan(0);
  for (const failure of failures) {
    expect(failure.artifact.length, failure.code).toBeGreaterThan(0);
    expect(failure.message.length, failure.code).toBeGreaterThan(0);
    expect(failure.action.length, failure.code).toBeGreaterThan(0);
  }
}

describe("cobertura del validador — ocho causas, cada una con artefacto y acción (T11.5)", () => {
  it("1. versión de formato desconocida", () => {
    const result = validateDesignManifest(
      raw((m) => {
        m.schema = "workline.design-manifest/v99";
      }),
      `${PKG}/design-manifest.json`,
    );
    expect(result.ok).toBe(false);
    expectActionable(result.failures);
  });

  it("2. IDs duplicados en el catálogo", () => {
    const result = validateDesignManifest(
      raw((m) => {
        const catalog = m.catalog as Record<string, Json[]>;
        catalog.screens = [catalog.screens[0] as Json, catalog.screens[0] as Json];
      }),
      `${PKG}/design-manifest.json`,
    );
    expect(result.ok).toBe(false);
    expectActionable(result.failures);
  });

  it("3. identidad duplicada entre dos packages", async () => {
    const fs = new MemFs()
      .file(`${WS}/${PKG}/design-manifest.json`, fixture("manifest-maximal.json"))
      .file(
        `${WS}/docs/designs/002-design-copia/design-manifest.json`,
        fixture("manifest-maximal.json"),
      );
    const index = await readDesignIndex(fs, WS);
    expectActionable(index.failures);
    expect(index.failures[0]?.code).toBe("DESIGN_ID_DUPLICATE");
  });

  it("4. path insegura al publicar", async () => {
    const fs = new MemFs().file(
      `${WS}/${PKG}/design-manifest.json`,
      fixture("manifest-maximal.json"),
    );
    const result = await packageCandidate(fs, WS, {
      packagePath: PKG,
      files: [{ path: "../../fuera.md", content: "x" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.code).toBe("DESIGN_PATH_UNSAFE");
    expectActionable(result.failures);
  });

  it("5. archivo ausente que el manifest dice que existe", async () => {
    // El manifest valida y su baseline NO está en disco: resolver debe cerrarse.
    const fs = new MemFs().file(
      `${WS}/${PKG}/design-manifest.json`,
      fixture("manifest-maximal.json"),
    );
    const report = await gatePlanDesign(fs, WS, PLAN);
    expect(report.blocked).toBe(true);
    expectActionable(report.failures);
  });

  it("6. relación rota: la tarea fija un baseline que el plan no declaró", async () => {
    const fs = workspace().file(
      `${WS}/${PLAN}`,
      "# Plan\n\n## Tasks\n\n- [ ] T1.1 — algo · DES-001@r2 / SCR-001@r1\n",
    );
    const report = await gatePlanDesign(fs, WS, PLAN);
    expect(report.blocked).toBe(true);
    const failures = report.verdicts.flatMap((v) => v.failures);
    expectActionable(failures);
    expect(failures[0]?.action).toContain("Design references");
  });

  it("7. revisión inválida: una referencia aproximada nunca resuelve", () => {
    const parsed = parseSpecDesignReferences(
      [
        "## Design references",
        "",
        "- package: `DES-001@latest`",
        "  baseline_hint: `x`",
        "  digest: `y`",
      ].join("\n"),
      PLAN,
    );
    expect(parsed.references).toEqual([]);
    expectActionable(parsed.failures);
  });

  it("8. digest stale: la revisión existe y sus bytes no son los fijados", async () => {
    const fs = workspace();
    const index = await readDesignIndex(fs, WS);
    const reference = {
      baseline: { package: "DES-001", revision: 2 },
      baseline_hint: `${PKG}/baselines/DES-001-r002.json`,
      digest: `sha256:${"9".repeat(64)}`,
    };
    const resolved = resolveBaselineReference(index, reference, PLAN);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.failure.code).toBe("DESIGN_REFERENCE_DIGEST_MISMATCH");
    expectActionable([resolved.failure]);
  });

  it("9. requisitos de handoff incompletos", async () => {
    const fs = workspace({
      manifest: JSON.stringify(
        raw((m) => {
          const catalog = m.catalog as Record<string, Json[]>;
          (catalog.screens[0] as Json).maturity = "outline";
        }),
        null,
        2,
      ),
    });
    const report = await gatePlanDesign(fs, WS, PLAN);
    const failures = report.verdicts.flatMap((v) => v.failures);
    expect(failures[0]?.code).toBe("DESIGN_HANDOFF_INCOMPLETE");
    expectActionable(failures);
  });
});

/** The package as F10's gate needs it: manifest, baseline, screen and a plan. */
function workspace(options: { manifest?: string; plan?: string } = {}): MemFs {
  return new MemFs()
    .file(`${WS}/${PKG}/design-manifest.json`, options.manifest ?? fixture("manifest-maximal.json"))
    .file(`${WS}/${PKG}/baselines/DES-001-r001.json`, "{}")
    .file(`${WS}/${PKG}/baselines/DES-001-r002.json`, fixture("baseline-DES-001-r002.json"))
    .file(
      `${WS}/${PKG}/screens/SCR-001-r001-formulario-alta.md`,
      fixture("SCR-001-r002-formulario-alta.md")
        .replace("revision: 2", "revision: 1")
        .replace("supersedes: DES-001/SCR-001@r1", "supersedes: null"),
    )
    .file(
      `${WS}/${PLAN}`,
      options.plan ??
        [
          "# Plan",
          "",
          "## Design references",
          "",
          "- package: `DES-001@r2`",
          `  baseline_hint: \`${PKG}/baselines/DES-001-r002.json\``,
          `  digest: \`${D2}\``,
          "",
          "## Tasks",
          "",
          "### F1 — el alta",
          "",
          "- [ ] T1.1 — implementar · DES-001@r2 / SCR-001@r1#default",
          "",
        ].join("\n"),
    );
}

describe("regresión del contrato — las nueve promesas (T11.6)", () => {
  const manifest = (): DesignManifest => {
    const result = validateDesignManifest(raw());
    if (!result.ok || result.value === null) throw new Error("el fixture no valida");
    return result.value;
  };

  const record = (patch: Partial<GovernanceRecord>, from: string): GovernanceRecord => {
    const base = { ...(JSON.parse(fixture(from)) as GovernanceRecord), ...patch };
    return { ...base, digest: computeRecordDigest(base) };
  };

  it("1. el digest de un baseline no se autorreferencia ni depende del índice mutable", () => {
    const baseline = JSON.parse(fixture("baseline-DES-001-r002.json")) as DesignBaseline;
    const { digest, ...unsealed } = baseline;

    // Sin autorreferencia: el digest publicado ES el de su propio contenido
    // calculado SIN el campo `digest`. Si el campo entrara en su propia entrada,
    // esta igualdad sería imposible de sostener.
    expect(computeBaselineDigest(unsealed)).toBe(digest);

    // Y la selección sellada enumera SOLO archivos normativos: el índice mutable,
    // los records de gobierno y las proyecciones quedan fuera por construcción,
    // que es lo que hace que tocar el catálogo no altere una revisión publicada.
    const sealed = baseline.selection.map((entry) => entry.path).join(" ");
    expect(sealed.length).toBeGreaterThan(0);
    for (const excluded of ["design-manifest.json", "governance/", "PACKAGE.md", "DESIGN.md"]) {
      expect(sealed, excluded).not.toContain(excluded);
    }
  });

  it("2. un package mixto es legítimo: madurez por revisión, no por dossier", () => {
    const maturities = manifest().catalog.flows.map((f) => f.maturity);
    expect(new Set(maturities).size).toBeGreaterThan(1);
  });

  it("3. preservación histórica: publicar r2 deja r1 catalogada e intacta", () => {
    const revisions = manifest().catalog.flows.filter((f) => f.id === "FLW-001");
    expect(revisions.map((r) => r.revision).sort()).toEqual([1, 2]);
    expect(manifest().baselines.map((b) => b.revision)).toEqual([1, 2]);
  });

  it("4. un review vive FUERA del baseline que decide y se sella a sí mismo", () => {
    const review = JSON.parse(fixture("REV-001-approved.json")) as GovernanceRecord;
    const { digest, ...unsealed } = review;
    expect(computeRecordDigest(unsealed as GovernanceRecord)).toBe(digest);
    const indexed = manifest().governance.reviews[0];
    expect(indexed?.path).toMatch(/^governance\/reviews\//);
    expect(manifest().baselines.some((b) => b.path.includes("governance"))).toBe(false);
  });

  it("5. superseded avisa y sigue ejecutable", () => {
    const verdict = judgeExecution(manifest(), "DES-001@r1", [], { requireApproval: false });
    expect(verdict.executable).toBe(true);
    expect(verdict.notices.join(" ")).toMatch(/superseded/);
  });

  it("6. revoked bloquea, y es la única prohibición", () => {
    const revocation = record({ target: "DES-001@r1", target_digest: D1 }, "RVK-001-bloqueo.json");
    const verdict = judgeExecution(manifest(), "DES-001@r1", [revocation], {
      requireApproval: false,
    });
    expect(verdict.executable).toBe(false);
    expect(verdict.failures[0]?.code).toBe("DESIGN_REVISION_REVOKED");
    expectActionable(verdict.failures);
  });

  it("7. la política de aprobación mueve el veredicto y NADA más", () => {
    const before = JSON.stringify(manifest());
    const sin = judgeExecution(manifest(), "DES-001@r2", [], { requireApproval: false });
    const con = judgeExecution(manifest(), "DES-001@r2", [], { requireApproval: true });
    expect(sin.executable).toBe(true);
    expect(con.executable).toBe(false);
    expect(con.failures[0]?.code).toBe("DESIGN_APPROVAL_MISSING");
    // Ninguna de las dos corridas tocó madurez, currentness ni catálogo.
    expect(JSON.stringify(manifest())).toBe(before);
  });

  it("8. un path hint viejo conserva la validez y se reporta como stale", async () => {
    const fs = new MemFs()
      .file(
        `${WS}/docs/designs/042-renombrado/design-manifest.json`,
        fixture("manifest-maximal.json"),
      )
      .file(`${WS}/docs/designs/042-renombrado/baselines/DES-001-r002.json`, "{}");
    const index = await readDesignIndex(fs, WS);
    const resolved = resolveBaselineReference(
      index,
      {
        baseline: { package: "DES-001", revision: 2 },
        baseline_hint: `${PKG}/baselines/DES-001-r002.json`,
        digest: D2,
      },
      PLAN,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.hint).toBe("stale");
    expect(resolved.value.package_path).toBe("docs/designs/042-renombrado");
  });

  it("9. un formato legacy se rechaza SIN leerlo, convertirlo ni promoverlo a evidencia", async () => {
    const legacy = "# Spec\n\n## UI spec\n\n### Pantalla alta\n\nRegiones: header, form\n";
    const reported = reportRetiredDesign(legacy, "docs/specs/013-spec.md");
    expect(reported[0]?.code).toBe(RETIRED_CODE);
    expectActionable(reported);
    // «Sin leerlo» es literal: el diagnóstico no cita el contenido de la sección.
    expect(reported[0]?.message).not.toContain("header");
    // «Sin conversión»: la acción manda RECREAR, nunca importar ni migrar.
    expect(reported[0]?.action).toMatch(/recreá/i);
    expect(reported[0]?.action).toMatch(/no hay importador/i);

    // Y no satisface el gate: presentarlo en un plan lo bloquea.
    const fs = workspace({ plan: legacy });
    const report = await gatePlanDesign(fs, WS, PLAN);
    expect(report.blocked).toBe(true);
    expect(report.failures.some((f) => f.code === RETIRED_CODE)).toBe(true);
  });

  it("y el rechazo no toca el archivo: retirar un input no es borrar un registro", async () => {
    const legacy = "# Spec\n\n## UI spec\n\ncontenido histórico\n";
    const fs = workspace({ plan: legacy });
    await gatePlanDesign(fs, WS, PLAN);
    expect(await fs.readText(`${WS}/${PLAN}`)).toBe(legacy);
    expect(fs.writes.size).toBe(0);
  });
});
