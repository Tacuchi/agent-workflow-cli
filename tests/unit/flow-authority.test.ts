import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKLINE_FLOWS } from "../../src/application/capability/compose.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  CHASSIS_SCOPE,
  COMMAND_EXCLUSIONS,
  FLOW_AUTHORITIES,
  FLOW_DECISIONS,
  FLOW_TRANCHES,
  RUN_PLACEHOLDERS,
  TRANSITION_OWNERSHIPS,
  actionOf,
  commandOfScope,
  decisionsOfScope,
  flowOfScope,
  trancheOfFlow,
} from "../../src/domain/flow/authority.js";

/** Where QUICK's own rules live — the exact boundary of the migrated tranche. */
const QUICK_LOOP = "loops/quick-loop/LOOP.md";

/**
 * The authority registry, checked in BOTH directions.
 *
 * Forward: every row points at a flow, the chassis or a real command, and at a
 * document the bundle actually ships. Backward: every registered command is
 * either classified or excluded on the record — the two together are what makes
 * "exhaustive" a checkable claim instead of a promise.
 *
 * What no test can prove is exhaustiveness against the PROSE: whether the
 * doctrine holds a rule nobody transcribed is a judgment, and it is covered by
 * the document→rows checklist recorded in the execution session, not here.
 */

const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");
const registered = new Set(ALL_COMMANDS.map((command) => command.name));

describe("registro de autoridad — forma y unicidad", () => {
  it("cada decisión tiene un id único", () => {
    const seen = new Map<string, number>();
    for (const decision of FLOW_DECISIONS) {
      seen.set(decision.id, (seen.get(decision.id) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)).toEqual([]);
  });

  it("cada decisión declara UNA autoridad y UNA propiedad del vocabulario cerrado", () => {
    for (const decision of FLOW_DECISIONS) {
      expect(FLOW_AUTHORITIES, decision.id).toContain(decision.authority);
      expect(TRANSITION_OWNERSHIPS, decision.id).toContain(decision.ownership);
    }
  });

  it("la propiedad no convierte juicio en regla: una fila migrada conserva su autoridad", () => {
    // Until the QUICK cutover every `cli-owned` row happened to be `cli`, and this
    // guard asserted that coincidence. It is not the invariant: ownership answers
    // "does this CLI decide WHEN it is asked", authority answers "who produces the
    // answer", and a migrated tranche moves the first without touching the second.
    // What must stay impossible is the CLI claiming an agent's judgment or a
    // person's preference as its own to materialize — which is exactly a row that
    // DELEGATES an invocation without being `cli`.
    const usurped = FLOW_DECISIONS.filter(
      (decision) => decision.authority !== "cli" && actionOf(decision) !== null,
    );
    expect(usurped.map((decision) => decision.id)).toEqual([]);
    // And the migrated non-`cli` rows are still non-`cli`: they come back as
    // boundaries, they are not applied by the walk.
    const migratedJudgment = FLOW_DECISIONS.filter(
      (decision) => decision.ownership === "cli-owned" && decision.authority !== "cli",
    );
    expect(migratedJudgment.map((decision) => decision.id)).toEqual([
      // The adaptive route evaluates the relevant optional controls before a
      // flow begins; it is still the agent's judgment, never a CLI rule.
      "chassis.route-evaluation",
      // The transversal three, and they are the sharpest case the guard makes:
      // migrating a rule moved WHEN it is asked, never WHO answers. Detecting a
      // gap and weighing a deliverable are still judgment; the flow control is
      // still the person's. Not one of them gained an `action`.
      "chassis.gap-detection",
      "chassis.minimality-lens",
      "chassis.flow-control",
      "quick.entry-gate-signal",
      "quick.gate-choice",
      "quick.success-criteria-authoring",
      "quick.success-criteria-ratification",
      // Declarar el arreglo previsto es juicio del agente; aprobarlo es preferencia
      // de la persona. Ninguna de las dos ganó un `action`: la primera contesta con
      // una declaración y la segunda con una etiqueta.
      "quick.fix-preview",
      "quick.fix-preview-approval",
      "quick.deliverable-authoring",
      // La frontera que declara si el quick tocó una base de datos: sin ella, la
      // regla de scripts-only exigía un SCRIPTS.sql que no debía existir.
      "quick.db-touched",
      "quick.review-findings",
      "quick.commit-authorization",
      // El destino DECLARA lo que consume: sin esta fila el paquete de
      // escalación llegaba a ningún lado y el refine volvía a derivar el
      // diagnóstico que la ejecución ya había producido.
      "spec-refine.escalation-adoption",
      "spec-refine.baseline-scope",
      "spec-refine.split-signal",
      "spec-refine.split-choice",
      "spec-refine.gap-recognition",
      "spec-refine.ideation-consent",
      "spec-refine.content-authoring",
      "spec-refine.functional-ambiguity",
      "spec-refine.design-reuse",
      // Los bytes exactos los redacta el agente; el CLI los sella, los muestra y
      // los escribe. Autoría y publicación quedan de lados distintos de la línea.
      "spec-refine.save-proposal",
      "spec-refine.save-confirmation",
      // PLAN's, and the shape repeats: the agent recognizes, the person prefers,
      // the CLI decides when each is asked. Not one of them gained an `action`.
      "plan-new.slug-derivation",
      "plan-new.phase-shaping",
      "plan-new.batch-eligibility-signal",
      "plan-new.split-signal",
      "plan-new.split-choice",
      "plan-new.save-proposal",
      "plan-new.save-confirmation",
      "plan-refine.escalation-adoption",
      "plan-refine.journey-map",
      "plan-refine.batch-eligibility-signal",
      "plan-refine.split-signal",
      // Reducir el original y extraer los hermanos DECIDE qué bytes se proponen:
      // dejó de ser una escritura delegada después de la confirmación.
      "plan-refine.split-in-place",
      "plan-refine.save-proposal",
      "plan-refine.save-confirmation",
      "plan-exec.entry-gap-recognition",
      "plan-exec.normalization-consent",
      // Qué fuentes toca un plan lo dice el PLAN, y el motor nunca leyó uno: la
      // fila entrega ese juicio y el CLI lo valida contra el workspace antes de
      // persistirlo. Es la única de la jornada que devuelve datos en vez de
      // señales, y por eso no declara vocabulario.
      "plan-exec.source-scope",
      // El rango se infiere sólo DESPUÉS de que el scope fijó qué plan y fuentes
      // pueden leerse; desde ahí comienza el segmento repetible del batch.
      "plan-exec.batch-eligibility-signal",
      "plan-exec.implementation",
      "plan-exec.deviation-recognition",
      // La elegibilidad es CIERRE, no tamaño: cuatro señales que tienen que
      // cerrar. Y el gate dejó de auto-aplicarse: es la persona quien elige
      // por cuál de las cuatro salidas se va la corrida.
      "plan-exec.deviation-eligibility",
      "plan-exec.deviation-gate",
      "plan-exec.escalation-package",
      "plan-exec.review-findings",
      "plan-exec.commit-authorization",
      // Contracted in their own command rather than walked: they decide which
      // line a prompt joins, or fire at whatever boundary the run is standing
      // on. Neither shape is a step of a journey. The five the closing tranche
      // added are the same shape once more — reading a conflict's intent,
      // classifying what a conversation produced, synthesizing a report: the
      // judgment stayed exactly where it was, and what moved is that the command
      // now decides what it is answered against.
      "resume.route-choice",
      "resume.prompt-relatedness",
      "resume.escalation-consent",
      "persist.shape-classification",
      "context-plan.signal-declaration",
      "checkpoint-write.context-pressure-signal",
      "fix-git.intent",
      "export.selection",
    ]);
  });

  it("solo una decisión del CLI puede delegar su ejecución", () => {
    // An `agent` or `human` row already hands control back for a different reason;
    // a second one would make the boundary ambiguous — two answers admissible at
    // the same stop, and the caller choosing which.
    const offenders = FLOW_DECISIONS.filter(
      (decision) => actionOf(decision) !== null && decision.authority !== "cli",
    );
    expect(offenders.map((decision) => decision.id)).toEqual([]);
  });

  it("toda acción delegada es reproducible, verificable y recuperable", () => {
    for (const decision of FLOW_DECISIONS) {
      const action = actionOf(decision);
      if (action === null) continue;
      // Reproducible: the caller must never have to reconstruct the call.
      expect(action.invocation.program.trim().length, decision.id).toBeGreaterThan(0);
      expect(action.invocation.target.trim().length, decision.id).toBeGreaterThan(0);
      // Verifiable: an action nobody can check is a confirmation with extra steps.
      expect(action.evidence.length, decision.id).toBeGreaterThan(0);
      for (const id of action.evidence) expect(id.trim().length, decision.id).toBeGreaterThan(0);
      // Recoverable: a partial result has to have somewhere to go.
      expect(action.recovery.trim().length, decision.id).toBeGreaterThan(10);
    }
  });

  /**
   * La notación de la prosa NO es la notación de una invocación.
   *
   * `PLAN-INPUT` dice `plan-<slug>.md` y hace bien: le habla a quien lee. Esa
   * línea se copió a una fila, y en una fila los ángulos no ligan con nada ni los
   * ve el guard de placeholder vivo, así que la plantilla llegó entera a quien
   * ejecuta: el agente que la sustituyó bien dejó de coincidir con lo sellado y el
   * que la corrió literal creó un archivo llamado como la plantilla.
   *
   * Se fija la CLASE y no el caso: lo que hay que impedir es que la próxima fila
   * vuelva a traer una metavariable de documento, cualquiera sea su nombre.
   */
  it("ninguna invocación lleva una metavariable de prosa: los huecos son del conjunto cerrado", () => {
    const metavariable = /<[a-z][a-z0-9_-]*>/i;
    for (const decision of FLOW_DECISIONS) {
      const action = actionOf(decision);
      if (action === null) continue;
      const parts = [
        action.invocation.program,
        ...action.invocation.args,
        action.invocation.target,
      ];
      for (const part of parts) {
        expect(metavariable.test(part), `${decision.id} → ${part}`).toBe(false);
      }
      // Y todo hueco con llaves es uno que el motor sabe ligar.
      for (const found of parts.join(" ").match(/\{[a-z0-9_-]+\}/gi) ?? []) {
        expect(RUN_PLACEHOLDERS as readonly string[], decision.id).toContain(found);
      }
    }
  });

  it("cada título dice qué se decide, en una línea", () => {
    for (const decision of FLOW_DECISIONS) {
      expect(decision.title.trim().length, decision.id).toBeGreaterThan(10);
      expect(decision.title, decision.id).not.toContain("\n");
    }
  });
});

describe("registro de autoridad — cada entrada apunta a algo real", () => {
  it("todo scope resuelve a un flow, al chasis o a un comando registrado", () => {
    const orphans: string[] = [];
    for (const decision of FLOW_DECISIONS) {
      if (decision.scope === CHASSIS_SCOPE) continue;
      if (flowOfScope(decision.scope) !== null) continue;
      const command = commandOfScope(decision.scope);
      if (command !== null && registered.has(command)) continue;
      orphans.push(`${decision.id} → ${decision.scope}`);
    }
    expect(orphans).toEqual([]);
  });

  it("todo documento citado existe en el bundle", () => {
    const missing = FLOW_DECISIONS.filter(
      (decision) => !existsSync(join(BUNDLE, decision.document)),
    );
    expect(missing.map((decision) => `${decision.id} → ${decision.document}`)).toEqual([]);
  });

  it("los cinco flows y el chasis tienen decisiones declaradas", () => {
    for (const flow of WORKLINE_FLOWS) {
      expect(decisionsOfScope(flow).length, flow).toBeGreaterThan(0);
    }
    expect(decisionsOfScope(CHASSIS_SCOPE).length).toBeGreaterThan(0);
  });

  it("cada flow pertenece a un tramo declarado", () => {
    for (const flow of WORKLINE_FLOWS) {
      expect(FLOW_TRANCHES, flow).toContain(trancheOfFlow(flow));
    }
  });
});

describe("registro de autoridad — el universo es el command registry", () => {
  it("todo comando registrado tiene entradas o una exclusión con motivo", () => {
    const classified = new Set(
      FLOW_DECISIONS.map((decision) => commandOfScope(decision.scope)).filter(
        (command): command is string => command !== null,
      ),
    );
    const excluded = new Set(COMMAND_EXCLUSIONS.map((entry) => entry.command));
    const unclassified = [...registered].filter(
      (command) => !classified.has(command) && !excluded.has(command),
    );
    expect(unclassified).toEqual([]);
  });

  it("ninguna exclusión viene sin motivo", () => {
    for (const entry of COMMAND_EXCLUSIONS) {
      expect(entry.reason.trim().length, entry.command).toBeGreaterThan(10);
    }
  });

  it("ningún comando está a la vez clasificado y excluido", () => {
    const classified = new Set(
      FLOW_DECISIONS.map((decision) => commandOfScope(decision.scope)).filter(
        (command): command is string => command !== null,
      ),
    );
    const both = COMMAND_EXCLUSIONS.filter((entry) => classified.has(entry.command));
    expect(both.map((entry) => entry.command)).toEqual([]);
  });

  it("toda exclusión nombra un comando que existe, en cualquiera de las dos superficies", () => {
    const ghosts = COMMAND_EXCLUSIONS.filter(
      (entry) => !registered.has(entry.command) && !slashCommands().includes(entry.command),
    );
    expect(ghosts.map((entry) => entry.command)).toEqual([]);
  });

  /**
   * The `/w:` commands, taken from the bundle rather than from a list.
   *
   * Same reason the `aw` universe is `ALL_COMMANDS` and not a copy of it: a
   * second list would drift, and the whole point of exhaustiveness is that
   * nobody can forget to add a row to it.
   */
  function slashCommands(): string[] {
    return readdirSync(join(BUNDLE, "commands"))
      .filter((file) => file.endsWith(".md") && file !== "README.md")
      .map((file) => file.replace(/\.md$/, ""));
  }

  it("todo comando /w: es un flow, tiene filas o está excluido con motivo", () => {
    // The second universe, and the gap that made it necessary: `spec-new` had
    // neither rows nor an exclusion, which reads exactly like having been
    // forgotten. It is not an `aw` command, so the registry-based guard above
    // could never have seen it — a journey stays public whether or not the CLI
    // ships a command by that name.
    const flows = new Set<string>(WORKLINE_FLOWS);
    const classified = new Set(
      FLOW_DECISIONS.map((decision) => commandOfScope(decision.scope)).filter(
        (command): command is string => command !== null,
      ),
    );
    const excluded = new Set(COMMAND_EXCLUSIONS.map((entry) => entry.command));
    const unclassified = slashCommands().filter(
      (command) => !flows.has(command) && !classified.has(command) && !excluded.has(command),
    );
    expect(unclassified).toEqual([]);
    // And the universe is real: five flows plus fourteen commands with no loop —
    // `discard` and `reset` joined it as transversal retirement (plan 024), and
    // `doctor` as the transversal diagnosis (plan 040).
    expect(slashCommands()).toHaveLength(19);
  });
});

describe("registro de autoridad — la migración cerró observable", () => {
  it("ningún recorrido decide ya nada desde la doctrina, y el vocabulario quedó cerrado", () => {
    // The closing claim, and the last of a series: this case named the survivors
    // after every cutover — QUICK's, then SPEC's, then the chassis' — down to the
    // nine the previous tranche left. There are none. Stated as an empty set over
    // the WHOLE registry rather than per scope, because "nothing left anywhere" is
    // what makes retiring the fallback safe rather than a hope.
    for (const scope of [...WORKLINE_FLOWS, CHASSIS_SCOPE]) {
      const left = decisionsOfScope(scope).filter((row) => row.ownership !== "cli-owned");
      expect(
        left.map((row) => row.id),
        scope,
      ).toEqual([]);
    }
    const left = FLOW_DECISIONS.filter((decision) => decision.ownership !== "cli-owned");
    expect(left.map((decision) => decision.id)).toEqual([]);
    // And the vocabulary itself closed, so the axis cannot be re-opened by a row:
    // a second value would have to be added here, in the open.
    expect(TRANSITION_OWNERSHIPS).toEqual(["cli-owned"]);
  });

  it("la migración se mide por DOCUMENTO, en las dos direcciones", () => {
    // The tranche is the document, not the scope. A rule stated in a document that
    // an undirected journey reads cannot be retired, so it cannot be migrated
    // either — that is what kept QUICK's five transversal rows behind until PLAN
    // cut over, and what kept the split gate back until this tranche found that
    // the gate's rows were carrying `spec-new`'s document by mistake. Both
    // directions are asserted: nothing outside the cut-over documents is migrated,
    // and nothing inside them is left behind.
    const inFlows = FLOW_DECISIONS.filter((decision) => flowOfScope(decision.scope) !== null);
    const migratedDocuments = new Set([
      QUICK_LOOP,
      "loops/spec-refine-loop/LOOP.md",
      "modules/SPEC-CHANGE-SHAPE.md",
      "modules/IDEATION-GATE.md",
      // PLAN's own seven…
      "loops/plan-new-loop/LOOP.md",
      "loops/plan-refine-loop/LOOP.md",
      "loops/plan-exec-loop/LOOP.md",
      "modules/PLAN-EXECUTION-BATCHES.md",
      "modules/PLAN-SPLIT-GATE.md",
      "modules/PLAN-REFINE-SPLIT.md",
      "modules/PLAN-INPUT.md",
      // …and the two the code-editing loops share, whose only readers are `quick`
      // and `plan-exec`. They travelled with PLAN because that is the run in which
      // their last legacy reader stopped being one.
      "loops/CODE-POLICIES.md",
      "modules/DB-SCRIPTS-ONLY.md",
    ]);
    // The four a shipped command owns rather than a tranche. Three predate the
    // tranches; `design-reuse` joined them in the closing one, attributed to
    // `aw designs` because what the CLI owns there is putting the inventory in
    // front of the judgment, not deciding it.
    const commandOwned = new Set([
      "spec-refine.design-publication",
      "spec-refine.design-reuse",
      "plan-new.numbering",
      "plan-exec.design-precondition",
    ]);

    const early = inFlows.filter(
      (decision) =>
        decision.ownership === "cli-owned" &&
        !commandOwned.has(decision.id) &&
        !migratedDocuments.has(decision.document),
    );
    expect(early.map((decision) => `${decision.id} → ${decision.document}`)).toEqual([]);

    const left = inFlows.filter(
      (decision) => decision.ownership !== "cli-owned" && migratedDocuments.has(decision.document),
    );
    expect(left.map((decision) => `${decision.id} → ${decision.document}`)).toEqual([]);

    // The one document that stayed behind, and it is not an oversight: nothing in
    // the registry points at it any more. `SPLIT-GATE.md` is `/w:spec-new`'s, a
    // command that starts no loop, so its rule was never the CLI's to take.
    expect(FLOW_DECISIONS.map((decision) => decision.document)).not.toContain(
      "modules/SPLIT-GATE.md",
    );
  });

  it("PLAN cierra sus tres recorridos enteros y las cinco filas compartidas de QUICK", () => {
    const counted = (scope: string, document: string): number =>
      decisionsOfScope(scope).filter(
        (decision) => decision.document === document && decision.ownership === "cli-owned",
      ).length;
    // Catorce desde el preview del arreglo: la fila que lo DECLARA (archivos,
    // intención y forma esperada del diff, proporcional a la tarea) y la que lo
    // aprueba por encima del mismo umbral que dispara el gate de entrada. Antes el
    // único gate humano sobre el arreglo era `quick.commit-authorization`, que
    // llega con el código ya en el árbol de trabajo: aprobaba el commit, no el
    // enfoque.
    expect(counted("quick", QUICK_LOOP)).toBe(14);
    // Diez desde que el guardado es una propuesta sellada: entra la fila que
    // entrega los bytes y la que los publica, y sale la promoción del status —
    // el sello viaja DENTRO de esos bytes, así que ya no es una escritura aparte.
    // Once, la que adopta el paquete de escalación que llega de una ejecución:
    // el destino declara lo que consume, y por eso volver deja de costar rehacer
    // el análisis.
    expect(counted("spec-refine", "loops/spec-refine-loop/LOOP.md")).toBe(11);
    expect(counted("spec-refine", "modules/IDEATION-GATE.md")).toBe(2);
    // PLAN's three journeys, whole — 49 rows, of which 10 are new: the eligibility
    // observation and its isolation rule in each of the three, refine's own split
    // signal, execution's entry-gap recognition, and the commit itself, which had
    // no row because approving one used to be the last thing the registry knew
    // about. And the five QUICK rows whose two shared documents only became
    // retirable here.
    const planScopes = ["plan-new", "plan-refine", "plan-exec"];
    const plan = planScopes.flatMap((scope) => decisionsOfScope(scope));
    // 49 + 4: cada uno de plan-new y plan-refine gana la fila que entrega los
    // bytes y la que los publica. `plan-refine.normalize-on-write` se fue: la
    // forma normalizada es una propiedad de los bytes propuestos, no una segunda
    // escritura del mismo documento.
    // 52 + 2, las dos de `plan-exec` que hacen del aislamiento un paso del
    // recorrido y no una regla que alguien recuerda: la que fija el plan y las
    // fuentes que la corrida edita, y la que adquiere su unidad en cada una antes
    // de la primera escritura.
    // 54 + 1, la que cierra ese aislamiento por el otro extremo: sin
    // `plan-exec.unit-integration` el recorrido terminaba informando "listo" sobre
    // commits que sólo existían en `aw/<sesión>`. Abrir la unidad y devolverla son
    // dos pasos del mismo recorrido, y ninguno de los dos puede ser una costumbre.
    // 55 + 3, las que hacen del gate de desviación una máquina y no sólo
    // doctrina: la que cierra las cuatro condiciones de elegibilidad, la que
    // empaqueta la escalación con su diagnóstico, y la que en `plan-refine`
    // declara haberla consumido. El propio `plan-exec.deviation-gate` ya estaba
    // en el registro: lo que le faltaba no era existir, era detenerse.
    // The manual pending-effects/task/state trio was replaced by one internal
    // v10 batch close, so the registry loses two rows without losing a route.
    expect(plan).toHaveLength(56);
    expect(plan.filter((decision) => decision.ownership !== "cli-owned")).toEqual([]);
    expect(counted("quick", "loops/CODE-POLICIES.md")).toBe(4);
    // Dos: la regla de scripts-only y la frontera que declara si hay base de datos
    // que gobernar. La segunda es la que permite que la primera se aplique sólo
    // donde tiene algo que hacer.
    expect(counted("quick", "modules/DB-SCRIPTS-ONLY.md")).toBe(2);
    // The four that used to be listed here as "still doctrine's" — three of the
    // split gate plus design reuse — are the ones the closing tranche took, and
    // they moved to the documents `spec-refine` actually reads.
    expect(counted("spec-refine", "modules/SPEC-CHANGE-SHAPE.md")).toBe(4);
    expect(counted("spec-refine", "modules/DESIGN-REFERENCES.md")).toBe(2);
  });
});

describe("registro de autoridad — source-bounded se pide donde se juzga", () => {
  /**
   * La regla: ninguna fase, tarea o gate puede NECESITAR producción ni el
   * producto desplegado para validarse. Dos planes reales quedaron trabados por
   * eso, y los dos eran incumplibles por construcción: nada en una corrida
   * aplica nada a producción.
   *
   * Viaja como evidencia de los tres gates que deciden si un documento procede,
   * porque ahí es donde ocurre el juicio: la respuesta devuelve un veredicto por
   * cada evidencia, así que la regla no puede disolverse en un «el checklist
   * pasó» genérico.
   */
  const SOURCE_BOUNDED = "workline.source-bounded";

  it.each([
    "quick.convergence-gate",
    "plan-new.coherence-gate",
    "plan-refine.executability-gate",
    "spec-refine.ready-gate",
    "plan-exec.entry-gate",
  ])("%s la exige junto a su checklist", (id) => {
    const decision = FLOW_DECISIONS.find((row) => row.id === id);
    expect(decision, id).toBeDefined();
    const action = actionOf(decision as (typeof FLOW_DECISIONS)[number]);
    expect(action?.evidence, id).toContain(SOURCE_BOUNDED);
    // Junto a, nunca en lugar de: el gate sigue pidiendo su checklist propio.
    expect((action?.evidence ?? []).length, id).toBeGreaterThan(1);
  });

  it("no la pide ninguna otra frontera: el juicio vive en los gates de cierre", () => {
    const asking = FLOW_DECISIONS.filter((decision) =>
      (actionOf(decision)?.evidence ?? []).includes(SOURCE_BOUNDED),
    ).map((decision) => decision.id);
    expect(asking.sort()).toEqual([
      "plan-exec.entry-gate",
      "plan-new.coherence-gate",
      "plan-refine.executability-gate",
      "quick.convergence-gate",
      "spec-refine.ready-gate",
    ]);
  });
});
