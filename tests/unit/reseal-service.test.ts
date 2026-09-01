// Cerrar una divergencia de baseline sin recorrer un plan-refine entero.
//
// El digest funcional ya evita que una edición editorial vuelva divergente a un
// plan sellado HOY. Quedan dos divergencias legítimas y carísimas:
//
//   1. un plan con sello LEGADO byte-exacto, que cualquier edición de su spec
//      —una coma en `## Context` incluida— vuelve `divergent`;
//   2. un cambio funcional que el plan ya cubre tal cual, revisado por alguien.
//
// En los dos casos la única salida era `/w:plan-refine`: trece pasos, los bytes
// del plan redactados, una vista previa aprobada y una publicación, todo para que
// la publicación recalcule UNA línea. Y un plan divergente no cierra
// (`PLAN_EXEC_DONE_BASELINE_INVALID`), así que el costo no era opcional.
//
// Lo que se fija acá:
//   - `prepare` es estable y no escribe;
//   - `apply` reescribe SÓLO la línea del sello y el tablero real lo lee alineado;
//   - lo que se aprobó es lo que se escribe: un plan editado en el medio se
//     rechaza por digest y sus bytes quedan intactos;
//   - cada negativa propia es distinguible (standalone, sin cabecera, spec ausente);
//   - re-sellar dos veces es idempotente;
//   - y el caso que da sentido al lote: sello legado + edición editorial pasa de
//     `divergent` (no cerrable) a `aligned` (cerrable) tocando esa única línea.
//
// El disco es real a propósito: `applyReseal` publica con el lock del workspace,
// CAS byte-exacto y rollback, y un doble en memoria comprobaría mi imitación de
// esas tres cosas en vez de esas tres cosas.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { parsePlanBaselineSeal } from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { applyReseal, prepareReseal } from "../../src/application/reseal-service.js";
import {
  type WorklineIndex,
  buildWorklineIndex,
} from "../../src/application/workline-index-service.js";
import { specBaselineDigest } from "../../src/domain/lineage.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const SPEC_PATH = "docs/specs/040-spec-resello.md";
const PLAN_PATH = "docs/plans/041-plan-resello.md";

/** Una spec con el esqueleto de la doctrina: allowlist funcional + `## Context`. */
const SPEC = `---
status: ready-for-plan
---

# Spec 040 — el re-sello

## Origin

Sesión 152 · conversación del host.

## Context

Un sello legado divergía con cualquier edición.

## Requirement

Una divergencia legítima se cierra con un re-sello aprobado.

## Scope

La línea \`> Baseline:\` del plan y nada más.

## Acceptance criteria

- [ ] AC-01: re-sellar reescribe sólo la línea del sello.
- [ ] AC-02: lo aprobado es lo que se escribe.

## Scenarios

GIVEN un sello legado WHEN la spec recibe una coma THEN el plan queda divergente.
`;

/** La MISMA spec con una edición EDITORIAL: la coma vive en `## Context`. */
const SPEC_EDITED = SPEC.replace(
  "Un sello legado divergía con cualquier edición.",
  "Un sello legado divergía, siempre, con cualquier edición.",
);

const fs = new NodeFileSystem();
const NOW = new Date(2026, 8, 1, 12, 0, 0);

/**
 * Un FileSystemPort real que publica en el plan justo DESPUÉS de su primera
 * lectura — la ÚNICA forma de caer dentro de la ventana que sólo el CAS cubre.
 *
 * Escribir antes de llamar a `apply` no la ejercita: la re-preparación leería los
 * bytes nuevos, el digest recomputado ya no casaría y lo que frenaría la escritura
 * sería el approval (`RESEAL_APPROVAL_MISMATCH`), un paso antes. Acá la
 * publicación concurrente llega DESPUÉS de que `applyReseal` re-preparó y ANTES de
 * que `applyLocalProposal` lea la base bajo el lock, que es exactamente el hueco
 * donde `plan-exec` publica mientras alguien lee una vista previa.
 */
class PublishOnFirstRead extends NodeFileSystem {
  /** Cuántas veces se leyó el archivo vigilado: prueba que la ventana se abrió. */
  reads = 0;
  private readonly watched: string;
  private readonly publish: () => Promise<void>;

  constructor(watched: string, publish: () => Promise<void>) {
    super();
    this.watched = watched;
    this.publish = publish;
  }

  override async readText(path: string): Promise<string> {
    const text = await super.readText(path);
    if (!path.endsWith(this.watched)) return text;
    this.reads += 1;
    if (this.reads === 1) await this.publish();
    return text;
  }
}

/** El plan, con el `> Baseline:` que se le dé (o sin ninguno). */
function planDoc(baselineLine: string | null, state = "open"): string {
  const header = ["# Plan 041 — el re-sello", "", `> Derived from ${SPEC_PATH}`];
  if (baselineLine !== null) header.push(baselineLine);
  header.push(`> Estado: ${state}`, "> Límite de ejecución: checkout");
  return `${header.join("\n")}

## Origin

Spec 040.

## Tasks

### F1 — re-sellar
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — re-sellar el baseline _(fuentes: workspace)_

**Validación de fase:** pruebas locales sobre fixtures del checkout.

**Condición de salida:** el sello es el vigente.
`;
}

describe("aw reseal — cerrar una divergencia de baseline sin plan-refine", () => {
  let root: string;
  let paths: PathsService;
  let env: FakeEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-reseal-"));
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    env = new FakeEnv(root, root);
    await mkdir(join(paths.cwdSessionsDir()), { recursive: true });
    await mkdir(join(root, "docs/specs"), { recursive: true });
    await mkdir(join(root, "docs/plans"), { recursive: true });
    await writeFile(join(root, SPEC_PATH), SPEC, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(planText: string, specText: string = SPEC): Promise<void> {
    await writeFile(join(root, PLAN_PATH), planText, "utf8");
    await writeFile(join(root, SPEC_PATH), specText, "utf8");
  }

  const prepare = (target: string = PLAN_PATH) => prepareReseal(fs, env, paths, target);
  const apply = (approval: string, target: string = PLAN_PATH) =>
    applyReseal(fs, env, paths, { target, approval });

  const planOnDisk = (): Promise<string> => readFile(join(root, PLAN_PATH), "utf8");
  const board = (): Promise<WorklineIndex> => buildWorklineIndex(fs, env, paths, { now: NOW });

  /** El sello legado: el digest de los BYTES de la spec, como se sellaba antes. */
  const legacySeal = (specText: string): string =>
    `> Baseline: ${SPEC_PATH}@${specBaselineDigest(specText)}`;
  const functionalSeal = (specText: string): string =>
    `> Baseline: ${SPEC_PATH}@${functionalSpecDigest(specText)}`;

  it("prepare es estable: dos preparaciones seguidas sellan el MISMO digest", async () => {
    await seed(planDoc(legacySeal(SPEC)), SPEC_EDITED);
    const first = await prepare();
    const second = await prepare();
    if (first.status !== "prepared" || second.status !== "prepared") {
      throw new Error(`esperaba dos preparaciones: ${first.status} / ${second.status}`);
    }
    expect(second.proposal.digest).toBe(first.proposal.digest);
    expect(second.preview).toEqual(first.preview);
    // Y no escribió: el plan sigue byte-idéntico a lo sembrado.
    expect(await planOnDisk()).toBe(planDoc(legacySeal(SPEC)));
  });

  it("prepare no escribe nada, ni siquiera cuando la propuesta queda lista", async () => {
    const original = planDoc(null);
    await seed(original);
    const prepared = await prepare();
    expect(prepared.status).toBe("prepared");
    expect(await planOnDisk()).toBe(original);
  });

  it("apply reescribe SÓLO la línea del sello y el tablero lo lee alineado", async () => {
    const original = planDoc(legacySeal(SPEC));
    await seed(original, SPEC_EDITED);
    const prepared = await prepare();
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);

    const applied = await apply(prepared.proposal.digest);
    expect(applied).toMatchObject({ status: "applied", already_applied: false });

    // La diferencia es UNA línea, y es la del sello: el resto del plan es byte
    // por byte el que había. Comparado por líneas para que un cambio en
    // cualquier otra parte del documento se vea acá y no se disuelva en un
    // `toContain`.
    const after = (await planOnDisk()).split("\n");
    const before = original.split("\n");
    expect(after).toHaveLength(before.length);
    const moved = before.flatMap((line, index) => (after[index] === line ? [] : [index]));
    expect(moved).toEqual([3]);
    expect(after[3]).toBe(functionalSeal(SPEC_EDITED));

    const plan = (await board()).plans.find((candidate) => candidate.file === PLAN_PATH);
    expect(plan?.baseline).toEqual({
      status: "aligned",
      digest: functionalSpecDigest(SPEC_EDITED),
    });
  });

  it("el plan editado entre prepare y apply se rechaza por digest y NO se pisa", async () => {
    await seed(planDoc(legacySeal(SPEC)), SPEC_EDITED);
    const prepared = await prepare();
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);

    // Lo que hace `plan-exec` mientras alguien lee una vista previa: publica en
    // el mismo plan. La edición es real y no toca la línea del sello.
    const edited = planDoc(legacySeal(SPEC)).replace(
      "- [ ] T1.1 — re-sellar el baseline",
      "- [x] T1.1 — re-sellar el baseline",
    );
    await writeFile(join(root, PLAN_PATH), edited, "utf8");

    const applied = await apply(prepared.proposal.digest);
    // El código importa: es el que dice que la preparación se RE-EJECUTÓ y el
    // digest recomputado ya no coincide. Si `apply` aplicara la propuesta vieja,
    // el CAS del `applyLocalProposal` seguiría frenando la escritura, pero el
    // rechazo llegaría como `PROPOSAL_BASE_STALE` — otra garantía, un paso más
    // tarde y con un mensaje que no nombra la vista previa.
    expect(applied).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_APPROVAL_MISMATCH" },
    });
    if (applied.status === "failed") {
      expect(applied.failure.action).toContain("aw reseal prepare");
    }
    expect(await planOnDisk()).toBe(edited);
  });

  it("una publicación concurrente DENTRO de la ventana del lock no se pisa: la frena el CAS", async () => {
    await seed(planDoc(legacySeal(SPEC)), SPEC_EDITED);
    const prepared = await prepare();
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);

    // La publicación que `plan-exec` hace al validar una tarea: marca la casilla y
    // no toca la línea del sello. Cae en la ventana, así que el approval sigue
    // casando y lo único que puede frenar la escritura es la base de la propuesta.
    const concurrent = planDoc(legacySeal(SPEC)).replace(
      "- [ ] T1.1 — re-sellar el baseline",
      "- [x] T1.1 — re-sellar el baseline",
    );
    const racing = new PublishOnFirstRead(PLAN_PATH, () =>
      writeFile(join(root, PLAN_PATH), concurrent, "utf8"),
    );

    const applied = await applyReseal(racing, env, paths, {
      target: PLAN_PATH,
      approval: prepared.proposal.digest,
    });
    // El código es de la publicación, no del re-sello: re-codificarlo escondería
    // CUÁL garantía frenó la escritura detrás de una palabra inventada acá.
    expect(applied).toMatchObject({
      status: "failed",
      failure: { code: "PROPOSAL_BASE_STALE" },
    });
    // Los bytes de la publicación concurrente sobreviven ENTEROS: su casilla sigue
    // marcada y su sello legado sigue en su lugar, que es lo que se perdería si la
    // propuesta se publicara sin base.
    expect(await planOnDisk()).toBe(concurrent);
    // Y la ventana se abrió de verdad: la primera lectura fue la re-preparación y
    // hubo lecturas después, bajo el lock, que son las que compararon la base.
    expect(racing.reads).toBeGreaterThan(1);
  });

  it("un `> Derived from` que se escapa del workspace no se lee ni se sella", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aw-reseal-afuera-"));
    try {
      const secret = join(outside, "secreto.md");
      await writeFile(secret, "# Secreto\n\n## Requirement\n\nEsto no es una spec.\n", "utf8");
      // El patrón que cosecha la ruta acepta `.` y `/` después de `-spec`, así que
      // la cabecera puede deletrear una travesía: el `..` se pega al nombre del
      // archivo y el siguiente sale de la carpeta. La fixture se arma con `relative`
      // y se COMPRUEBA, para que el día que la resolución cambie el caso no pase a
      // probar una ruta que nunca escapaba.
      const travesia = `${SPEC_PATH.replace(/-spec.*$/, "-spec-")}../${relative(
        join(root, "docs", "specs", "040-spec-x"),
        secret,
      )}`;
      expect(resolve(root, travesia)).toBe(secret);

      const plan = planDoc(null).replace(
        `> Derived from ${SPEC_PATH}`,
        `> Derived from ${travesia}`,
      );
      await seed(plan);
      const prepared = await prepare();
      expect(prepared).toMatchObject({
        status: "failed",
        failure: { code: "RESEAL_SPEC_PATH_INVALID" },
      });
      expect(await planOnDisk()).toBe(plan);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("un approval que no es el de la vista previa no escribe nada", async () => {
    const original = planDoc(legacySeal(SPEC));
    await seed(original, SPEC_EDITED);
    const applied = await apply(
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(applied).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_APPROVAL_MISMATCH" },
    });
    expect(await planOnDisk()).toBe(original);
  });

  it("un plan sin sello recibe la línea justo después de `Derived from`", async () => {
    await seed(planDoc(null));
    const prepared = await prepare();
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);
    expect(prepared.preview.sealed_digest).toBeNull();
    expect(prepared.preview.baseline_line).toBe(functionalSeal(SPEC));

    expect(await apply(prepared.proposal.digest)).toMatchObject({ status: "applied" });
    const lines = (await planOnDisk()).split("\n");
    expect(lines[2]).toBe(`> Derived from ${SPEC_PATH}`);
    expect(lines[3]).toBe(functionalSeal(SPEC));
    expect(parsePlanBaselineSeal(await planOnDisk())).toMatchObject({
      status: "sealed",
      baseline: { path: SPEC_PATH, number: "040", digest: functionalSpecDigest(SPEC) },
    });
  });

  it("un plan sin blockquote de cabecera se rechaza en vez de reestructurarse", async () => {
    // El `Derived from` está en la cabecera pero NO como blockquote: no hay
    // ningún `>` donde el sello viva, e inventarle uno sería reescribirle el
    // documento a alguien para que quepa un campo.
    const original = `# Plan 041 — el re-sello

Derived from ${SPEC_PATH}

## Origin

Spec 040.
`;
    await seed(original);
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_PLAN_HEADERLESS" },
    });
    expect(await planOnDisk()).toBe(original);
  });

  it("un blockquote bajo una sección `###` no es cabecera: se rechaza en vez de sellar a ciegas", async () => {
    // El mismo caso anterior, pero con una sección `###` con blockquote antes
    // del primer `##`. Si el estampado cortara la cabecera sólo en `##`, la
    // línea del sello aterrizaría tras `> nota` —fuera del bloque que el lector
    // mira— y el plan quedaría `prepared` con bytes corruptos y releído `absent`.
    const original = `# Plan 041 — el re-sello

Derived from ${SPEC_PATH}

### Contexto

> nota de contexto

## Origin

Spec 040.
`;
    await seed(original);
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_PLAN_HEADERLESS" },
    });
    expect(await planOnDisk()).toBe(original);
  });

  it("un plan sin `Derived from` se rechaza con un motivo cierto para un standalone", async () => {
    const standalone = `# Plan 041 — el re-sello

> Standalone: conversación del host · generated by plan-new-loop
> Estado: open

## Origin

adopted from host conversation
`;
    await seed(standalone);
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_PLAN_STANDALONE" },
    });
    if (prepared.status !== "failed") return;
    // El mensaje tiene que ser CIERTO para el documento que lo recibe: este plan
    // se DECLARA standalone, y por eso no sella baseline. Nada de "corregí el
    // sello", y nada de acusarlo de no declarar nada: declara de dónde salió.
    expect(prepared.failure.message).toContain("se declara standalone");
    expect(prepared.failure.action).toContain("> Derived from");
    expect(prepared.failure.action).toContain("no hay baseline que re-sellar");
  });

  it("un plan sin `Derived from`, sin marcador y sin origen no se confunde con un standalone", async () => {
    // La tercera población: ni deriva ni se declara. El código es otro y el motivo
    // es otro, porque el arreglo es otro — acá hay que elegir cuál de las dos
    // cosas es cierta, y decirle "se declara standalone" sería mentirle.
    const orphan = `# Plan 041 — el re-sello

> Estado: open

## Origin

sin origen declarado.
`;
    await seed(orphan);
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_PLAN_LINEAGE_UNDECLARED" },
    });
    if (prepared.status !== "failed") return;
    expect(prepared.failure.message).toContain("no declara ninguna spec de origen");
    expect(prepared.failure.action).toContain("> Standalone:");
    expect(await planOnDisk()).toBe(orphan);
  });

  it("una spec ausente es su propio rechazo, nunca un sello sobre nada", async () => {
    await seed(planDoc(legacySeal(SPEC)));
    await rm(join(root, SPEC_PATH));
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_SPEC_ABSENT" },
    });
  });

  it("una spec con un fence sin cerrar se RECHAZA: resellar ahí graba un sello que vuelve a divergir", async () => {
    // Con el fence abierto ninguna sección del contrato es visible, el digest
    // funcional cae al byte-exacto y el sello queda garantizado a divergir con la
    // próxima coma. Sellarlo sería el bucle: preparar, aplicar, divergir, repetir.
    const unclosed = SPEC.replace("## Requirement", '```json\n{"a": 1}\n\n## Requirement');
    await seed(planDoc(legacySeal(SPEC)), unclosed);
    const prepared = await prepare();
    expect(prepared).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_SPEC_FENCE_UNCLOSED" },
    });
    if (prepared.status === "failed") {
      // Y dice QUÉ cerrar: sin la línea, la negativa manda a buscar a mano.
      expect(prepared.failure.action).toContain("línea");
      expect(prepared.failure.action).toContain(SPEC_PATH);
    }
  });

  it("re-sellar un plan ya alineado es idempotente y no escribe", async () => {
    const original = planDoc(functionalSeal(SPEC));
    await seed(original);
    const prepared = await prepare();
    expect(prepared).toMatchObject({ status: "already" });
    if (prepared.status === "already") {
      expect(prepared.preview.sealed_digest).toBe(prepared.preview.current_digest);
    }
    // Y `apply` sobre lo mismo tampoco escribe: no hay digest que aprobar y el
    // resultado dice `already` en vez de inventar una escritura.
    expect(await apply("sha256:no-importa")).toMatchObject({ status: "already" });
    expect(await planOnDisk()).toBe(original);
  });

  it("el correlativo resuelve el plan contra el canon documental", async () => {
    await seed(planDoc(null));
    const prepared = await prepare("41");
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);
    expect(prepared.preview.plan).toBe(PLAN_PATH);
  });

  it("una ruta fuera del directorio de planes no se re-sella", async () => {
    await seed(planDoc(null));
    for (const target of ["docs/plans-viejos/041-plan-resello.md", "../fuera/041-plan.md"]) {
      expect(await prepare(target), target).toMatchObject({
        status: "failed",
        failure: { code: "RESEAL_TARGET_INVALID" },
      });
    }
  });

  it("un correlativo sin plan lo dice como ausencia, no como ruta inválida", async () => {
    await seed(planDoc(null));
    expect(await prepare("999")).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_PLAN_ABSENT" },
    });
  });
});

// ── el caso que da sentido al lote ───────────────────────────────────────────

describe("un sello legado con una edición editorial: de no cerrable a cerrable", () => {
  let root: string;
  let paths: PathsService;
  let env: FakeEnv;

  /** El mismo plan, CERRADO: declara done, su casilla marcada y su fase validada. */
  const closedPlan = (baselineLine: string): string => `# Plan 041 — el re-sello

> Derived from ${SPEC_PATH}
${baselineLine}
> Estado: done
> Cierre: cerrado tras validar su única fase

## Origin

Spec 040.

## Tasks

### F1 — re-sellar
> Estado: validada
> Fuentes: workspace

- [x] T1.1 — re-sellar el baseline _(fuentes: workspace)_

**Validación de fase:** pruebas locales sobre fixtures del checkout.

**Condición de salida:** el sello es el vigente.
`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-reseal-legado-"));
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    env = new FakeEnv(root, root);
    await mkdir(paths.cwdSessionsDir(), { recursive: true });
    await mkdir(join(root, "docs/specs"), { recursive: true });
    await mkdir(join(root, "docs/plans"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Los tres estados que `planDonePrecondition` rechaza con
   * `PLAN_EXEC_DONE_BASELINE_INVALID`: un plan cuyo baseline cae en cualquiera de
   * ellos no cierra. El gate lee exactamente este campo del tablero, así que la
   * transición de dentro a fuera de este conjunto ES la de "no cerrable" a
   * "cerrable" — y el pin de abajo ata la afirmación al gate real.
   */
  const UNCLOSABLE = new Set(["divergent", "malformed", "unresolved"]);

  it("el gate de cierre sigue decidiendo por el estado del baseline del tablero", async () => {
    const gate = await readFile(
      resolve(__dirname, "..", "..", "src", "application", "flow", "internal-actions.ts"),
      "utf8",
    );
    expect(gate).toContain("PLAN_EXEC_DONE_BASELINE_INVALID");
    for (const status of UNCLOSABLE) {
      expect(gate, status).toContain(`plan.baseline.status === "${status}"`);
    }
  });

  it("prepare + apply lo dejan alineado y cerrable, tocando una sola línea", async () => {
    // El plan quedó sellado con el digest byte-exacto de la spec ORIGINAL —lo que
    // significaba un baseline antes del payload funcional— y después alguien le
    // corrigió una coma al `## Context` de la spec. Eso no cambia nada de lo
    // prometido, y aun así el sello legado no casa con ninguno de los dos digests
    // vigentes: el plan queda divergente y no puede cerrar.
    const original = closedPlan(`> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}`);
    await writeFile(join(root, SPEC_PATH), SPEC_EDITED, "utf8");
    await writeFile(join(root, PLAN_PATH), original, "utf8");

    const before = await buildWorklineIndex(fs, env, paths, { now: NOW });
    const planBefore = before.plans.find((candidate) => candidate.file === PLAN_PATH);
    expect(planBefore?.baseline).toEqual({
      status: "divergent",
      sealed_digest: specBaselineDigest(SPEC),
      current_digest: functionalSpecDigest(SPEC_EDITED),
    });
    expect(UNCLOSABLE.has(planBefore?.baseline.status ?? "")).toBe(true);

    const prepared = await prepareReseal(fs, env, paths, PLAN_PATH);
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);
    expect(prepared.preview.sealed_digest).toBe(specBaselineDigest(SPEC));
    expect(prepared.preview.current_digest).toBe(functionalSpecDigest(SPEC_EDITED));

    const applied = await applyReseal(fs, env, paths, {
      target: PLAN_PATH,
      approval: prepared.proposal.digest,
    });
    expect(applied).toMatchObject({ status: "applied", written: [PLAN_PATH] });

    const after = await readFile(join(root, PLAN_PATH), "utf8");
    expect(after).toBe(
      original.replace(
        `> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}`,
        `> Baseline: ${SPEC_PATH}@${functionalSpecDigest(SPEC_EDITED)}`,
      ),
    );

    const board = await buildWorklineIndex(fs, env, paths, { now: NOW });
    const planAfter = board.plans.find((candidate) => candidate.file === PLAN_PATH);
    expect(planAfter?.baseline).toEqual({
      status: "aligned",
      digest: functionalSpecDigest(SPEC_EDITED),
    });
    expect(UNCLOSABLE.has(planAfter?.baseline.status ?? "")).toBe(false);
    // Y desde acá una edición editorial más ya no lo mueve: el sello vigente es
    // funcional, que es lo que hace que este re-sello se pague UNA vez.
    expect(planAfter?.plan_state).toBe("done");
  });

  /** Un plan abierto con las líneas de cabecera que se le den. */
  const openPlan = (
    header: readonly string[],
    origin = "Spec 040.",
  ): string => `# Plan 041 — el re-sello

${header.join("\n")}

## Origin

${origin}

## Tasks

### F1 — re-sellar
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — re-sellar el baseline _(fuentes: workspace)_
`;

  it("un plan legado que declara su spec en `## Origin` recibe un motivo CIERTO y una salida real", async () => {
    // ESTA es la población que arrastra sellos byte-exactos: cabecera con
    // `> Baseline:`, la spec declarada en `## Origin` y ningún `> Derived from`.
    // El tablero la resuelve a su spec y la manda a `aw reseal prepare`, así que
    // lo que el comando contesta tiene que ser cierto PARA ESE documento:
    // llamarlo standalone o decirle que no declara spec son dos falsedades sobre
    // un plan que el propio tablero acaba de resolver, y lo dejan sin cerrar.
    const header = [
      `> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}`,
      "> Estado: open",
      "> Límite de ejecución: checkout",
    ];
    const legacy = openPlan(header, `Derivado de ${SPEC_PATH}.`);
    await writeFile(join(root, SPEC_PATH), SPEC_EDITED, "utf8");
    await writeFile(join(root, PLAN_PATH), legacy, "utf8");

    const before = await buildWorklineIndex(fs, env, paths, { now: NOW });
    expect(before.plans.find((c) => c.file === PLAN_PATH)?.spec).toMatchObject({
      status: "resolved",
      number: "040",
      evidence: "origin-path",
    });
    expect(before.pipeline.find((e) => e.file === PLAN_PATH)?.detail.next).toContain(
      `aw reseal prepare ${PLAN_PATH}`,
    );

    const refused = await prepareReseal(fs, env, paths, PLAN_PATH);
    expect(refused).toMatchObject({
      status: "failed",
      failure: { code: "RESEAL_PLAN_LINEAGE_UNDECLARED" },
    });
    if (refused.status !== "failed") return;
    expect(refused.failure.message).toContain("declara la spec 040 en '## Origin'");
    // Las dos mitades falsas, negadas: no es standalone y sí declara su spec.
    expect(refused.failure.message).not.toContain("standalone");
    expect(refused.failure.message).not.toContain("sin spec declarada");
    expect(refused.failure.action).toContain("> Derived from docs/specs/040-spec-");

    // Y la salida que nombra es REAL: con esa línea en la cabecera, el re-sello
    // cierra la divergencia. Un mensaje cierto que mandara a un lugar sin salida
    // dejaría el plan igual de incerrable, que es el costo que el lote quita.
    await writeFile(
      join(root, PLAN_PATH),
      openPlan([`> Derived from ${SPEC_PATH}`, ...header], `Derivado de ${SPEC_PATH}.`),
      "utf8",
    );
    const prepared = await prepareReseal(fs, env, paths, PLAN_PATH);
    if (prepared.status !== "prepared") throw new Error(`esperaba prepared: ${prepared.status}`);
    expect(
      await applyReseal(fs, env, paths, { target: PLAN_PATH, approval: prepared.proposal.digest }),
    ).toMatchObject({ status: "applied" });
    const after = await buildWorklineIndex(fs, env, paths, { now: NOW });
    expect(after.plans.find((c) => c.file === PLAN_PATH)?.baseline).toEqual({
      status: "aligned",
      digest: functionalSpecDigest(SPEC_EDITED),
    });
  });

  it("con un fence sin cerrar el tablero nombra la fence, no un cambio que no hubo", async () => {
    // La frase que el tablero emitía era FALSA sobre esta spec: nadie cambió su
    // contrato, y mandar a `aw reseal` acá es mandar al bucle.
    const unclosed = SPEC.replace("## Requirement", '```json\n{"a": 1}\n\n## Requirement');
    const open = openPlan([
      `> Derived from ${SPEC_PATH}`,
      `> Baseline: ${SPEC_PATH}@${functionalSpecDigest(SPEC)}`,
      "> Estado: open",
      "> Límite de ejecución: checkout",
    ]);
    await writeFile(join(root, SPEC_PATH), unclosed, "utf8");
    await writeFile(join(root, PLAN_PATH), open, "utf8");

    const board = await buildWorklineIndex(fs, env, paths, { now: NOW });
    const item = board.pipeline.find((entry) => entry.file === PLAN_PATH);
    expect(item?.detail.next).toContain("fence sin cerrar en la línea");
    expect(item?.detail.next).not.toContain("aw reseal prepare");
  });

  it("el tablero nombra la salida barata en la línea del plan divergente", async () => {
    const open = openPlan([
      `> Derived from ${SPEC_PATH}`,
      `> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}`,
      "> Estado: open",
      "> Límite de ejecución: checkout",
    ]);
    await writeFile(join(root, SPEC_PATH), SPEC_EDITED, "utf8");
    await writeFile(join(root, PLAN_PATH), open, "utf8");

    const board = await buildWorklineIndex(fs, env, paths, { now: NOW });
    const item = board.pipeline.find((entry) => entry.file === PLAN_PATH);
    expect(item?.detail.next).toContain("BASELINE DIVERGENTE");
    expect(item?.detail.next).toContain(`aw reseal prepare ${PLAN_PATH}`);
    // La acción recomendada NO cambia: el re-sello es la alternativa cuando el
    // plan sigue vigente, no el reemplazo del refine.
    expect(item?.action).toMatchObject({
      kind: "handoff",
      command: `/w:plan-refine ${PLAN_PATH}`,
      code: "WORKLINE_BASELINE_DIVERGENT",
    });
  });
});
