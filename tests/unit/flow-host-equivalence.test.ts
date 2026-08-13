import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionDigest, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { canonicalJson } from "../../src/application/semantic-operation/protocol.js";
import {
  type DelegatedAction,
  type FlowDecision,
  effectsOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import {
  FLOW_DIRECTIVE_KEYS,
  type FlowBoundaryKind,
  type FlowDirective,
  renderDirectiveHuman,
} from "../../src/domain/flow/directive.js";
import { FLOW_RUN_STATE_FILE } from "../../src/domain/flow/run-state.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

// La equivalencia se afirma cruzando TODAS las clases de frontera, y sobre las
// filas vivas la custodia de la corrida dejó al QUICK sin ninguna
// `authorization`. El flip la restituye despojando la custodia — mismo
// movimiento que `flow-effects.test.ts` — para que la clase siga recorrida sin
// inventar filas: el sujeto de este archivo es la equivalencia entre hosts, no
// qué filas piden preflight.
vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  return {
    ...real,
    journeyOfFlow: (flow: string) =>
      real
        .journeyOfFlow(flow as Parameters<typeof real.journeyOfFlow>[0])
        .map((row) => ({ ...row, custody: undefined })),
  };
});

/**
 * La misma frontera en cualquier host, y reanudable sin la conversación.
 *
 * Lo que se prueba acá no es que dos hosts «se pongan de acuerdo»: es que **no
 * hay nada sobre lo que puedan discrepar**. La directiva se deriva del estado
 * persistido y del recorrido, y el host no entra en esa derivación por ninguna
 * puerta — no hay campo de host en el protocolo, ningún módulo del motor lee el
 * entorno ni el catálogo de hosts, y lo único que un host aporta al comando es la
 * identidad de su conversación, que direcciona la sesión y nada más.
 *
 * Por eso la equivalencia se afirma de dos maneras distintas y las dos hacen
 * falta. Por **comportamiento**: dos corridas con el mismo estado y las mismas
 * entradas devuelven la misma directiva byte a byte, sello y descriptor de
 * ejecución incluidos, y la respuesta redactada contra una la acepta la otra. Y
 * por **construcción**: si mañana alguien agrega una rama por host, el guardián
 * estructural la caza aunque el fixture siga verde, porque un fixture solo mide
 * los hosts que alguien se acordó de simular.
 *
 * La reanudación es la otra mitad de la fase, y es la que dice qué carga el
 * estado: un recorrido detenido en una frontera lo levanta otra conversación —
 * incluso una que no existía cuando se detuvo— reconstruyendo frontera, acción y
 * continuación desde el archivo, sin nada de la conversación original.
 *
 * **Alcance de esta evidencia (declarado, no insinuado):** esto es fixture. Los
 * recorridos reales conducidos en Codex y en Kimi son evidencia aparte y viven en
 * el informe de la fase; los demás hosts del catálogo quedan cubiertos solo por
 * fixture, que es exactamente lo que el último guardián de este archivo delimita.
 */

const fs = new NodeFileSystem();
const SRC = resolve(__dirname, "..", "..", "src");
const SESSION = "058-equivalencia-entre-hosts-quick";
const CODE = "058";
const JOURNEY = journeyOfFlow("quick");

/** Una conversación de host: su workspace, y el id que ese host inyecta. */
interface Conversation {
  paths: PathsService;
  workdir: string;
  contextId: string;
}

async function openWorkspace(label: string, contextId: string): Promise<Conversation> {
  const workdir = await mkdtemp(join(tmpdir(), `aw-host-${label}-`));
  const paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
  await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
  await writeFile(
    join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
    "# SESSION — equivalencia entre hosts\n\n## Objective\ndirigir un QUICK desde dos hosts\n",
    "utf8",
  );
  return { paths, workdir, contextId };
}

/** Otra conversación sobre el MISMO workspace: dos hosts, una sola corrida. */
function otherConversation(host: Conversation, contextId: string): Conversation {
  return { ...host, contextId };
}

async function boundaryOf(host: Conversation) {
  const read = await readRun(fs, locateRun(host.paths, SESSION));
  if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
  return { state: read.state, resolved: resolveBoundary(read.state, JOURNEY) };
}

type Resolved = Awaited<ReturnType<typeof boundaryOf>>["resolved"];

/** La salida real que exige una frontera de ejecución — nunca una confirmación. */
function resultFor(resolved: Resolved, stopped: FlowDecision): Record<string, unknown> {
  const action = resolved.action;
  if (action === null) throw new Error("una frontera de ejecución sin invocación");
  const declared = effectsOf(stopped);
  return {
    input_digest: resolved.seal,
    outcome: "completed",
    invocation: action.invocation,
    validations: action.evidence.map((id) => ({ id, passed: true, detail: `salida de ${id}` })),
    effects: { planned: [...declared], approved: [], applied: [...declared] },
    output: null,
  };
}

/**
 * La respuesta que admite la frontera vigente — función PURA de la directiva.
 *
 * Que sea pura es la mitad del experimento: los dos hosts redactan la misma
 * respuesta porque leen la misma frontera, no porque el test se las dicte. En la
 * frontera semántica declara el vocabulario entero de la fila, y eso es
 * deliberado: con señales de verdad los umbrales disparan y el recorrido cruza
 * también sus pasos condicionales, en vez de saltearlos todos y medir la
 * equivalencia sobre la mitad del camino.
 */
function answerFor(
  resolved: Resolved,
  stopped: FlowDecision,
): { body: Record<string, unknown>; approval: string | null } {
  if (resolved.kind === "execution") {
    return { body: resultFor(resolved, stopped), approval: null };
  }
  if (resolved.kind === "authorization") {
    return {
      body: { input_digest: resolved.seal, choice: "Autorizar el efecto" },
      approval: effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? []),
    };
  }
  if (resolved.kind === "semantic") {
    return {
      body: {
        input_digest: resolved.seal,
        signals: [...(stopped.signals ?? [])],
        decisions: { paso: stopped.id },
      },
      approval: null,
    };
  }
  return {
    body: { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" },
    approval: null,
  };
}

/**
 * Un paso del recorrido: la frontera que se leyó y la directiva que devolvió.
 *
 * Las dos cosas, y no una: `directive` es lo que el submit trajo DESPUÉS de
 * contestar, o sea la frontera siguiente. Lo que la frontera contestada emitió
 * —su acción y su sello— hay que guardarlo cuando se la lee, o se termina
 * comparando el descriptor de ejecución de otro paso.
 */
interface Step {
  kind: FlowBoundaryKind;
  transition: string;
  action: DelegatedAction | null;
  seal: string;
  directive: FlowDirective;
}

async function adopt(host: Conversation): Promise<FlowDirective> {
  const adopted = await advanceFlow(fs, host.paths, {
    code: CODE,
    contextId: host.contextId,
    flow: "quick",
    adopt: true,
  });
  if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
  return adopted.directive;
}

/** Contestar la frontera vigente y devolver la directiva que vuelve. */
async function answerCurrent(host: Conversation): Promise<Step | null> {
  const { resolved } = await boundaryOf(host);
  if (resolved.kind === "final") return null;
  const stopped = resolved.stopped as FlowDecision;
  expect(resolved.error, stopped.id).toBeNull();
  const { body, approval } = answerFor(resolved, stopped);
  const sent = await submitFlow(fs, host.paths, {
    code: CODE,
    contextId: host.contextId,
    raw: JSON.stringify(body),
    approval,
  });
  if (!sent.ok) throw new Error(`un rechazo de negocio viaja ok:true (${stopped.id})`);
  return {
    kind: resolved.kind,
    transition: stopped.id,
    action: resolved.action,
    seal: resolved.seal,
    directive: sent.directive,
  };
}

/** El recorrido entero, paso por paso, hasta el final. */
async function walk(host: Conversation, limit = 40): Promise<Step[]> {
  const steps: Step[] = [];
  for (let index = 0; index < limit; index += 1) {
    const step = await answerCurrent(host);
    if (step === null) return steps;
    steps.push(step);
  }
  throw new Error("el recorrido nunca llegó al final");
}

describe("dos hosts con el mismo estado reciben la misma directiva", () => {
  let claude: Conversation;
  let codex: Conversation;

  beforeEach(async () => {
    claude = await openWorkspace("claude", "conv-claude-7f2a");
    codex = await openWorkspace("codex", "conv-codex-91bd");
  });

  afterEach(async () => {
    await rm(claude.workdir, { recursive: true, force: true });
    await rm(codex.workdir, { recursive: true, force: true });
  });

  it("el recorrido entero devuelve directivas idénticas byte a byte", async () => {
    expect(canonicalJson(await adopt(claude))).toBe(canonicalJson(await adopt(codex)));

    const here = await walk(claude);
    const there = await walk(codex);

    expect(there.map((step) => step.transition)).toEqual(here.map((step) => step.transition));
    for (const [index, step] of here.entries()) {
      const twin = there[index] as Step;
      expect(canonicalJson(step.directive), step.transition).toBe(canonicalJson(twin.directive));
    }

    // Sin esto la igualdad sería vacía: dos recorridos que nunca se detienen en
    // nada coinciden trivialmente. Las cuatro clases de frontera que el motor
    // puede emitir con una respuesta esperándolas tienen que haber aparecido.
    const crossed = new Set(here.map((step) => step.kind));
    for (const kind of ["semantic", "human", "authorization", "execution"] as const) {
      expect(crossed.has(kind), `ninguna frontera '${kind}' en el recorrido`).toBe(true);
    }
  });

  it("el descriptor de ejecución y su sello son los mismos en los dos", async () => {
    await adopt(claude);
    await adopt(codex);
    const here = await walk(claude);
    const there = await walk(codex);

    const actions = [...here.entries()].filter(([, step]) => step.kind === "execution");
    expect(actions.length).toBeGreaterThan(0);
    for (const [index, step] of actions) {
      // Emparejados por POSICIÓN, no por id: una transición con efecto se visita
      // dos veces —primero para autorizar el efecto, después para ejecutarla— y
      // buscarla por nombre devuelve la frontera de autorización, que no emite
      // ninguna acción. Es la forma correcta y el emparejamiento tiene que verla.
      const twin = there[index] as Step;
      expect(twin?.transition, step.transition).toBe(step.transition);
      expect(twin.kind, step.transition).toBe("execution");
      const emitted = step.action;
      if (emitted === null) throw new Error(`${step.transition} sin invocación`);
      // Programa, argumentos, target, input y evidencia exigida: los cinco que el
      // sello de la acción cubre. Y el sello mismo, que es lo que hace que un
      // resultado escrito en un host valga contra la corrida del otro.
      expect(canonicalJson(twin.action), step.transition).toBe(canonicalJson(emitted));
      expect(actionDigest(twin.action as DelegatedAction), step.transition).toBe(
        actionDigest(emitted),
      );
      expect(twin.seal, step.transition).toBe(step.seal);
    }
  });

  it("la respuesta redactada contra un host la acepta el otro", async () => {
    await adopt(claude);
    await adopt(codex);

    // Redactada UNA sola vez, contra la frontera de claude, y enviada a las dos
    // corridas. Si el sello dependiera del host, la segunda la rechazaría por
    // vencida — que es exactamente el modo de falla que esta fase descarta.
    const { resolved } = await boundaryOf(claude);
    const stopped = resolved.stopped as FlowDecision;
    const { body, approval } = answerFor(resolved, stopped);
    const raw = JSON.stringify(body);

    const mine = await submitFlow(fs, claude.paths, {
      code: CODE,
      contextId: claude.contextId,
      raw,
      approval,
    });
    const theirs = await submitFlow(fs, codex.paths, {
      code: CODE,
      contextId: codex.contextId,
      raw,
      approval,
    });
    if (!mine.ok || !theirs.ok) throw new Error("la misma respuesta tiene que valer en los dos");
    expect(canonicalJson(theirs.directive)).toBe(canonicalJson(mine.directive));
  });

  it("la presentación humana se deriva de la directiva, así que tampoco difiere", async () => {
    // El mecanismo con que cada host la muestra sí varía —eso vive en la matriz
    // de binding—, pero el CONTENIDO sale de un solo proyector derivado.
    const mine = await adopt(claude);
    const theirs = await adopt(codex);
    expect(renderDirectiveHuman(theirs)).toBe(renderDirectiveHuman(mine));
  });
});

describe("una frontera detenida se reanuda desde otro host", () => {
  let started: Conversation;
  let resumed: Conversation;

  beforeEach(async () => {
    started = await openWorkspace("resume", "conv-original-3ce1");
    resumed = otherConversation(started, "conv-otra-8a40");
  });

  afterEach(async () => {
    await rm(started.workdir, { recursive: true, force: true });
  });

  /** Detener la corrida en la primera frontera de la clase pedida. */
  async function stopAt(kind: FlowBoundaryKind): Promise<Resolved> {
    await adopt(started);
    for (let index = 0; index < 40; index += 1) {
      const { resolved } = await boundaryOf(started);
      if (resolved.kind === kind) return resolved;
      if (resolved.kind === "final") break;
      if ((await answerCurrent(started)) === null) break;
    }
    throw new Error(`el recorrido nunca se detuvo en una frontera '${kind}'`);
  }

  it("el estado persistido reconstruye frontera, acción y continuación", async () => {
    const left = await stopAt("execution");

    // Otra conversación, sobre el mismo workspace: nada de la primera viaja.
    const picked = await advanceFlow(fs, resumed.paths, {
      code: CODE,
      contextId: resumed.contextId,
      adopt: false,
    });
    if (!picked.ok) throw new Error("esperaba reanudar la corrida desde el otro host");

    const emitted = left.action;
    if (emitted === null) throw new Error("una frontera de ejecución sin invocación");

    expect(picked.directive.boundary.transition).toBe(left.stopped?.id);
    expect(picked.directive.boundary.kind).toBe("execution");
    expect(canonicalJson(picked.directive.action)).toBe(canonicalJson(emitted));
    expect(picked.directive.state_digest).toBe(left.seal);
    expect(picked.directive.next_action).toContain(emitted.invocation.program);
    // La acción pendiente que el estado guarda es la que la directiva reemitió:
    // un host que reanudara reconstruyendo OTRA invocación pediría correr algo
    // que el sello de la corrida no cubre.
    const { state } = await boundaryOf(resumed);
    expect(state.pending_action?.digest).toBe(actionDigest(emitted));
  });

  it("la directiva no cambia por el cambio de host, salvo la traza de la invocación", async () => {
    const before = await advanceFlow(fs, started.paths, {
      code: CODE,
      contextId: started.contextId,
      flow: "quick",
      adopt: true,
    });
    if (!before.ok) throw new Error("esperaba adoptar la corrida");
    const after = await advanceFlow(fs, resumed.paths, {
      code: CODE,
      contextId: resumed.contextId,
      adopt: false,
    });
    if (!after.ok) throw new Error("esperaba reanudar la corrida");

    // `applied` es lo que ESTA invocación aplicó, por contrato — el host que
    // reanuda no aplicó nada, y decir lo contrario sería inventarle una traza.
    // Todo lo demás es la frontera, y la frontera no se mueve.
    const { applied: appliedBefore, ...beforeRest } = before.directive;
    const { applied: appliedAfter, ...afterRest } = after.directive;
    expect(canonicalJson(afterRest)).toBe(canonicalJson(beforeRest));
    expect(appliedBefore.length).toBeGreaterThan(0);
    expect(appliedAfter).toEqual([]);
  });

  it("la respuesta que dejó escrita el host original la aplica el que reanuda", async () => {
    const left = await stopAt("human");
    const stopped = left.stopped as FlowDecision;
    const { body, approval } = answerFor(left, stopped);

    // Redactada en la conversación que ya no está, enviada por la que llegó
    // después: el sello es de la frontera, no de quien la leyó.
    const sent = await submitFlow(fs, resumed.paths, {
      code: CODE,
      contextId: resumed.contextId,
      raw: JSON.stringify(body),
      approval,
    });
    if (!sent.ok) throw new Error("la respuesta de la otra conversación tenía que valer");
    expect(sent.directive.error).toBeNull();
    expect(sent.directive.applied.map((step) => step.transition)).toContain(stopped.id);
  });

  it("el recorrido llega al final desde el host que reanudó", async () => {
    await stopAt("authorization");
    const rest = await walk(resumed);
    expect(rest.length).toBeGreaterThan(0);
    const { resolved } = await boundaryOf(resumed);
    expect(resolved.kind).toBe("final");
    expect(resolved.error).toBeNull();
  });
});

describe("la conversación original ya no está disponible", () => {
  let started: Conversation;

  beforeEach(async () => {
    started = await openWorkspace("gone", "conv-que-se-perdio-0d5f");
  });

  afterEach(async () => {
    await rm(started.workdir, { recursive: true, force: true });
  });

  it("el estado de corrida no guarda ningún rastro de la conversación", async () => {
    await adopt(started);
    await answerCurrent(started);
    const raw = await readFile(
      join(started.paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE),
      "utf8",
    );
    // Si el archivo nombrara la conversación, reanudar desde otra sería reanudar
    // una corrida que dice pertenecer a alguien que ya no está.
    expect(raw).not.toContain(started.contextId);
  });

  it("una conversación nueva, sin código ni asociación previa, levanta la corrida", async () => {
    const left = await adopt(started);
    // Ni `--session` ni binding: la sesión activa única es la que resuelve, que
    // es el caso real de abrir otro host y escribir `aw flow advance`.
    const fresh = await advanceFlow(fs, started.paths, {
      contextId: "conv-recien-nacida-b612",
      adopt: false,
    });
    if (!fresh.ok) throw new Error("esperaba resolver por sesión activa única");
    expect(fresh.directive.boundary.transition).toBe(left.boundary.transition);
    expect(fresh.directive.state_digest).toBe(left.state_digest);
    expect(fresh.directive.next_action).toBe(left.next_action);
  });

  it("sin ninguna identidad de conversación la corrida sigue igual", async () => {
    const left = await adopt(started);
    const anonymous = await advanceFlow(fs, started.paths, { adopt: false });
    if (!anonymous.ok) throw new Error("esperaba avanzar sin identidad de conversación");
    expect(anonymous.directive.boundary.transition).toBe(left.boundary.transition);
    expect(anonymous.directive.state_digest).toBe(left.state_digest);
  });
});

describe("la equivalencia no es un acuerdo entre hosts: no hay entrada de host", () => {
  it("el protocolo de la directiva no tiene ningún campo de host", () => {
    const keys = new Set<string>(FLOW_DIRECTIVE_KEYS);
    for (const field of ["host", "harness", "surface", "presentation"]) {
      expect(keys.has(field), field).toBe(false);
    }
  });

  it("ningún módulo del motor lee el entorno ni el catálogo de hosts", async () => {
    // El fixture mide los hosts que alguien simuló. Esto mide los que no: una
    // rama por host agregada mañana rompe acá aunque el fixture siga verde.
    const modules = [
      "domain/flow/authority.ts",
      "domain/flow/authorization.ts",
      "domain/flow/answer.ts",
      "domain/flow/directive.ts",
      "domain/flow/rules.ts",
      "domain/flow/run-state.ts",
      "application/flow/advance.ts",
      "application/flow/flow-service.ts",
      "application/flow/submit.ts",
      "application/flow/run-state-service.ts",
      "application/flow/run-projection.ts",
    ];
    const forbidden = [/process\.env/, /EnvPort/, /harnesses\.js/, /detectHarness/, /HARNESSES/];
    for (const rel of modules) {
      const body = await readFile(join(SRC, rel), "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${rel} → ${pattern}`).toBe(false);
      }
    }
  });

  it("ningún host del catálogo aparece nombrado en el motor", async () => {
    const body = (
      await Promise.all(
        ["domain/flow", "application/flow"].map(async (dir) => {
          const files = await readdir(join(SRC, dir));
          const bodies = await Promise.all(
            files
              .filter((name) => name.endsWith(".ts"))
              .map((name) => readFile(join(SRC, dir, name), "utf8")),
          );
          return bodies.join("\n");
        }),
      )
    ).join("\n");
    for (const spec of HARNESSES) {
      // El id entre comillas es la forma que importa —una rama por host se
      // escribe comparando contra el literal— y la etiqueta cubre la variante en
      // prosa. Con límite de palabra: `Oz` como subcadena suelta daría falsos
      // positivos y un guardián que grita sin motivo se termina desactivando.
      expect(body, spec.id).not.toContain(`"${spec.id}"`);
      expect(new RegExp(`\\b${spec.label}\\b`).test(body), spec.label).toBe(false);
    }
  });

  it("lo único que el host aporta al comando es la identidad de su conversación", async () => {
    const command = await readFile(join(SRC, "cli/commands/flow.ts"), "utf8");
    // Y esa identidad direcciona la sesión: entra al resolver junto al código,
    // nunca al motor. Un segundo dato tomado del entorno sería una entrada de
    // host por la puerta de atrás.
    expect(command).toContain("readContextId(ctx.env)");
    // Lo que el guardián refuta es una LECTURA del entorno que no sea esa: una
    // variable consultada acá sería la rama por host entrando por la puerta de
    // atrás. Pasarle el port a un servicio no lo es —todos los servicios reciben
    // sus ports— y por eso lo prohibido es el acceso, no la mención.
    expect(command).not.toMatch(/ctx\.env\./);
    expect(command).toContain("contextId");
  });
});
