import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDesignGraph } from "../../src/application/design/design-graph-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runResume } from "../../src/application/resume-service.js";
import { type StatusOutput, runStatusCommand } from "../../src/application/status-service.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The traceability graph, and the atomic document transition.
 *
 * `status` and `resume` project the same graph, so the four states have to be
 * distinguishable WITHOUT opening a file — that is the whole point of moving
 * design out of the documents.
 */

const WS = "/cwd";
const NOW = new Date(2026, 7, 3, 12, 0, 0);

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const DIGEST_R2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const env = new FakeEnv("/home", WS);
const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", WS);

/** The three-line block, pointing wherever the caller says. */
function referenceBlock(hint: string, digest = DIGEST_R2): string {
  return [
    "## Design references",
    "",
    "- package: `DES-001@r2`",
    `  baseline_hint: \`${hint}\``,
    `  digest: \`${digest}\``,
    "",
  ].join("\n");
}

const REAL = "docs/designs/001-design-alta";
const MOVED = "docs/designs/042-design-altas-y-bajas";

/**
 * A workspace with one of each: a valid reference, a stale one, a missing one and
 * an orphaned package.
 */
function workspace(): MemFs {
  const fs = new MemFs();
  fs.file(`${WS}/${REAL}/design-manifest.json`, fixture("manifest-maximal.json"));
  fs.file(`${WS}/${REAL}/baselines/DES-001-r002.json`, fixture("baseline-DES-001-r002.json"));
  // A second package nobody references: orphaned. Every DES-001 inside becomes
  // DES-002 — an artifact belongs to its own package, so a half-renamed manifest
  // would simply not validate and would read as "no identity" instead.
  fs.file(
    `${WS}/docs/designs/002-design-huerfano/design-manifest.json`,
    fixture("manifest-maximal.json").replaceAll("DES-001", "DES-002"),
  );
  // valid — the hint is where the baseline really is
  fs.file(
    `${WS}/docs/specs/013-spec-ui.md`,
    `# Spec\n\n${referenceBlock(`${REAL}/baselines/DES-001-r002.json`)}\n`,
    NOW,
  );
  // stale — resolves by identity, the recorded path moved
  fs.file(
    `${WS}/docs/plans/012-plan-ui.md`,
    `# Plan\n\n${referenceBlock(`${MOVED}/baselines/DES-001-r002.json`)}\n## Tasks\n\n- [ ] T1.1 — algo · DES-001@r2 / SCR-001@r1#default\n`,
    NOW,
  );
  // missing — the digest no longer matches the bytes
  fs.file(
    `${WS}/docs/plans/013-plan-roto.md`,
    `# Plan\n\n${referenceBlock(`${REAL}/baselines/DES-001-r002.json`, `sha256:${"9".repeat(64)}`)}\n## Tasks\n\n- [ ] T1.1 — algo\n`,
    NOW,
  );
  return fs;
}

async function status(): Promise<StatusOutput> {
  return runStatusCommand(workspace(), env, paths(), { now: NOW });
}

describe("grafo de trazabilidad — los cuatro estados", () => {
  it("distingue válida, stale y missing sin abrir un archivo", async () => {
    const { designs } = await status();
    const byDoc = new Map(designs.references.map((r) => [r.from, r]));
    expect(byDoc.get("docs/specs/013-spec-ui.md")?.state).toBe("valid");
    expect(byDoc.get("docs/plans/012-plan-ui.md")?.state).toBe("stale");
    expect(byDoc.get("docs/plans/013-plan-roto.md")?.state).toBe("missing");
    expect(designs.counts).toMatchObject({ valid: 1, stale: 1, missing: 1, orphaned: 1 });
  });

  it("un stale dice a dónde apuntaba y dónde vive hoy: es reparable, no roto", async () => {
    const { designs } = await status();
    const stale = designs.references.find((r) => r.state === "stale");
    expect(stale?.detail).toContain(MOVED);
    expect(stale?.detail).toContain(REAL);
    expect(stale?.package_path).toBe(REAL);
  });

  it("un missing explica la causa con su acción, no solo que falta", async () => {
    const { designs } = await status();
    const missing = designs.references.find((r) => r.state === "missing");
    expect(missing?.detail).toContain("digest");
    expect(missing?.detail).toContain("→");
  });

  it("huérfano es el package que nadie referencia, y un stale NO deja huérfano al suyo", async () => {
    const { designs } = await status();
    const orphaned = designs.packages.filter((p) => p.state === "orphaned");
    expect(orphaned.map((p) => p.id)).toEqual(["DES-002"]);
    expect(designs.packages.find((p) => p.id === "DES-001")?.state).toBe("referenced");
  });

  it("el último salto del grafo son las raíces que la tarea fijó", async () => {
    const { designs } = await status();
    const plan = designs.references.find((r) => r.from === "docs/plans/012-plan-ui.md");
    expect(plan?.roots).toEqual(["DES-001@r2 / SCR-001@r1#default"]);
  });

  it("un workspace sin diseño devuelve el grafo vacío, no falla", async () => {
    const graph = await buildDesignGraph(new MemFs({ lenient: true }), WS, []);
    expect(graph.references).toEqual([]);
    expect(graph.packages).toEqual([]);
  });

  it("un documento ilegible no tumba el tablero entero", async () => {
    const graph = await buildDesignGraph(workspace(), WS, [
      { file: "docs/plans/no-existe.md", kind: "plan" },
      { file: "docs/specs/013-spec-ui.md", kind: "spec" },
    ]);
    expect(graph.references).toHaveLength(1);
  });
});

describe("status — el grafo es visible", () => {
  it("una referencia a reparar sale en la vista por defecto, no escondida tras --detail", async () => {
    const text =
      statusCommand.renderHuman?.(
        { ok: true, data: await status(), exitCode: 0 },
        {
          detail: false,
        },
      ) ?? "";
    expect(text).toContain("Diseño con referencias a reparar (2)");
    expect(text).toContain("[stale]");
    expect(text).toContain("[missing]");
  });

  it("--detail muestra los cuatro estados y el package huérfano", async () => {
    const text =
      statusCommand.renderHuman?.(
        { ok: true, data: await status(), exitCode: 0 },
        {
          detail: true,
        },
      ) ?? "";
    expect(text).toContain("1 válida(s), 1 stale, 1 missing, 1 huérfano(s)");
    expect(text).toContain("[orphaned]");
    expect(text).toContain("[referenced]");
    expect(text).toContain("DES-001@r2 / SCR-001@r1#default");
  });

  it("sin diseño en el workspace no imprime una sección de diseño vacía", async () => {
    const empty = await runStatusCommand(new MemFs({ lenient: true }), env, paths(), { now: NOW });
    const text =
      statusCommand.renderHuman?.({ ok: true, data: empty, exitCode: 0 }, { detail: true }) ?? "";
    expect(text).not.toContain("Diseño");
  });
});

describe("resume — un diseño irresoluble cambia el siguiente paso", () => {
  it("propone reparar la referencia antes que implementar la fase", async () => {
    const outcome = await runResume(workspace(), env, paths(), {
      target: "docs/plans/013-plan-roto.md",
      now: NOW,
    });
    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    expect(outcome.proposal.next).toContain("DISEÑO IRRESOLUBLE");
    expect(outcome.proposal.design?.[0]?.state).toBe("missing");
  });

  it("un stale se informa sin secuestrar el siguiente paso: sigue siendo válido", async () => {
    const outcome = await runResume(workspace(), env, paths(), {
      target: "docs/plans/012-plan-ui.md",
      now: NOW,
    });
    if (outcome.status !== "proposal") throw new Error("esperaba una propuesta");
    expect(outcome.proposal.design?.[0]?.state).toBe("stale");
    expect(outcome.proposal.next).not.toContain("DISEÑO IRRESOLUBLE");
  });

  it("un documento sin diseño no carga la clave design", async () => {
    const outcome = await runResume(workspace(), env, paths(), {
      target: "docs/specs/013-spec-ui.md",
      now: NOW,
    });
    if (outcome.status !== "proposal") throw new Error("esperaba una propuesta");
    expect(outcome.proposal.design).toBeUndefined();
  });
});

/**
 * HUECO CONOCIDO — «publicar el documento y la revisión es UNA transición».
 *
 * Acá vivían tres casos sobre `documents`: la spec o el plan que cita el
 * baseline viajaba en el MISMO lote todo-o-nada que la revisión, y DESPUÉS del
 * manifest, para que una referencia solo fuera visible apuntando a un baseline
 * que ya estaba. Esa capacidad la ofrecía `publishDesignRevision`, que nunca
 * tuvo un llamador en producción: se retiró con el plan 030 y la ruta viva
 * —`packageProposal`— publica únicamente archivos DEL package.
 *
 * O sea que la transición no está implementada y no lo estaba antes: lo que se
 * pierde al retirar la función es la prueba de una promesa que nadie cumplía,
 * no una regresión. Reponerla exige que la capacidad acepte el documento como
 * entrada declarada —hoy el descriptor no la tiene— y que el lote durable lo
 * lleve; hasta entonces el documento se escribe en un paso aparte y una
 * referencia colgante sigue siendo posible.
 */
