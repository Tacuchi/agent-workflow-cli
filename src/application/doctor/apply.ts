/**
 * `apply`: el único lugar de este comando que escribe, y lo hace después de
 * volver a mirar.
 *
 * Sigue el molde de `applyRetirement` porque el problema es el mismo: lo que una
 * persona aprobó fue una vista previa de un estado, y entre esa vista y el
 * primer byte el estado puede haberse movido. Así que bajo el candado se
 * RECOMPUTA la propuesta desde el estado vivo, se compara contra el digest
 * aprobado, se relee lo que se había leído para decidir, y recién entonces se
 * ejecuta. Confiar en el lote que produjo la vista previa sería autorizar un
 * estado que ya no existe.
 *
 * El `read_set` es el compare-and-swap, y NO tiene un chequeo aparte: el sello
 * de `prepare` cubre `{batch, read_set}`, así que un archivo que se movió entre
 * la vista previa y la aprobación produce otro `read_set`, otro digest, y el
 * rechazo por digest lo ataja. Hubo una guarda de frescura propia y se retiró
 * porque era inalcanzable por construcción: código que promete una verificación
 * que otra ya hizo es peor que no tenerlo, porque quien lo lee cree que hay dos.
 *
 * Y no hay atomicidad entre hosts: cada acción es su propio punto de
 * compromiso, como en `applyMigration`. Prometerla sería mentir — no se puede
 * deshacer una escritura en la configuración de un host de terceros porque la
 * siguiente falló. Lo que sí se promete es honestidad: una acción fallida omite
 * a las que dependían de ella CON su razón, deja seguir a las independientes, y
 * el lote se reporta parcial con el resultado individual de cada una.
 */
import type { CliContext } from "../../cli/types.js";
import type { DoctorFindingState, DoctorReport } from "../../domain/doctor/model.js";
import { redactSensitiveText } from "../../domain/redaction.js";
import { withCwdLock } from "../lock-service.js";
import {
  type DoctorBatch,
  type DoctorBatchAction,
  type DoctorPrepareInput,
  prepareDoctorBatch,
} from "./prepare.js";
import { type DoctorRunDeps, runDoctor } from "./report.js";

/** Cómo terminó UNA acción. `blocked` es de la operación de abajo, no una omisión. */
export type DoctorActionStatus = "applied" | "failed" | "skipped" | "blocked";

/** Qué dijo la recomprobación del recurso. `unverified` es el fail-closed. */
export type DoctorRecheckStatus = "resolved" | "pending" | "blocked" | "unverified";

export interface DoctorActionOutcome {
  status: Exclude<DoctorActionStatus, "skipped">;
  /** Lo que la operación devolvió, en una línea. Nunca un valor sensible. */
  detail: string;
}

export interface DoctorActionReport {
  finding_id: string;
  op: string;
  host: string;
  resource: string;
  status: DoctorActionStatus;
  /** Por qué falló, o de qué acción quedó colgada. `null` cuando aplicó. */
  reason: string | null;
  recheck: DoctorRecheckStatus;
  /** Lo que la recomprobación observó, para que el estado no sea una afirmación. */
  recheck_detail: string;
}

export type DoctorBatchStatus = "completed" | "partial" | "failed" | "already";

export interface DoctorApplyResult {
  status: DoctorBatchStatus;
  digest: string;
  actions: DoctorActionReport[];
  summary: { applied: number; failed: number; skipped: number; blocked: number; resolved: number };
  exit_code: 0 | 1;
  reason: string;
}

export interface DoctorApplyRejection {
  code:
    | "APPROVAL_REQUIRED"
    | "EVIDENCE_MISSING"
    | "SELECTION_UNKNOWN"
    | "SELECTION_NOT_ACTIONABLE"
    | "SELECTION_CYCLE"
    | "LOCK_BUSY";
  message: string;
  /** Los valores concretos en juego — los dos digests, o los ids. Nunca una cuenta. */
  candidates: string[];
  action: string;
}

export type DoctorApplyOutcome =
  | { ok: true; result: DoctorApplyResult }
  | { ok: false; rejection: DoctorApplyRejection };

/** Ejecuta UNA acción. Inyectable: las pruebas no escriben en la máquina de nadie. */
export type DoctorActionExecutor = (
  action: DoctorBatchAction,
  ctx: CliContext,
) => Promise<DoctorActionOutcome>;

export interface DoctorApplyDeps extends DoctorRunDeps {
  executor?: DoctorActionExecutor;
  /** Desactivable para probar que una recomprobación que NO corre queda `unverified`. */
  recheck?: boolean;
}

export interface DoctorApplyInput extends DoctorPrepareInput {
  /** El digest que la persona aprobó. Sin esto no se ejecuta nada. */
  approval?: string;
}

export async function applyDoctorBatch(
  ctx: CliContext,
  input: DoctorApplyInput,
  deps: DoctorApplyDeps = {},
): Promise<DoctorApplyOutcome> {
  if (input.approval === undefined || input.approval.length === 0) {
    return {
      ok: false,
      rejection: {
        code: "APPROVAL_REQUIRED",
        message: "no se ejecuta ninguna reparación sin la aprobación de su vista previa",
        candidates: [],
        action: "corré `aw doctor prepare --select …`, leé la vista previa y aprobá su digest",
      },
    };
  }

  const approved = { ...input, approval: input.approval };
  const locked = await withCwdLock(ctx.fs, ctx.paths, () => runUnderLock(ctx, approved, deps));
  if ("error" in locked) {
    return {
      ok: false,
      rejection: {
        code: "LOCK_BUSY",
        message: locked.error,
        candidates: [],
        action: "esperá a que se libere el lock del workspace y volvé a aplicar",
      },
    };
  }
  return locked;
}

async function runUnderLock(
  ctx: CliContext,
  // `approval` ya quedó comprobado por el llamador; el tipo lo dice acá para que
  // el rechazo pueda nombrar los DOS digests sin un `?? ""` que inventaría uno.
  input: DoctorApplyInput & { approval: string },
  deps: DoctorApplyDeps,
): Promise<DoctorApplyOutcome> {
  // 1 — la propuesta se computa OTRA VEZ, desde el estado vivo.
  const prepared = await prepareDoctorBatch(ctx, input, deps);
  if (!prepared.ok) {
    // Un rechazo de selección puede significar dos cosas muy distintas: que la
    // persona escribió mal el id, o que el recurso YA está arreglado y su
    // hallazgo desapareció. La segunda es un reintento del mismo digest sobre
    // algo que ya no tiene nada que hacer, y responder un error ahí haría que
    // repetir una aprobación se lea como un fallo.
    const settled = await alreadySettled(ctx, input, deps);
    if (settled !== null) return { ok: true, result: settled };
    return {
      ok: false,
      rejection: { ...prepared.rejection, candidates: prepared.rejection.candidates },
    };
  }
  if (prepared.kind === "listing") {
    return {
      ok: false,
      rejection: {
        code: "APPROVAL_REQUIRED",
        message: "no hay ninguna acción seleccionada: una aprobación sin selección no aprueba nada",
        candidates: [],
        action: "repetí la corrida con los mismos `--select` que produjeron ese digest",
      },
    };
  }

  const proposal = prepared.proposal;
  // 2 — lo aprobado tiene que ser lo que se aplicaría. Los DOS digests viajan en
  // el rechazo: sin ellos la persona no puede saber si cambió el estado o si
  // aprobó otra vista previa.
  if (proposal.digest !== input.approval) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        // Los dos digests van en el MENSAJE y no sólo en `candidates`, porque la
        // proyección humana de un rechazo imprime el código y el mensaje y nada
        // más: dejarlos únicamente en los detalles los publicaba en el JSON y los
        // escondía en la terminal, que es donde la persona está parada cuando
        // esto pasa. Y sin los dos no puede distinguir «aprobé otra vista previa»
        // de «el estado se movió».
        message: `lo aprobado no es lo que se aplicaría: cambió el lote, o cambió alguno de los archivos que se leyeron para decidirlo (aprobado ${input.approval}, vigente ${proposal.digest}). Volvé a correr \`prepare\`, leé la vista previa vigente y aprobá ese digest`,
        candidates: [input.approval, proposal.digest],
        action: "volvé a correr `prepare`, leé la vista previa vigente y aprobá ese digest",
      },
    };
  }

  // 3 — recién acá se toca la máquina.
  return { ok: true, result: await execute(ctx, input, proposal.batch, proposal.digest, deps) };
}

/**
 * Si el lote aprobado ya no tiene nada que hacer, decilo — y no como un error.
 *
 * Sólo cuenta como `already` cuando el hallazgo YA NO ESTÁ y su categoría se
 * pudo comprobar en este host. La ausencia de un hallazgo prueba algo únicamente
 * cuando alguien miró: si la cobertura de esa categoría quedó `unavailable` o
 * `skipped`, el recurso puede estar igual de roto y nadie lo sabe, y ahí `already`
 * sería exactamente la mentira que este modelo existe para no decir.
 */
async function alreadySettled(
  ctx: CliContext,
  input: DoctorApplyInput & { approval: string },
  deps: DoctorApplyDeps,
): Promise<DoctorApplyResult | null> {
  const select = [...(input.select ?? [])];
  if (select.length === 0) return null;
  const report = await runDoctor(ctx, input, deps);

  const settled: string[] = [];
  for (const id of select) {
    const how = settlementOf(report, id);
    if (how === null) return null;
    settled.push(how);
  }

  return {
    status: "already",
    digest: input.approval,
    actions: select.map((id, index) => ({
      finding_id: id,
      op: "—",
      host: id.split("/")[0] ?? "—",
      resource: id,
      // `skipped` y no `applied`: en esta corrida NO se ejecutó nada. Decir
      // «aplicada» sobre una acción que nadie corrió dejaba la proyección
      // afirmando «✔ <id>» debajo de un «Resumen: 0 aplicadas», que es la clase
      // de contradicción que hace dudar del informe entero.
      status: "skipped" as const,
      reason: "no se ejecutó: el recurso ya no reporta el problema",
      recheck: "resolved" as const,
      recheck_detail: settled[index] ?? "el recurso ya no reporta el problema",
    })),
    summary: {
      applied: 0,
      failed: 0,
      skipped: select.length,
      blocked: 0,
      resolved: select.length,
    },
    exit_code: 0,
    reason: "nada que hacer: los recursos aprobados ya no reportan el problema",
  };
}

/**
 * Por qué este recurso ya está saldado, o `null` si no lo está.
 *
 * Dos formas de estarlo, y las dos hacen falta. Un hallazgo que DESAPARECIÓ es
 * la obvia. La otra es el hallazgo que sigue ahí y ya no tiene nada que hacer:
 * los proveedores emiten el sano en vez de callarse —«no estaba mal» y «nadie
 * miró» son respuestas distintas—, así que arreglar el recurso a mano entre la
 * vista previa y la aprobación NO lo hace desaparecer, lo vuelve `healthy`. Sin
 * esta segunda forma, repetir una aprobación sobre algo que ya está bien
 * devolvía `SELECTION_NOT_ACTIONABLE` con salida 1: un error sobre un recurso
 * sano, y la promesa de que un reintento idéntico responde `already` sólo se
 * cumplía cuando el recurso dejaba de existir.
 *
 * Y las dos exigen lo mismo: que la categoría se haya COMPROBADO en este host.
 * La ausencia de un hallazgo prueba algo únicamente cuando alguien miró; si la
 * cobertura quedó `unavailable` o `skipped`, el recurso puede estar igual de
 * roto y nadie lo sabe.
 */
function settlementOf(report: DoctorReport, id: string): string | null {
  const finding = report.findings.find((candidate) => candidate.id === id);
  if (finding !== undefined) {
    const inert = finding.state === "healthy" && finding.remediation.action === null;
    if (!inert) return null;
  }
  const covered = coverageFor(report, id);
  if (!covered.ok) return null;
  return finding === undefined
    ? `el hallazgo ya no aparece y su categoría se comprobó en esta corrida (${covered.where})`
    : `el recurso ya reporta sano y no propone ninguna acción (${covered.where})`;
}

/**
 * Si alguien miró la categoría de este hallazgo en su host, y dónde lo dice.
 *
 * La misma pregunta la hacen dos caminos —el `already` y la recomprobación de
 * una acción cuyo hallazgo desapareció—, así que vive una sola vez. Un id que no
 * nombra host y categoría falla CERRADO: no se puede afirmar cobertura sobre algo
 * que no se puede ubicar.
 */
function coverageFor(
  report: DoctorReport,
  id: string,
): { ok: true; where: string } | { ok: false; why: string } {
  const parts = id.split("/");
  const host = parts[0];
  const category = parts[1];
  if (host === undefined || category === undefined || parts.length < 3) {
    return { ok: false, why: `el id '${id}' no nombra host y categoría` };
  }
  const entries = report.coverage.filter(
    (entry) => entry.category === category && (entry.host === host || entry.host === "workspace"),
  );
  const checked = entries.find((entry) => entry.state === "checked");
  if (checked !== undefined) return { ok: true, where: `${category} en ${checked.host}` };
  const gap = entries[0];
  return {
    ok: false,
    why:
      gap === undefined
        ? `la categoría ${category} no declaró cobertura para ${host}`
        : `la cobertura de ${category} en ${gap.host} quedó ${gap.state}: ${gap.reason ?? "sin razón declarada"}`,
  };
}

/**
 * El orden topológico ya viene del lote; acá se respeta y se registra.
 *
 * Una acción fallida no detiene al lote: marca `skipped` a todo lo que dependía
 * de ella —transitivamente, porque el dependiente de un omitido también queda
 * sin su precondición— y deja seguir a las independientes. Eso es lo que hace
 * que el resultado parcial sirva: la persona ve exactamente hasta dónde llegó.
 */
async function execute(
  ctx: CliContext,
  input: DoctorApplyInput,
  batch: DoctorBatch,
  digest: string,
  deps: DoctorApplyDeps,
): Promise<DoctorApplyResult> {
  const executor = deps.executor ?? realExecutor;
  const reports: DoctorActionReport[] = [];
  const failed = new Map<string, string>();

  for (const action of batch.actions) {
    const blocker = action.depends_on.find((id) => failed.has(id));
    if (blocker !== undefined) {
      failed.set(action.finding_id, `quedó sin su precondición: ${blocker}`);
      reports.push({
        ...identity(action),
        status: "skipped",
        reason: `no se ejecutó porque ${blocker} no aplicó`,
        recheck: "unverified",
        recheck_detail: "no se recomprobó: la acción no llegó a correr",
      });
      continue;
    }

    const outcome = await run(executor, action, ctx);
    if (outcome.status !== "applied") {
      failed.set(action.finding_id, outcome.detail);
      reports.push({
        ...identity(action),
        status: outcome.status,
        reason: outcome.detail,
        recheck: outcome.status === "blocked" ? "blocked" : "unverified",
        recheck_detail:
          outcome.status === "blocked"
            ? "la operación se declaró bloqueada: el recurso queda como estaba"
            : "no se recomprobó: la acción no aplicó",
      });
      continue;
    }

    const recheck = await recheckOf(ctx, input, action, deps);
    reports.push({ ...identity(action), status: "applied", reason: null, ...recheck });
  }

  return summarize(digest, reports);
}

function identity(action: DoctorBatchAction) {
  return {
    finding_id: action.finding_id,
    op: action.op,
    host: action.host,
    resource: action.resource,
  };
}

/** Un ejecutor que lanza es una acción FALLIDA, nunca una corrida caída. */
async function run(
  executor: DoctorActionExecutor,
  action: DoctorBatchAction,
  ctx: CliContext,
): Promise<DoctorActionOutcome> {
  try {
    return await executor(action, ctx);
  } catch (error) {
    // El mensaje de una excepción es el único texto de este resultado que no
    // viene del informe ya redactado, y `run` existe justamente para atrapar lo
    // que nadie previó — así que puede traer cualquier cosa. El comando devuelve
    // siempre `ok:true` (el veredicto va en el exit code), y la última línea de
    // defensa del CLI sólo redacta la rama de error: acá no hay nadie más abajo.
    return {
      status: "failed",
      detail: redactSensitiveText(`la operación lanzó: ${messageOf(error)}`),
    };
  }
}

/**
 * La recomprobación: el MISMO proveedor releyendo el recurso.
 *
 * Nunca se deduce del resultado de la operación. Una operación que devolvió
 * «apliqué» y un recurso que quedó sano son dos hechos distintos, y presentar el
 * primero como el segundo es exactamente la validación omitida que AC-12
 * prohíbe. Y una recomprobación que no corrió o que falló queda `unverified`,
 * jamás `resolved`.
 *
 * Corre con el ALCANCE de la corrida —los mismos `--host`, `--only` y
 * `--skip-native` que la persona pidió— y no con opciones inventadas acá. No es
 * cosmético: `--skip-native` existe porque inspeccionar los MCP nativos LANZA los
 * servidores del host, y una recomprobación que lo descartara volvería a hacer,
 * una vez por acción aplicada, exactamente la sonda que la persona declinó.
 *
 * Y pide VERIFICAR, no sólo releer: eso es lo que hace que «quedó resuelto»
 * dependa de la observación del proveedor y no del código de salida del programa.
 * La autorización con la que verifica es EXACTAMENTE la que la persona dio en la
 * invocación, nunca más: pedir un vacío significa «verificá hasta donde puedas
 * sin permisos extra», y cada proveedor degrada lo que no alcance diciéndolo.
 *
 * Y no se amplía con las clases de la acción, aunque estén aprobadas. Una acción
 * aprobada con `network_external` autoriza a ESA acción a salir de la máquina, no
 * a la relectura del entorno entero: la verificación de un informe no tiene
 * alcance por sujeto, así que sumar esa clase acá conectaría contra todas las
 * credenciales registradas para recomprobar una.
 */
async function recheckOf(
  ctx: CliContext,
  input: DoctorApplyInput,
  action: DoctorBatchAction,
  deps: DoctorApplyDeps,
): Promise<{ recheck: DoctorRecheckStatus; recheck_detail: string }> {
  if (deps.recheck === false) {
    return { recheck: "unverified", recheck_detail: "la recomprobación quedó desactivada" };
  }
  const verify = [...(input.verify ?? [])];
  let report: DoctorReport;
  try {
    report = await runDoctor(ctx, { ...input, verify }, deps);
  } catch (error) {
    return {
      recheck: "unverified",
      recheck_detail: redactSensitiveText(`la recomprobación no pudo correr: ${messageOf(error)}`),
    };
  }
  const finding = report.findings.find((candidate) => candidate.id === action.finding_id);
  if (finding === undefined) {
    // Que el hallazgo no esté NO prueba nada por sí solo: prueba algo cuando
    // alguien miró. Si la categoría de ese hallazgo quedó sin comprobar en este
    // host —un proveedor que se cayó durante la relectura se lleva TODOS sus
    // hallazgos—, declarar `resolved` sería exactamente la validación omitida
    // presentada como superada que AC-12 prohíbe.
    const covered = coverageFor(report, action.finding_id);
    return covered.ok
      ? {
          recheck: "resolved",
          recheck_detail: `el hallazgo ya no aparece en el informe (${covered.where})`,
        }
      : {
          recheck: "unverified",
          recheck_detail: `el hallazgo no aparece, pero nadie lo comprobó: ${covered.why}`,
        };
  }
  return { ...classify(finding.state), recheck_detail: `el informe lo reporta ${finding.state}` };
}

function classify(state: DoctorFindingState): { recheck: DoctorRecheckStatus } {
  if (state === "healthy") return { recheck: "resolved" };
  if (state === "unverified") return { recheck: "unverified" };
  if (state === "blocking") return { recheck: "blocked" };
  return { recheck: "pending" };
}

/**
 * El veredicto del lote, y el exit code sale de él.
 *
 * `completed` exige las dos cosas: que todas aplicaran Y que todas se
 * recomprobaran resueltas. Un lote donde todo aplicó pero algo quedó `pending`
 * no está completo — el recurso sigue reportando el problema, y llamarlo
 * completo sería declarar resuelto algo que nadie verificó.
 */
function summarize(digest: string, actions: DoctorActionReport[]): DoctorApplyResult {
  const count = (status: DoctorActionStatus): number =>
    actions.filter((action) => action.status === status).length;
  const applied = count("applied");
  const resolved = actions.filter((action) => action.recheck === "resolved").length;
  const summary = {
    applied,
    failed: count("failed"),
    skipped: count("skipped"),
    blocked: count("blocked"),
    resolved,
  };

  if (applied === 0) {
    return {
      status: "failed",
      digest,
      actions,
      summary,
      exit_code: 1,
      reason: "ninguna acción del lote llegó a aplicarse",
    };
  }
  if (applied === actions.length && resolved === actions.length) {
    return {
      status: "completed",
      digest,
      actions,
      summary,
      exit_code: 0,
      reason: "todas las acciones aplicaron y su recomprobación las declara resueltas",
    };
  }
  return {
    status: "partial",
    digest,
    actions,
    summary,
    exit_code: 1,
    reason: `${applied} de ${actions.length} aplicaron; el resto falló, quedó omitido o sin recomprobación concluyente`,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * El ejecutor real: cada operación llama a la función que YA sabe escribir.
 *
 * Se construye un `ParsedArgs` explícito para las que lo esperan, campo por
 * campo — nunca parseando una cadena. El `verb` del catálogo existe para
 * MOSTRAR; ejecutar una reparación pasando su texto a un shell sería una
 * inyección esperando el nombre de recurso equivocado, y los nombres de este
 * informe vienen de archivos que escribió otra persona.
 */
export const realExecutor: DoctorActionExecutor = async (action, ctx) => {
  const { runDoctorRepair } = await import("./repair-runner.js");
  return runDoctorRepair(action, ctx);
};
