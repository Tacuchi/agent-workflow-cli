// `aw settle`: la salida de un plan bloqueado que ya no tiene recorrido abierto
// (plan 042 · F3 · S042/AC-07 y escenario 5).
//
// El incidente vive en un workspace donde la corrida que creó la obligación
// cerró hace meses. El cierre de una corrida salda sus propias obligaciones —eso
// es F2— y esto es la otra mitad: antes, la única salida era escribir
// `docs/decisions/` a mano, que es exactamente la cirugía que el andamiaje
// existe para no necesitar.
//
// Lo que se fija acá:
//
// 1. El listado dice, por cada obligación, su nota, su posición, su clase, si
//    esa clase la declaró alguien, y el punto VIGENTE del plan —nunca el que la
//    nota grabó al nacer, que puede ser una fase ya integrada.
// 2. Dos pasos, y la afirmación humana va en el medio: `prepare` sella y no
//    escribe, `apply` re-deriva del árbol vivo y exige ese digest.
// 3. Con una corrida de ejecución sobre el plan, el comando NO compite: se niega
//    y la nombra.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  noteIndexArtifact,
  noteIndexPath,
  sealNote,
} from "../../src/application/decision-note-service.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { PathsService } from "../../src/application/paths-service.js";
import { applySettle, listSettle, prepareSettle } from "../../src/application/settle-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { groupCommands } from "../../src/cli/help-groups.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  normalizeObligations,
} from "../../src/domain/decision-note.js";
import { COMMAND_EXCLUSIONS, journeyOfFlow } from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_FILE,
  applyTransition,
  newRunState,
  serializeRunState,
  withScope,
} from "../../src/domain/flow/run-state.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const HANDOFF_ITEM = "Producto y QA validan el flujo nuevo antes de la release";
const COMPENSATION = "revalidar F2 contra el contrato nuevo";
const PLAN_FILE = "docs/plans/032-plan-x.md";
const SPEC_FILE = "docs/specs/033-spec-x.md";
const INDEX = noteIndexPath("docs/decisions", "033", "x");

const SPEC_TEXT = [
  "# 033 — spec fixture",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] **S033/AC-01 — una.** texto",
  "",
].join("\n");

/** Dos fases: la primera validada, la segunda NO. El punto vigente es F2. */
const planText = (): string =>
  [
    "# 032 — plan fixture",
    "",
    `> Derived from: ${SPEC_FILE}`,
    `> Baseline: ${SPEC_FILE}@sha256:${baseDigest(SPEC_TEXT)}`,
    "> Estado: open",
    "> Límite de ejecución: checkout",
    "",
    "## Tasks",
    "",
    "### F1 — la primera",
    "> Estado: validada",
    "",
    "- [x] T1.1 — hecho _(fuentes: workspace)_",
    "",
    "### F2 — la segunda",
    "> Estado: pendiente",
    "",
    "- [ ] T2.1 — queda _(fuentes: workspace)_",
    "",
    "## Handoff operativo",
    "",
    `- ${HANDOFF_ITEM}`,
    "",
  ].join("\n");

describe("aw settle", () => {
  let root: string;
  let fs: NodeFileSystem;
  let env: FakeEnv;
  let paths: PathsService;

  /** Publica la nota portadora, en la forma que se le pida. */
  const publish = (obligations: readonly unknown[]): DecisionNote => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: SPEC_FILE, number: "033" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: { path: SPEC_FILE, number: "033", digest: functionalSpecDigest(SPEC_TEXT) },
        plan: { path: PLAN_FILE, number: "032", digest: `sha256:${baseDigest(planText())}` },
        execution: { session: "131-vieja-plan-exec", phase: "F1" },
      },
      decision: "el resultado de F1 ya no satisface el contrato",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: ["S033/AC-01"],
      supersedes_note: null,
      scope: "functional",
      consumers: [PLAN_FILE],
      evidence_preserved: [],
      evidence_invalidated: ["F1/T1.1"],
      obligations: normalizeObligations(obligations) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    const artifact = noteIndexArtifact(INDEX, { ...index, notes: [sealed] });
    writeFileSync(join(root, artifact.path), artifact.content);
    return sealed;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-settle-"));
    fs = new NodeFileSystem();
    env = new FakeEnv(root, root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    mkdirSync(paths.cwdSessionsDir(), { recursive: true });
    writeFileSync(join(root, SPEC_FILE), SPEC_TEXT);
    writeFileSync(join(root, PLAN_FILE), planText());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("list", () => {
    it("enumera cada obligación con su clase, su origen y el punto VIGENTE", async () => {
      publish([
        { text: COMPENSATION, kind: "compensation" },
        { text: HANDOFF_ITEM, kind: "handoff" },
      ]);

      const listed = await listSettle(fs, env, paths, PLAN_FILE);
      expect(listed.status).toBe("listed");
      if (listed.status !== "listed") return;

      expect(listed.listing.compensations).toEqual([
        {
          note: "DEC-001",
          index: 0,
          text: COMPENSATION,
          kind: "compensation",
          legacy: false,
          corresponds_to: null,
          declared_point: "F1/T1.1",
        },
      ]);
      expect(listed.listing.handoffs.map((o) => o.text)).toEqual([HANDOFF_ITEM]);
      expect(listed.listing.closable).toBe(false);
      // La nota dijo F1/T1.1 y esa fase está validada: el punto vigente es F2.
      expect(listed.listing.current_point).toBe("F2 — la segunda");
    });

    it("una obligación LEGADA dice que su clase la supuso la lectura, y contra qué ítem", async () => {
      publish([COMPENSATION, HANDOFF_ITEM]);

      const listed = await listSettle(fs, env, paths, PLAN_FILE);
      if (listed.status !== "listed") throw new Error("esperaba el listado");

      expect(listed.listing.compensations[0]?.legacy).toBe(true);
      expect(listed.listing.handoffs[0]).toMatchObject({
        legacy: true,
        corresponds_to: HANDOFF_ITEM,
      });
    });

    it("se puede apuntar por correlativo, no sólo por ruta", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);

      const listed = await listSettle(fs, env, paths, "032");
      expect(listed.status).toBe("listed");
      if (listed.status !== "listed") return;
      expect(listed.listing.plan).toBe(PLAN_FILE);
    });

    it("un plan sin cadena de decisiones no debe nada, y lo dice así", async () => {
      const listed = await listSettle(fs, env, paths, PLAN_FILE);
      expect(listed.status).toBe("listed");
      if (listed.status !== "listed") return;
      expect(listed.listing.compensations).toEqual([]);
      expect(listed.listing.closable).toBe(true);
    });

    it("un plan que no existe se rechaza con su código y una salida", async () => {
      const listed = await listSettle(fs, env, paths, "999");
      expect(listed.status).toBe("failed");
      if (listed.status !== "failed") return;
      expect(listed.failure.code).toBe("SETTLE_PLAN_ABSENT");
      expect(listed.failure.action).toContain("aw status");
    });
  });

  describe("prepare", () => {
    it("sin declaraciones es el listado: no hay sello que aprobar", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);

      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, {
        settle: [],
        handoff: [],
        pending: [],
      });

      expect(prepared.status).toBe("listed");
    });

    it("con una declaración sella, no escribe, y dice el comando exacto que la aplica", async () => {
      publish([
        { text: COMPENSATION, kind: "compensation" },
        { text: HANDOFF_ITEM, kind: "handoff" },
      ]);
      const before = readFileSync(join(root, INDEX), "utf8");

      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, {
        settle: ["DEC-001[0]=npm test en verde"],
        handoff: [],
        pending: [],
      });

      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;
      expect(prepared.planned).toEqual([
        {
          note: "DEC-001",
          // La evidencia viaja en el objeto sellado, que es lo que hace que
          // cambiarla entre `prepare` y `apply` invalide la aprobación.
          settled: [{ text: COMPENSATION, evidence: "npm test en verde" }],
          keeps: [{ text: HANDOFF_ITEM, kind: "handoff", declared: true }],
          execution: { session: "131-vieja-plan-exec", phase: "F1" },
        },
      ]);
      expect(prepared.digest.length).toBeGreaterThan(0);
      expect(prepared.next).toContain(`aw settle apply ${PLAN_FILE}`);
      expect(prepared.next).toContain("--settle 'DEC-001[0]=npm test en verde'");
      expect(prepared.next).toContain(`--approval ${prepared.digest}`);
      // Y no escribió un byte.
      expect(readFileSync(join(root, INDEX), "utf8")).toBe(before);
    });

    it("«cumplida» sin evidencia se rechaza: sin eso no es un saldo", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);

      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, {
        settle: ["DEC-001[0]"],
        handoff: [],
        pending: [],
      });

      expect(prepared.status).toBe("failed");
      if (prepared.status !== "failed") return;
      expect(prepared.failure.code).toBe("SETTLE_DECLARATION_INVALID");
      expect(prepared.failure.action).toContain("--settle");
    });

    it("una obligación que el plan no debe se rechaza en vez de ignorarse", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);

      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, {
        settle: [],
        handoff: ["DEC-001[7]"],
        pending: [],
      });

      expect(prepared.status).toBe("failed");
      if (prepared.status !== "failed") return;
      expect(prepared.failure.code).toBe("SETTLE_OBLIGATION_UNKNOWN");
    });

    it("dejar todo pendiente no publica nada, y lo dice antes de sellar", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);

      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, {
        settle: [],
        handoff: [],
        pending: ["DEC-001[0]"],
      });

      expect(prepared.status).toBe("failed");
      if (prepared.status !== "failed") return;
      expect(prepared.failure.code).toBe("SETTLE_DECLARATION_INVALID");
    });
  });

  describe("apply", () => {
    const declarations = { settle: ["DEC-001[0]=npm test en verde"], handoff: [], pending: [] };

    const sealedDigest = async (): Promise<string> => {
      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, declarations);
      if (prepared.status !== "prepared") throw new Error("esperaba una preparación");
      return prepared.digest;
    };

    it("publica el sucesor y deja el plan cerrable", async () => {
      publish([
        { text: COMPENSATION, kind: "compensation" },
        { text: HANDOFF_ITEM, kind: "handoff" },
      ]);

      const applied = await applySettle(fs, env, paths, {
        target: PLAN_FILE,
        approval: await sealedDigest(),
        declarations,
      });

      expect(applied.status).toBe("applied");
      if (applied.status !== "applied") return;
      expect(applied.published).toEqual(["DEC-002"]);
      expect(applied.settled).toEqual([COMPENSATION]);
      expect(applied.reconciliation.closable).toBe(true);
      // Un solo archivo cambiado: el índice de decisiones.
      const written = JSON.parse(readFileSync(join(root, INDEX), "utf8")) as {
        notes: DecisionNote[];
      };
      expect(written.notes.map((note) => note.id)).toEqual(["DEC-001", "DEC-002"]);
      expect(readFileSync(join(root, PLAN_FILE), "utf8")).toBe(planText());
      expect(readFileSync(join(root, SPEC_FILE), "utf8")).toBe(SPEC_TEXT);
    });

    it("la sesión que queda en la nota es la de la portadora: no hay corrida que nombrar", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);

      await applySettle(fs, env, paths, {
        target: PLAN_FILE,
        approval: await sealedDigest(),
        declarations,
      });

      const written = JSON.parse(readFileSync(join(root, INDEX), "utf8")) as {
        notes: DecisionNote[];
      };
      expect(written.notes[1]?.lineage.execution.session).toBe("131-vieja-plan-exec");
    });

    it("un digest vencido no escribe nada", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);
      const before = readFileSync(join(root, INDEX), "utf8");

      const applied = await applySettle(fs, env, paths, {
        target: PLAN_FILE,
        approval: `sha256:${"0".repeat(64)}`,
        declarations,
      });

      expect(applied.status).toBe("failed");
      if (applied.status !== "failed") return;
      expect(applied.failure.code).toBe("SETTLE_APPROVAL_MISMATCH");
      expect(applied.failure.action).toContain("aw settle prepare");
      expect(readFileSync(join(root, INDEX), "utf8")).toBe(before);
    });

    it("repetirlo es idempotente: la cadena no gana una nota gemela", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);
      const digest = await sealedDigest();
      const first = await applySettle(fs, env, paths, {
        target: PLAN_FILE,
        approval: digest,
        declarations,
      });
      expect(first.status).toBe("applied");

      // La segunda pasada ya no tiene esa obligación vigente: el comando lo dice
      // en vez de anexar un sucesor de una nota que ya nadie debe.
      const second = await applySettle(fs, env, paths, {
        target: PLAN_FILE,
        approval: digest,
        declarations,
      });
      expect(second.status).toBe("failed");
      if (second.status !== "failed") return;
      expect(second.failure.code).toBe("SETTLE_OBLIGATION_UNKNOWN");
      const written = JSON.parse(readFileSync(join(root, INDEX), "utf8")) as {
        notes: DecisionNote[];
      };
      expect(written.notes).toHaveLength(2);
    });
  });

  describe("con una corrida de ejecución abierta sobre el plan", () => {
    const openRun = async (): Promise<void> => {
      const folder = "170-otra-plan-exec";
      mkdirSync(join(paths.cwdSessionsDir(), folder), { recursive: true });
      const run = withScope(newRunState("plan-exec", folder), {
        plan: PLAN_FILE,
        sources: ["workspace"],
      });
      await writeFile(
        join(paths.cwdSessionsDir(), folder, FLOW_RUN_STATE_FILE),
        serializeRunState(run),
      );
    };

    it("`prepare` se niega y nombra la corrida, no compite con ella", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);
      await openRun();

      const prepared = await prepareSettle(fs, env, paths, PLAN_FILE, {
        settle: ["DEC-001[0]=npm test en verde"],
        handoff: [],
        pending: [],
      });

      expect(prepared.status).toBe("failed");
      if (prepared.status !== "failed") return;
      expect(prepared.failure.code).toBe("SETTLE_RUN_OPEN");
      expect(prepared.failure.action).toContain("aw flow advance --code 170-otra-plan-exec");
    });

    it("pero `list` sigue funcionando: leer nunca compite", async () => {
      publish([{ text: COMPENSATION, kind: "compensation" }]);
      await openRun();

      const listed = await listSettle(fs, env, paths, PLAN_FILE);
      expect(listed.status).toBe("listed");
    });
  });

  describe("el registro del comando", () => {
    it("está en la lista canónica y en el grupo de orquestación, junto a reseal y amend", () => {
      expect(ALL_COMMANDS.map((command) => command.name)).toContain("settle");
      const groups = groupCommands(ALL_COMMANDS.map((command) => command.name));
      const group = groups.find((candidate) => candidate.commands.includes("settle"));
      expect(group?.commands).toContain("reseal");
      expect(group?.commands).toContain("amend");
    });

    it("declara por qué no abre recorrido, nombrando el molde que sigue", () => {
      const exclusion = COMMAND_EXCLUSIONS.find((entry) => entry.command === "settle");
      expect(exclusion?.reason).toContain("reseal");
    });
  });
});

// Lo que la relectura independiente encontró, fijado para que no vuelva.
describe("aw settle — las trampas que la relectura encontró", () => {
  const SPEC2 = "docs/specs/044-spec-y.md";
  const PLAN_A = "docs/plans/067-plan-a.md";
  const PLAN_B = "docs/plans/068-plan-b.md";
  const INDEX2 = noteIndexPath("docs/decisions", "044", "y");
  const SPEC2_TEXT = [
    "# 044 — spec de dos planes",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] **S044/AC-01 — una.** texto",
    "",
  ].join("\n");
  const siblingPlan = (name: string): string =>
    [
      `# ${name}`,
      "",
      `> Derived from: ${SPEC2}`,
      `> Baseline: ${SPEC2}@sha256:${baseDigest(SPEC2_TEXT)}`,
      "> Estado: open",
      "",
      "## Tasks",
      "",
      "### F1 — la única",
      "> Estado: pendiente",
      "",
      "- [ ] T1.1 — queda _(fuentes: workspace)_",
      "",
    ].join("\n");

  let root: string;
  let fs: NodeFileSystem;
  let env: FakeEnv;
  let paths: PathsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-settle-x-"));
    fs = new NodeFileSystem();
    env = new FakeEnv(root, root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    for (const dir of ["specs", "plans", "decisions"]) {
      mkdirSync(join(root, "docs", dir), { recursive: true });
    }
    mkdirSync(paths.cwdSessionsDir(), { recursive: true });
    writeFileSync(join(root, SPEC2), SPEC2_TEXT);
    writeFileSync(join(root, PLAN_A), siblingPlan("067 — plan A"));
    writeFileSync(join(root, PLAN_B), siblingPlan("068 — plan B"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Una nota por plan, cada una con su compensación, en la MISMA cadena. */
  const publishBoth = (): void => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: SPEC2, number: "044" },
      notes: [] as DecisionNote[],
    };
    const noteFor = (plan: string, session: string, phase: string, text: string) => ({
      schema: NOTE_SCHEMA,
      lineage: {
        spec: { path: SPEC2, number: "044", digest: functionalSpecDigest(SPEC2_TEXT) },
        plan: {
          path: plan,
          number: plan.includes("067") ? "067" : "068",
          digest: `sha256:${baseDigest(siblingPlan("x"))}`,
        },
        execution: { session, phase },
      },
      decision: `el resultado de ${plan} ya no satisface el contrato`,
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: [] as string[],
      supersedes_note: null,
      scope: "plan-only" as const,
      consumers: [plan],
      evidence_preserved: [] as string[],
      evidence_invalidated: [] as string[],
      obligations: normalizeObligations([{ text, kind: "compensation" }]) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    const first = sealNote(index, noteFor(PLAN_A, "131-a-plan-exec", "F1", "revalidar A"));
    const withFirst = { ...index, notes: [first] };
    const second = sealNote(withFirst, noteFor(PLAN_B, "152-b-plan-exec", "F3", "revalidar B"));
    const artifact = noteIndexArtifact(INDEX2, { ...index, notes: [first, second] });
    writeFileSync(join(root, artifact.path), artifact.content);
  };

  it("la cadena es POR SPEC, pero las obligaciones de un plan son sólo las suyas", async () => {
    publishBoth();

    const a = await listSettle(fs, env, paths, PLAN_A);
    const b = await listSettle(fs, env, paths, PLAN_B);
    if (a.status !== "listed" || b.status !== "listed") throw new Error("esperaba los listados");

    expect(a.listing.compensations.map((o) => o.text)).toEqual(["revalidar A"]);
    expect(b.listing.compensations.map((o) => o.text)).toEqual(["revalidar B"]);
  });

  it("nombrar un plan NO salda la obligación de su hermano", async () => {
    publishBoth();

    // DEC-002 es del plan B. Declararla nombrando el plan A saldaría por debajo
    // de un plan que ni se nombró —y el guard de corrida abierta sólo mira el
    // plan nombrado, así que ni siquiera se enteraría.
    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-002[0]=corrí lo de B"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("failed");
    if (prepared.status !== "failed") return;
    expect(prepared.failure.code).toBe("SETTLE_OBLIGATION_UNKNOWN");
  });

  it("cada sucesor queda con la sesión y la fase de SU portadora", async () => {
    publishBoth();
    const declarations = {
      settle: ["DEC-001[0]=corrí A", "DEC-002[0]=corrí B"],
      handoff: [],
      pending: [],
    };
    // Sólo DEC-001 es del plan A, así que declarar las dos se rechaza — que es
    // el punto anterior. Se saldan una por plan, y cada nota queda en su sitio.
    expect((await prepareSettle(fs, env, paths, PLAN_A, declarations)).status).toBe("failed");

    for (const [plan, ref, session, phase] of [
      [PLAN_A, "DEC-001[0]=corrí A", "131-a-plan-exec", "F1"],
      [PLAN_B, "DEC-002[0]=corrí B", "152-b-plan-exec", "F3"],
    ] as const) {
      const one = { settle: [ref], handoff: [], pending: [] };
      const prepared = await prepareSettle(fs, env, paths, plan, one);
      if (prepared.status !== "prepared") throw new Error("esperaba una preparación");
      expect(prepared.planned[0]?.execution).toEqual({ session, phase });

      const applied = await applySettle(fs, env, paths, {
        target: plan,
        approval: prepared.digest,
        declarations: one,
      });
      expect(applied.status).toBe("applied");
    }

    const written = JSON.parse(readFileSync(join(root, INDEX2), "utf8")) as {
      notes: DecisionNote[];
    };
    const successors = written.notes.filter((note) => note.supersedes_note !== null);
    expect(successors.map((note) => note.lineage.execution)).toEqual([
      { session: "131-a-plan-exec", phase: "F1" },
      { session: "152-b-plan-exec", phase: "F3" },
    ]);
  });

  it("cambiar la EVIDENCIA entre prepare y apply invalida la aprobación", async () => {
    publishBoth();
    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=npm test 4827 en verde"],
      handoff: [],
      pending: [],
    });
    if (prepared.status !== "prepared") throw new Error("esperaba una preparación");

    // La evidencia es lo ÚNICO que la persona aporta: si el sello no la cubriera,
    // aprobar «corrí la suite» valdría para publicar «lo miré y estaba bien».
    const applied = await applySettle(fs, env, paths, {
      target: PLAN_A,
      approval: prepared.digest,
      declarations: { settle: ["DEC-001[0]=lo miré y estaba bien"], handoff: [], pending: [] },
    });

    expect(applied.status).toBe("failed");
    if (applied.status !== "failed") return;
    expect(applied.failure.code).toBe("SETTLE_APPROVAL_MISMATCH");
  });

  it("una obligación LEGADA sin lectura declarada no se puede arrastrar", async () => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: SPEC2, number: "044" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: { path: SPEC2, number: "044", digest: functionalSpecDigest(SPEC2_TEXT) },
        plan: { path: PLAN_A, number: "067", digest: `sha256:${baseDigest(siblingPlan("x"))}` },
        execution: { session: "131-a-plan-exec", phase: "F1" },
      },
      decision: "el resultado ya no satisface el contrato",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: [],
      supersedes_note: null,
      scope: "plan-only",
      consumers: [PLAN_A],
      evidence_preserved: [],
      evidence_invalidated: [],
      // Dos obligaciones en forma de TEXTO: nadie declaró su clase.
      obligations: normalizeObligations(["revalidar A", "avisar a alguien más"]) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    const artifact = noteIndexArtifact(INDEX2, { ...index, notes: [sealed] });
    writeFileSync(join(root, artifact.path), artifact.content);

    // Saldar una y callar sobre la otra obligaría al sucesor a estampar la
    // lectura del CLI como declarada, sin que nadie la ratifique — que es lo que
    // la frontera humana del cierre existe para no hacer.
    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("failed");
    if (prepared.status !== "failed") return;
    expect(prepared.failure.code).toBe("SETTLE_DECLARATION_INVALID");
    expect(prepared.failure.message).toContain("avisar a alguien más");
    expect(prepared.failure.action).toContain("--handoff");

    // Con la lectura de las dos declarada, sale.
    const both = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: ["DEC-001[1]"],
      pending: [],
    });
    expect(both.status).toBe("prepared");
  });

  it("`--pending` sobre una legada tampoco alcanza: la lectura sigue siendo de la persona", async () => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: SPEC2, number: "044" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: { path: SPEC2, number: "044", digest: functionalSpecDigest(SPEC2_TEXT) },
        plan: { path: PLAN_A, number: "067", digest: `sha256:${baseDigest(siblingPlan("x"))}` },
        execution: { session: "131-a-plan-exec", phase: "F1" },
      },
      decision: "el resultado ya no satisface el contrato",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: [],
      supersedes_note: null,
      scope: "plan-only",
      consumers: [PLAN_A],
      evidence_preserved: [],
      evidence_invalidated: [],
      obligations: normalizeObligations(["revalidar A", "otra cosa vieja"]) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    writeFileSync(
      join(root, INDEX2),
      noteIndexArtifact(INDEX2, { ...index, notes: [sealed] }).content,
    );

    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: ["DEC-001[1]"],
    });

    expect(prepared.status).toBe("failed");
    if (prepared.status !== "failed") return;
    expect(prepared.failure.message).toContain("otra cosa vieja");
  });

  it("una corrida TERMINADA no bloquea: es el workspace para el que existe el comando", async () => {
    publishBoth();
    const folder = "170-vieja-plan-exec";
    mkdirSync(join(paths.cwdSessionsDir(), folder), { recursive: true });
    // Una corrida cuyo recorrido se agotó y cuya sesión nadie cerró.
    let run = withScope(newRunState("plan-exec", folder), {
      plan: PLAN_A,
      sources: ["workspace"],
    });
    for (const decision of journeyOfFlow("plan-exec")) {
      run = applyTransition(run, decision.id);
    }
    await writeFile(
      join(paths.cwdSessionsDir(), folder, FLOW_RUN_STATE_FILE),
      serializeRunState(run),
    );

    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("prepared");
  });

  it("la corrida detenida en una invocación se nombra por su directiva, no por el comando crudo", async () => {
    // En una frontera de EJECUCIÓN la proyección devuelve la invocación sellada
    // —`aw worktree list …`— porque eso es lo que continúa la corrida desde
    // adentro. Ofrecida a un tercero como la salida de este plan sería un
    // comando que no hace lo que la frase dice: hay que correrlo y devolver su
    // salida real. El tercero va a la directiva, que la vuelve a mostrar.
    publishBoth();
    const folder = "174-en-ejecucion-plan-exec";
    mkdirSync(join(paths.cwdSessionsDir(), folder), { recursive: true });
    let run = withScope(newRunState("plan-exec", folder), {
      plan: PLAN_A,
      sources: ["workspace"],
    });
    for (const decision of journeyOfFlow("plan-exec")) {
      if (decision.id === "plan-exec.branch-precondition") break;
      run = applyTransition(run, decision.id);
    }
    await writeFile(
      join(paths.cwdSessionsDir(), folder, FLOW_RUN_STATE_FILE),
      serializeRunState(run),
    );

    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("failed");
    if (prepared.status !== "failed") return;
    expect(prepared.failure.action).toContain(`aw flow advance --code ${folder}`);
    expect(prepared.failure.action).not.toContain("aw worktree list");
  });

  it("una corrida de OTRO flujo no bloquea: ninguna fija un plan", async () => {
    // El defecto que esto fija: `scope` nace nulo y sólo lo fija la declaración
    // de alcance de `plan-exec`, así que mirarlo antes del flujo volvía «corrida
    // ilegible» a toda sesión de `quick`, `spec-refine` o `plan-new` — y dueña
    // de TODO plan que nadie más nombrara. Con una sesión abierta cualquiera,
    // `aw settle` quedaba inservible en el workspace normal.
    publishBoth();
    const folder = "172-otra-cosa-quick";
    mkdirSync(join(paths.cwdSessionsDir(), folder), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), folder, FLOW_RUN_STATE_FILE),
      serializeRunState(newRunState("quick", folder)),
    );

    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("prepared");
  });

  it("una corrida de ejecución SIN plan fijado sí bloquea, y lo dice por lo que es", async () => {
    publishBoth();
    const folder = "173-sin-alcance-plan-exec";
    mkdirSync(join(paths.cwdSessionsDir(), folder), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), folder, FLOW_RUN_STATE_FILE),
      serializeRunState(newRunState("plan-exec", folder)),
    );

    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("failed");
    if (prepared.status !== "failed") return;
    expect(prepared.failure.code).toBe("SETTLE_RUN_OPEN");
    // La mitad segura, pero nombrada de verdad: su estado se lee perfectamente.
    expect(prepared.failure.message).toContain("todavía no fijó su plan");
    expect(prepared.failure.message).not.toContain("no se puede leer");
  });

  it("una corrida ILEGIBLE sí bloquea: no se puede descartar que tenga el plan", async () => {
    publishBoth();
    const folder = "171-roto-plan-exec";
    mkdirSync(join(paths.cwdSessionsDir(), folder), { recursive: true });
    await writeFile(join(paths.cwdSessionsDir(), folder, FLOW_RUN_STATE_FILE), "{ roto");

    const prepared = await prepareSettle(fs, env, paths, PLAN_A, {
      settle: ["DEC-001[0]=corrí A"],
      handoff: [],
      pending: [],
    });

    expect(prepared.status).toBe("failed");
    if (prepared.status !== "failed") return;
    expect(prepared.failure.code).toBe("SETTLE_RUN_OPEN");
    expect(prepared.failure.message).toContain(folder);
    expect(prepared.failure.message).toContain("no se puede leer");
  });

  it("una spec cuyo nombre no expone slug se rechaza en vez de informar «no debe nada»", async () => {
    const renamed = "docs/specs/044-especificacion-y.md";
    writeFileSync(join(root, renamed), SPEC2_TEXT);
    writeFileSync(
      join(root, PLAN_A),
      siblingPlan("067 — plan A").replace(SPEC2, renamed).replace(SPEC2, renamed),
    );

    const listed = await listSettle(fs, env, paths, PLAN_A);

    expect(listed.status).toBe("failed");
    if (listed.status !== "failed") return;
    expect(listed.failure.code).toBe("SETTLE_PLAN_LINEAGE_UNDECLARED");
  });

  it("un correlativo ambiguo dice cuáles documentos nombra", async () => {
    writeFileSync(join(root, "docs/plans/067-plan-otro.md"), siblingPlan("067 — otro"));

    const listed = await listSettle(fs, env, paths, "067");

    expect(listed.status).toBe("failed");
    if (listed.status !== "failed") return;
    expect(listed.failure.code).toBe("SETTLE_TARGET_AMBIGUOUS");
    expect(listed.failure.action).toContain("saldar");
  });
});

// La proyección humana, que es lo que una persona lee antes de tipear el digest.
describe("aw settle — lo que la persona lee", () => {
  const command = ALL_COMMANDS.find((candidate) => candidate.name === "settle");
  const render = (data: unknown, detail = false): string =>
    command?.renderHuman?.(
      { ok: true, data, exitCode: 0 } as never,
      {
        detail,
        format: "human",
      } as never,
    ) ?? "";

  const listing = {
    plan: PLAN_FILE,
    spec: SPEC_FILE,
    compensations: [
      {
        note: "DEC-001",
        index: 0,
        text: COMPENSATION,
        kind: "compensation" as const,
        legacy: true,
        corresponds_to: null,
        declared_point: "F1/T1.1",
      },
    ],
    handoffs: [
      {
        note: "DEC-001",
        index: 1,
        text: HANDOFF_ITEM,
        kind: "handoff" as const,
        legacy: true,
        corresponds_to: HANDOFF_ITEM,
        declared_point: "F1/T1.1",
      },
    ],
    closable: false,
    current_point: "F2 — la segunda",
  };

  it("el listado marca la clase supuesta en AMBAS clases y conserva el punto que la nota dijo", () => {
    const text = render({ action: "list", listing });

    expect(text).toContain("Punto vigente: F2 — la segunda");
    // La compensación legada.
    expect(text).toContain("clase no declarada, leída compensación");
    // Y el traspaso legado, que es la lectura NO bloqueante y la más importante
    // de marcar como una lectura que alguien supuso.
    expect(text).toContain("clase no declarada, leída traspaso");
    expect(text).toContain(`el plan lo enumera: «${HANDOFF_ITEM}»`);
    // El punto que la nota grabó viaja igual, aunque esté vencido: es la auditoría.
    expect(text).toContain("la nota dijo: F1/T1.1");
    expect(text).toContain("El plan NO es cerrable todavía.");
  });

  it("la vista previa imprime la EVIDENCIA, que es lo único que la persona aportó", () => {
    const text = render({
      action: "prepare",
      status: "prepared",
      listing,
      planned: [
        {
          note: "DEC-001",
          settled: [{ text: COMPENSATION, evidence: "npm test 4827 en verde" }],
          keeps: [{ text: HANDOFF_ITEM, kind: "handoff", declared: true }],
          execution: { session: "131-vieja-plan-exec", phase: "F1" },
        },
      ],
      digest: `sha256:${"a".repeat(64)}`,
      next: "aw settle apply <plan> --approval <digest>",
    });

    expect(text).toContain("evidencia: npm test 4827 en verde");
    expect(text).toContain("sesión 131-vieja-plan-exec, fase F1");
    expect(text).toContain(`conserva: ${HANDOFF_ITEM} [traspaso]`);
    expect(text).toContain("Para aplicar exactamente esto");
    // El digest sólo bajo --detail: lo que se lee es la decisión, no el sello.
    expect(text).not.toContain("a".repeat(64));
    expect(
      render(
        {
          action: "prepare",
          status: "prepared",
          listing,
          planned: [],
          digest: `sha256:${"a".repeat(64)}`,
          next: "x",
        },
        true,
      ),
    ).toContain("a".repeat(64));
  });

  it("sin declaraciones dice cómo se declara una, en vez de un sello vacío", () => {
    const text = render({
      action: "prepare",
      status: "listed",
      listing,
      planned: [],
      digest: null,
      next: null,
    });

    expect(text).toContain("No declaraste ningún saldo");
    expect(text).toContain("--settle");
  });

  it("aplicado dice qué se publicó y si el plan quedó cerrable", () => {
    const text = render({
      action: "apply",
      status: "applied",
      listing,
      published: ["DEC-002"],
      settled: [COMPENSATION],
      closable: true,
    });

    expect(text).toContain("Saldo publicado en");
    expect(text).toContain("DEC-002");
    expect(text).toContain("El plan queda cerrable.");
  });
});
