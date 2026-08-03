import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cutRenderBundle } from "../../src/application/design/design-bundle-service.js";
import { reviewProposal } from "../../src/application/design/design-proposal-service.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import { PORTABLE_HTML } from "../../src/domain/design/profiles.js";
import {
  baseSourceDigestOf,
  reconcileProposal,
  type reviewExternalProposal,
} from "../../src/domain/design/proposal.js";
import type { RenderBundle } from "../../src/domain/design/render-bundle.js";
import { MemFs } from "../helpers/mem-fs.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";
const SCREEN_PATH = "screens/SCR-001-r002-formulario-alta.md";

const digest = (text: string): string =>
  `sha256:${createHash("sha256").update(new TextEncoder().encode(text)).digest("hex")}`;

/**
 * A package whose SCR-001@r2 is the real fixture document, so a proposal is
 * compared against a revision that actually validates.
 */
function workspace(screen = fixture("SCR-001-r002-formulario-alta.md")): MemFs {
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
  manifest.catalog.screens = [
    {
      id: "SCR-001",
      revision: 2,
      path: SCREEN_PATH,
      supersedes: null,
      maturity: "handoff",
      states: ["default", "error"],
    },
  ];
  manifest.catalog.flows = [];
  manifest.currentness = [];

  const fs = new MemFs();
  fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));
  fs.file(`${WS}/${PKG}/${SCREEN_PATH}`, screen);
  fs.file(`${WS}/${PKG}/design-system/rules/RUL-001-r001-densidad.md`, "# densidad compacta\n");
  fs.file(`${WS}/${PKG}/tokens/TOK-001-r001-base.tokens.json`, '{"color":{}}\n');
  fs.file(
    `${WS}/${PKG}/renditions/VIS-001-r001-formulario-alta/rendition.json`,
    fixture("rendition-VIS-001-r001.json"),
  );
  fs.file(`${WS}/${PKG}/assets/${"5".repeat(64)}-logo.svg`, "<svg/>\n");
  return fs;
}

/** The bundle the external tool was handed. */
async function handedOut(fs: MemFs): Promise<RenderBundle> {
  const cut = await cutRenderBundle(fs, WS, {
    packageId: "DES-001",
    roots: ["DES-001/SCR-001@r2"],
    adapter: PORTABLE_HTML,
    generated: "2026-08-03",
  });
  if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
  return cut.value;
}

/** The same screen with one section rewritten, as a tool would hand it back. */
function edited(): string {
  return fixture("SCR-001-r002-formulario-alta.md").replace(
    "Una sola columna por debajo de 640 px; la barra de acciones queda fija abajo.",
    "Dos columnas desde 900 px; por debajo de 640 px una sola y la barra fija abajo.",
  );
}

describe("F7 · una propuesta se ancla a la revisión y al digest de los que salió", () => {
  it("el token de la base es el digest de la clausura que se entregó", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    expect(baseSourceDigestOf(bundle)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Recomputable desde el package tal como está: es lo que permite decir «esto ya
    // cambió» sin preguntarle a la herramienta externa.
    expect(baseSourceDigestOf(bundle)).toBe(baseSourceDigestOf(bundle));
  });

  it("muestra el delta semántico antes de cualquier escritura", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const before = await snapshot(fs);

    const result = await reviewProposal(fs, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: SCREEN_PATH, kind: "screen", content: edited() }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));

    expect(result.value.ok).toBe(true);
    expect(result.value.stale).toBeNull();
    expect(result.value.reconciliation_required).toBe(true);
    const delta = result.value.delta[0];
    expect(delta?.ref).toBe("DES-001/SCR-001@r2");
    // El cuerpo cambió y ninguna clave del frontmatter lo describe: se declara la
    // sección, no un resumen de lo que ahora dice.
    expect(delta?.prose_changed).toEqual(["Responsive and adaptation"]);
    expect(delta?.changes).toEqual([]);

    // Y nada se escribió: revisar es un informe.
    expect(await snapshot(fs)).toEqual(before);
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("nombra los campos del frontmatter que la edición movió", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const withNewState = fixture("SCR-001-r002-formulario-alta.md")
      .replace(
        "  - anchor: error\n    purpose: El documento ingresado ya pertenece a otro miembro",
        "  - anchor: error\n    purpose: El documento ingresado ya pertenece a otro miembro\n  - anchor: guardando\n    purpose: El alta está en curso",
      )
      .replace("maturity: handoff", "maturity: outline");

    const result = await reviewProposal(fs, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: SCREEN_PATH, kind: "screen", content: withNewState }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));

    const fields = (result.value.delta[0]?.changes ?? []).map((c) => c.field);
    expect(fields).toContain("states");
    expect(fields).toContain("maturity");
    const states = result.value.delta[0]?.changes.find((c) => c.field === "states");
    expect(states?.before).toBe("default, error");
    expect(states?.after).toBe("default, error, guardando");
  });
});

describe("F7 · una base obsoleta entra en conflicto y no sobrescribe nada", () => {
  // El escenario de la spec: la edición se generó desde SCR-001@r2 y, mientras la
  // hacían, el contenido de esa revisión cambió en el package.
  it("detecta el digest obsoleto, deja la revisión vigente intacta y devuelve conflicto", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);

    // El package se movió: los bytes de la revisión que el bundle entregó ya no son
    // los que entregó.
    const moved = `${fixture("SCR-001-r002-formulario-alta.md")}\n<!-- alguien publicó encima -->\n`;
    const after = workspace(moved);
    const before = await snapshot(after);

    const result = await reviewProposal(after, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: SCREEN_PATH, kind: "screen", content: edited() }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));

    expect(result.value.ok).toBe(false);
    expect(result.value.stale?.moved).toEqual(["DES-001/SCR-001@r2"]);
    expect(result.value.failures.map((f) => f.code)).toEqual(["DESIGN_BASE_STALE"]);
    // Sin delta: comparar contra una revisión que la propuesta nunca vio produce un
    // diff que no describe ni lo que se editó ni lo que el package dice.
    expect(result.value.delta).toEqual([]);
    expect(await snapshot(after)).toEqual(before);
    expect(after.writes.size).toBe(0);
  });

  it("un bundle recortado o retocado no se acepta como base", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const tampered = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    (tampered.closure as unknown[]).pop();

    const result = await reviewProposal(fs, WS, {
      packageId: "DES-001",
      base: tampered,
      documents: [{ path: SCREEN_PATH, kind: "screen", content: edited() }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_DIGEST_MISMATCH");
  });

  it("un documento que el bundle nunca entregó no entra como propuesta", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const result = await reviewProposal(fs, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: "screens/SCR-009-r001-inventada.md", kind: "screen", content: edited() }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.value.ok).toBe(false);
    expect(result.value.failures.map((f) => f.code)).toContain("DESIGN_REFERENCE_MISSING");
  });

  it("una propuesta que no valida se rechaza con el diagnóstico del documento", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const broken = fixture("SCR-001-r002-formulario-alta.md").replace("default_state: default", "");
    const result = await reviewProposal(fs, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: SCREEN_PATH, kind: "screen", content: broken }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.value.ok).toBe(false);
    expect(result.value.failures.length).toBeGreaterThan(0);
    expect(result.value.failures.every((f) => f.action.length > 0)).toBe(true);
  });
});

describe("F7 · la reconciliación explícita es la única vía a @rN+1", () => {
  async function reviewed(): Promise<ReturnType<typeof reviewExternalProposal>> {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const result = await reviewProposal(fs, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: SCREEN_PATH, kind: "screen", content: edited() }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    return result.value;
  }

  it("aceptar explícitamente produce la instrucción de autorar la revisión siguiente", async () => {
    const outcome = reconcileProposal(await reviewed(), {
      accept: ["DES-001/SCR-001@r2"],
      rationale: "el ajuste responsive vino de la sesión de diseño del 3 de agosto",
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failures));

    expect(outcome.value.expected_base).toBe("DES-001@r2");
    // Los dos ejes, separados: el package va a r3 y la screen a su propia r3.
    expect(outcome.value.target_baseline).toBe(3);
    expect(outcome.value.accepted).toEqual([
      {
        ref: "DES-001/SCR-001@r2",
        path: SCREEN_PATH,
        must_supersede: "DES-001/SCR-001@r2",
        target_revision: 3,
      },
    ]);
  });

  it("revisar no alcanza: sin aceptación explícita no hay revisión nueva", async () => {
    const outcome = reconcileProposal(await reviewed(), { accept: [], rationale: "vi el delta" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failures[0]?.code).toBe("DESIGN_RECONCILIATION_REQUIRED");
  });

  it("y sin motivo tampoco", async () => {
    const outcome = reconcileProposal(await reviewed(), {
      accept: ["DES-001/SCR-001@r2"],
      rationale: "   ",
    });
    expect(outcome.ok).toBe(false);
  });

  it("aceptar algo que la propuesta no trajo se rechaza", async () => {
    const outcome = reconcileProposal(await reviewed(), {
      accept: ["DES-001/SCR-009@r1"],
      rationale: "quiero meter otra cosa",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failures[0]?.message).toContain("SCR-009");
  });

  it("una base obsoleta no se reconcilia, se rehace", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const after = workspace(`${fixture("SCR-001-r002-formulario-alta.md")}\n<!-- movido -->\n`);
    const result = await reviewProposal(after, WS, {
      packageId: "DES-001",
      base: JSON.parse(JSON.stringify(bundle)),
      documents: [{ path: SCREEN_PATH, kind: "screen", content: edited() }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));

    const outcome = reconcileProposal(result.value, {
      accept: ["DES-001/SCR-001@r2"],
      rationale: "igual lo quiero",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failures[0]?.action).toContain("bundle nuevo");
  });
});

describe("F7 · el digest de la base es el mismo token que usa una rendition", () => {
  it("una propuesta y un snapshot que vieron lo mismo calculan lo mismo", async () => {
    const fs = workspace();
    const bundle = await handedOut(fs);
    const screen = await fs.readText(`${WS}/${PKG}/${SCREEN_PATH}`);
    const member = bundle.closure.find((m) => m.path === SCREEN_PATH);
    expect(member?.sha256).toBe(digest(screen));
  });
});

/** The tree as it stands, to prove a review wrote nothing. */
async function snapshot(fs: MemFs, dir = `${WS}/${PKG}`): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.list(dir)) {
    if (entry.type === "dir") Object.assign(out, await snapshot(fs, entry.path));
    else out[entry.path] = await fs.readText(entry.path);
  }
  return out;
}
