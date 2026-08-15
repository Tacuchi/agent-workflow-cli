import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import type { DispatchContext } from "../../src/application/capability/dispatcher.js";
import { dispatchCapability } from "../../src/application/capability/dispatcher.js";
import type { ConsumerDocument } from "../../src/application/design/consumer-document.js";
import { gatePlanDesign } from "../../src/application/design/design-gate-service.js";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import {
  buildSimpleProposal,
  resolveSimpleTarget,
} from "../../src/application/design/design-simple-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import {
  DESIGN_EXPANSION_SIGNALS,
  EXPANSION_THRESHOLD,
  deriveStructuralSignals,
  judgeExpansion,
} from "../../src/domain/design/expansion.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import { parseTaskDesignReferences } from "../../src/domain/design/reference.js";
import { designSlug, nextPackageId, validateSimpleDesign } from "../../src/domain/design/simple.js";
import type { DesignSource } from "../../src/domain/design/sources.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const HOME = "/home/u";
const WS = "/work";

function context(fs: MemFs, workspace: string | null = WS): DispatchContext {
  return {
    fs,
    env: new FakeEnv(HOME, WS),
    paths: new PathsService(normalizeNamespace("workflow"), HOME, WS),
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

const DOCUMENT = [
  "# Alta de miembro",
  "",
  "## Objetivo",
  "",
  "Que una persona registre a un familiar sin salir de la pantalla de inicio.",
  "",
  "## Diseño propuesto",
  "",
  "Un formulario embebido con nombre, vínculo y fecha.",
  "",
  "## Validación",
  "",
  "Se considera resuelto cuando el alta aparece en el listado sin recargar.",
  "",
].join("\n");

const NO_FACTS = {
  sensitiveSources: false,
  externalTransmission: false,
  sources: [],
  governanceRecords: 0,
  publishedRevisions: 0,
};

describe("T4.1 · el vocabulario de expansión es cerrado y su umbral es del CLI", () => {
  it("sin ninguna señal la ruta es simple", () => {
    const verdict = judgeExpansion([], deriveStructuralSignals(NO_FACTS));
    expect(verdict.mode).toBe("simple");
    expect(verdict.fired).toEqual([]);
    expect(verdict.cause).toBeNull();
  });

  it("una sola señal semántica basta y queda registrada con su causa", () => {
    const verdict = judgeExpansion(
      ["design.independent-outcomes"],
      deriveStructuralSignals(NO_FACTS),
    );
    expect(verdict.mode).toBe("package");
    expect(verdict.fired.map((s) => s.id)).toEqual(["design.independent-outcomes"]);
    expect(verdict.cause).toContain("design.independent-outcomes");
    expect(EXPANSION_THRESHOLD).toBe(1);
  });

  it("una señal fuera del vocabulario no expande nada y se devuelve rechazada", () => {
    const verdict = judgeExpansion(["design.me-parece"], deriveStructuralSignals(NO_FACTS));
    expect(verdict.mode).toBe("simple");
    expect(verdict.rejected[0]?.id).toBe("design.me-parece");
  });

  it("una señal estructural declarada por el agente se rechaza: la deriva el CLI", () => {
    const verdict = judgeExpansion(
      ["design.special-source-or-effect"],
      deriveStructuralSignals(NO_FACTS),
    );
    expect(verdict.mode).toBe("simple");
    expect(verdict.rejected[0]?.why).toContain("lo deriva el CLI");
  });

  it("el CLI deriva la fuente especial de una fuente que no llegó a usarse", () => {
    const fired = deriveStructuralSignals({
      ...NO_FACTS,
      sources: [source({ disposition: "unavailable", reason: "no se pudo leer" })],
    });
    expect(fired).toEqual(["design.special-source-or-effect"]);
    expect(judgeExpansion([], fired).mode).toBe("package");
  });

  it("el CLI deriva gobierno o reutilización de un package con decisiones selladas", () => {
    expect(deriveStructuralSignals({ ...NO_FACTS, governanceRecords: 1 })).toEqual([
      "design.governance-or-system-reuse",
    ]);
    expect(deriveStructuralSignals({ ...NO_FACTS, publishedRevisions: 2 })).toEqual([
      "design.governance-or-system-reuse",
    ]);
  });

  it("cada señal declara su origen y ninguna repite id", () => {
    const ids = DESIGN_EXPANSION_SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      DESIGN_EXPANSION_SIGNALS.filter((s) => s.origin === "structural").map((s) => s.id),
    ).toEqual(["design.governance-or-system-reuse", "design.special-source-or-effect"]);
  });
});

describe("T4.2 · DESIGN.md es todo lo que una persona escribe", () => {
  it("las tres secciones núcleo alcanzan", () => {
    const parsed = validateSimpleDesign(DOCUMENT, "DESIGN.md");
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.title).toBe("Alta de miembro");
  });

  it("falta una sección núcleo → falla nombrándola", () => {
    const parsed = validateSimpleDesign(DOCUMENT.replace("## Validación", "## Otro"), "DESIGN.md");
    expect(parsed.ok).toBe(false);
    expect(parsed.failures.map((f) => f.message).join(" ")).toContain("Validación");
  });

  it("una sección opcional vacía se rechaza en vez de tolerarse", () => {
    const parsed = validateSimpleDesign(`${DOCUMENT}\n## Abiertos\n\n`, "DESIGN.md");
    expect(parsed.ok).toBe(false);
    expect(parsed.failures[0]?.message).toContain("Abiertos");
  });

  it("una sección fuera del vocabulario dice que el diseño ya no es simple", () => {
    const parsed = validateSimpleDesign(`${DOCUMENT}\n## Arquitectura\n\ntexto\n`, "DESIGN.md");
    expect(parsed.ok).toBe(false);
    expect(parsed.failures[0]?.action).toContain("ya no es simple");
  });

  it("el slug pliega acentos en vez de comerse la letra", () => {
    expect(designSlug("Validación de la ficha")).toBe("validacion-de-la-ficha");
  });

  it("el id siguiente sale del más alto publicado", () => {
    expect(nextPackageId(["DES-001", null, "DES-007"])).toBe("DES-008");
    expect(nextPackageId([])).toBe("DES-001");
  });

  it("el manifest derivado valida y no cataloga nada", async () => {
    const fs = new MemFs({ lenient: true });
    const index = await readDesignIndex(fs, WS);
    const target = resolveSimpleTarget(index, "create", {
      title: "Alta de miembro",
      packageId: null,
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const built = await buildSimpleProposal(fs, WS, {
      target: target.value,
      document: DOCUMENT,
      published: "2026-08-09",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.artifacts.map((a) => a.path)).toEqual([
      "docs/designs/001-design-alta-de-miembro/DESIGN.md",
      "docs/designs/001-design-alta-de-miembro/design-manifest.json",
    ]);
    const manifest = built.value.artifacts[1] as { content: string };
    const validated = validateDesignManifest(JSON.parse(manifest.content));
    expect(validated.failures).toEqual([]);
    expect(validated.value?.mode).toBe("simple");
    expect(validated.value?.current_baseline?.digest).toBe(built.value.digest);
  });

  it("un manifest simple que cataloga artefactos se rechaza", () => {
    const validated = validateDesignManifest({
      schema: "workline.design-manifest/v1",
      id: "DES-001",
      mode: "simple",
      title: "x",
      created: "2026-08-09",
      derived_from: null,
      current_baseline: null,
      baselines: [],
      catalog: {
        flows: [
          {
            id: "FLW-001",
            revision: 1,
            path: "flows/FLW-001-r001-a.md",
            supersedes: null,
            maturity: "outline",
          },
        ],
        screens: [],
        rules: [],
        tokens: [],
        renditions: [],
        assets: [],
      },
      currentness: [],
      governance: { reviews: [], revocations: [] },
      relations: { specs: [], plans: [] },
    });
    expect(validated.ok).toBe(false);
    expect(validated.failures.map((f) => f.message).join(" ")).toContain("modo 'simple'");
  });

  it("un manifest sin 'mode' se lee como package: nada histórico se migra", () => {
    const validated = validateDesignManifest({
      schema: "workline.design-manifest/v1",
      id: "DES-001",
      title: "x",
      created: "2026-08-09",
      derived_from: null,
      current_baseline: null,
      baselines: [],
      catalog: {
        flows: [],
        screens: [],
        rules: [],
        tokens: [],
        renditions: [],
        assets: [],
      },
      currentness: [],
      governance: { reviews: [], revocations: [] },
      relations: { specs: [], plans: [] },
    });
    expect(validated.ok).toBe(true);
    expect(validated.value?.mode).toBe("package");
  });
});

/** A published simple design on disk: the two files and nothing else. */
async function published(fs: MemFs, document = DOCUMENT): Promise<MemFs> {
  const index = await readDesignIndex(fs, WS);
  const target = resolveSimpleTarget(index, "create", {
    title: "Alta de miembro",
    packageId: null,
  });
  if (!target.ok) throw new Error("no resolvió el destino");
  const built = await buildSimpleProposal(fs, WS, {
    target: target.value,
    document,
    published: "2026-08-09",
  });
  if (!built.ok) throw new Error(built.failures[0]?.message);
  for (const artifact of built.value.artifacts) fs.file(`${WS}/${artifact.path}`, artifact.content);
  return fs;
}

describe("T4.3 · el índice, los resolvers y el gate consumen el diseño simple por su raíz", () => {
  it("el índice reporta el modo de cada package", async () => {
    const fs = await published(new MemFs({ lenient: true }));
    const index = await readDesignIndex(fs, WS);
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0]?.mode).toBe("simple");
    expect(index.packages[0]?.id).toBe("DES-001");
  });

  it("una referencia de tarea puede ser la raíz sola", () => {
    const parsed = parseTaskDesignReferences("- [ ] T1.1 — implementar DES-001@r1", "plan.md");
    expect(parsed.failures).toEqual([]);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.artifact).toBeNull();
  });

  it("la raíz declarada en '## Design references' sigue siendo declaración, no consumo", () => {
    const parsed = parseTaskDesignReferences(
      ["## Design references", "", "package: DES-001@r1", "", "## Tasks", "", "sin diseño"].join(
        "\n",
      ),
      "plan.md",
    );
    expect(parsed.references).toEqual([]);
    expect(parsed.failures).toEqual([]);
  });

  it("una raíz mal escrita se reporta, no se ignora", () => {
    const parsed = parseTaskDesignReferences("- [ ] T1.1 — implementar DES-0001@r1", "plan.md");
    expect(parsed.references).toEqual([]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.code).toBe("DESIGN_REFERENCE_APPROXIMATE");
  });

  it("la forma de dos partes sigue leyéndose entera", () => {
    const parsed = parseTaskDesignReferences("T1.1 — DES-001@r4 / SCR-002@r2#empty", "plan.md");
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.artifact?.artifact).toBe("SCR-002");
  });

  it("el gate de plan-exec aprueba una raíz sin exigir clausura ni handoff", async () => {
    const fs = await published(new MemFs({ lenient: true }));
    const digest = (await readDesignIndex(fs, WS)).packages[0]?.current_baseline?.digest as string;
    fs.file(
      `${WS}/docs/plans/001-plan-x.md`,
      [
        "# Plan 001",
        "",
        "## Design references",
        "",
        "package: DES-001@r1",
        "baseline_hint: docs/designs/001-design-alta-de-miembro/DESIGN.md",
        `digest: ${digest}`,
        "",
        "## Tasks",
        "",
        "### F1 — alta",
        "- [ ] T1.1 — implementar DES-001@r1",
        "",
      ].join("\n"),
    );

    const report = await gatePlanDesign(fs, WS, "docs/plans/001-plan-x.md");
    expect(report.failures).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts[0]?.ready).toBe(true);
    // Atribuida a la TAREA, no a la línea del bloque declarado — donde el mismo
    // texto literal también aparece.
    expect(report.verdicts[0]?.owner.kind).toBe("task");
    expect(report.verdicts[0]?.owner.label).toBe("T1.1");
  });

  it("pedirle un artefacto a un diseño simple bloquea y manda a su raíz", async () => {
    const fs = await published(new MemFs({ lenient: true }));
    const digest = (await readDesignIndex(fs, WS)).packages[0]?.current_baseline?.digest as string;
    fs.file(
      `${WS}/docs/plans/002-plan-y.md`,
      [
        "# Plan 002",
        "",
        "## Design references",
        "",
        "package: DES-001@r1",
        "baseline_hint: docs/designs/001-design-alta-de-miembro/DESIGN.md",
        `digest: ${digest}`,
        "",
        "## Tasks",
        "",
        "- [ ] T1.1 — DES-001@r1 / SCR-002@r1",
        "",
      ].join("\n"),
    );

    const report = await gatePlanDesign(fs, WS, "docs/plans/002-plan-y.md");
    expect(report.blocked).toBe(true);
    const blocking = report.verdicts.flatMap((v) => v.failures);
    expect(blocking[0]?.message).toContain("no cataloga artefactos");
    expect(blocking[0]?.action).toContain("por su raíz");
  });

  it("una revisión siguiente archiva la anterior y su referencia sigue resolviendo", async () => {
    const fs = await published(new MemFs({ lenient: true }));
    const before = (await readDesignIndex(fs, WS)).packages[0]?.current_baseline?.digest as string;

    const index = await readDesignIndex(fs, WS);
    const target = resolveSimpleTarget(index, "update", { title: null, packageId: "DES-001" });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.value.revision).toBe(2);

    const built = await buildSimpleProposal(fs, WS, {
      target: target.value,
      document: DOCUMENT.replace("sin recargar", "sin recargar y con un aviso"),
      published: "2026-08-10",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const paths = built.value.artifacts.map((a) => a.path);
    expect(paths[0]).toBe("docs/designs/001-design-alta-de-miembro/revisions/DESIGN-r001.md");
    expect(built.value.base?.path).toBe(
      "docs/designs/001-design-alta-de-miembro/design-manifest.json",
    );

    for (const artifact of built.value.artifacts) {
      fs.file(`${WS}/${artifact.path}`, artifact.content);
    }
    const after = await readDesignIndex(fs, WS);
    const manifest = after.packages[0]?.manifest;
    expect(manifest?.current_baseline?.revision).toBe(2);
    // El digest de r1 no cambió: sólo se movió a dónde vive.
    const r1 = manifest?.baselines.find((b) => b.revision === 1);
    expect(r1?.digest).toBe(before);
    expect(r1?.path).toBe("revisions/DESIGN-r001.md");
  });

  it("mantiene como CAS la misma lectura de manifest desde la que derivó la revisión", async () => {
    const fs = await published(new MemFs({ lenient: true }));
    const manifestPath = `${WS}/docs/designs/001-design-alta-de-miembro/design-manifest.json`;
    const snapshot = await fs.readText(manifestPath);
    const index = await readDesignIndex(fs, WS);
    const target = resolveSimpleTarget(index, "update", { title: null, packageId: "DES-001" });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    // M2 arrives after the target captured M1. Its bytes must not become the
    // base of a candidate that still derives its manifest from M1.
    fs.file(
      manifestPath,
      JSON.stringify(
        { ...(JSON.parse(snapshot) as Record<string, unknown>), title: "Cambio concurrente" },
        null,
        2,
      ),
    );
    const built = await buildSimpleProposal(fs, WS, {
      target: target.value,
      document: DOCUMENT.replace("sin recargar", "sin recargar y con aviso"),
      published: "2026-08-10",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.base?.digest).toBe(baseDigest(snapshot));
  });

  it("un diseño simple adjunta el consumidor al final y registra su relación", async () => {
    const fs = new MemFs({ lenient: true });
    const index = await readDesignIndex(fs, WS);
    const target = resolveSimpleTarget(index, "create", {
      title: "Alta de miembro",
      packageId: null,
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const preview = await buildSimpleProposal(fs, WS, {
      target: target.value,
      document: DOCUMENT,
      published: "2026-08-10",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const consumerPath = "docs/specs/032-spec-consumidor-atomico.md";
    const consumerBefore = "# Spec 032 — anterior\n";
    fs.file(`${WS}/${consumerPath}`, consumerBefore);
    const consumerContent = [
      "# Spec 032 — consumidor atómico",
      "",
      "## Design references",
      "",
      "package: DES-001@r1",
      `baseline_hint: ${target.value.path}/DESIGN.md`,
      `digest: ${preview.value.digest}`,
      "",
      "## Scope",
      "",
      "In: el consumidor se mueve con el diseño.",
    ].join("\n");
    const consumer: ConsumerDocument = {
      kind: "spec",
      path: consumerPath,
      content: consumerContent,
      base: { path: consumerPath, digest: baseDigest(consumerBefore) },
    };

    const built = await buildSimpleProposal(fs, WS, {
      target: target.value,
      document: DOCUMENT,
      published: "2026-08-10",
      consumer_document: consumer,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const last = built.value.artifacts[built.value.artifacts.length - 1];
    expect(last?.path).toBe(consumerPath);
    const manifestArtifact = built.value.artifacts.find((artifact) =>
      artifact.path.endsWith("design-manifest.json"),
    );
    const manifest = JSON.parse(manifestArtifact?.content ?? "{}") as {
      relations: { specs: string[] };
    };
    expect(manifest.relations.specs).toEqual([consumerPath]);
  });
});

describe("T4.4 · el recorrido visible es comprender → redactar → vista previa → decidir", () => {
  it("prepare publica el contrato del documento y su único destino", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: [text("title", "Alta de miembro"), text("sources", ["docs/requisitos.md"])],
      },
      context(new MemFs({ lenient: true })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("needs_input");
    const gaps = result.attempt.receipt.gaps.join("\n");
    expect(gaps).toContain("docs/designs/001-design-alta-de-miembro/DESIGN.md");
    expect(gaps).toContain("No escribas manifest, id, revisión, digest, madurez ni referencias");
  });

  it("validate sella la propuesta completa y ofrece exactamente dos alternativas", async () => {
    const fs = new MemFs({ lenient: true });
    const inputs = [text("title", "Alta de miembro"), text("sources", ["docs/requisitos.md"])];
    const prepared = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "create", route: "direct", inputs },
      context(fs),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const answer = JSON.stringify({
      version: 1,
      operation: "design.create",
      input_digest: digestOfInputs(inputs),
      state: "proposed",
      artifacts: [{ path: "docs/designs/001-design-alta-de-miembro/DESIGN.md", content: DOCUMENT }],
    });
    const validated = await dispatchCapability(
      {
        verb: "validate",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs,
        answer,
      },
      context(fs),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const plan = validated.attempt.plan;
    expect(plan).not.toBeNull();
    expect(plan?.proposal.preview.map((p) => p.path)).toEqual([
      "docs/designs/001-design-alta-de-miembro/DESIGN.md",
      "docs/designs/001-design-alta-de-miembro/design-manifest.json",
    ]);
    const gaps = validated.attempt.receipt.gaps;
    expect(gaps.filter((g) => g.startsWith("Aprobar y guardar"))).toHaveLength(1);
    expect(gaps.filter((g) => g.startsWith("Refinar"))).toHaveLength(1);
    const fields = (validated.attempt.output?.value as { design: { route: unknown } }).design;
    expect(fields.route).toEqual({ mode: "simple", signals: [], cause: null });
  });

  it("apply escribe el documento y su manifest en un solo acto", async () => {
    const fs = new MemFs({ lenient: true });
    const inputs = [text("title", "Alta de miembro"), text("sources", ["docs/requisitos.md"])];
    const answer = JSON.stringify({
      version: 1,
      operation: "design.create",
      input_digest: digestOfInputs(inputs),
      state: "proposed",
      artifacts: [{ path: "docs/designs/001-design-alta-de-miembro/DESIGN.md", content: DOCUMENT }],
    });
    const validated = await dispatchCapability(
      {
        verb: "validate",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs,
        answer,
      },
      context(fs),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const plan = validated.attempt.plan;
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const applied = await dispatchCapability(
      {
        verb: "apply",
        capability: "design",
        operation: "create",
        route: "direct",
        request: validated.attempt.request,
        plan,
        approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
      },
      context(fs),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");
    // El lock de la publicación es del mecanismo; lo que se PUBLICA son dos.
    expect([...fs.writes.keys()].filter((p) => p.includes("/docs/")).sort()).toEqual([
      `${WS}/docs/designs/001-design-alta-de-miembro/DESIGN.md`,
      `${WS}/docs/designs/001-design-alta-de-miembro/design-manifest.json`,
    ]);
  });

  it("una señal semántica lleva la misma invocación al recorrido ampliado, con su causa", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: [
          text("title", "Alta y baja"),
          text("sources", ["docs/requisitos.md"]),
          text("expansion", "design.independent-outcomes"),
        ],
      },
      context(new MemFs({ lenient: true })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gaps = result.attempt.receipt.gaps.join("\n");
    expect(gaps).toContain("docs/designs");
    expect(gaps).not.toContain("DESIGN.md");
  });

  it("responder más de un archivo en la ruta simple se rechaza nombrando el destino", async () => {
    const fs = new MemFs({ lenient: true });
    const inputs = [text("title", "Alta de miembro"), text("sources", ["docs/requisitos.md"])];
    const answer = JSON.stringify({
      version: 1,
      operation: "design.create",
      input_digest: digestOfInputs(inputs),
      state: "proposed",
      artifacts: [
        { path: "docs/designs/001-design-alta-de-miembro/DESIGN.md", content: DOCUMENT },
        { path: "docs/designs/001-design-alta-de-miembro/otro.md", content: "x" },
      ],
    });
    const validated = await dispatchCapability(
      {
        verb: "validate",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs,
        answer,
      },
      context(fs),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.attempt.receipt.outcome).toBe("blocked");
    // El destino declarado es el archivo exacto, así que el segundo cae fuera.
    expect(validated.attempt.receipt.error?.code).toBe("SEMANTIC_PATH_REJECTED");
  });
});

/**
 * The `input_digest` an authored answer has to carry.
 *
 * Recomputed from the SAME projection `authoring()` feeds `buildSemanticRequest`
 * rather than copied out of a prepared attempt: a test that read the number back
 * from the code under test could not notice the day the seal stopped covering
 * the inputs.
 */
function digestOfInputs(inputs: CapabilityInputValue[]): string {
  // Sorted by name, because the request builder sorts before sealing: two callers
  // that named the same inputs in a different order asked for the same work.
  return semanticDigest(
    [...inputs]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((i) => ({ name: i.name, value: i.value })),
  );
}
