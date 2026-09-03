/**
 * `prepare`: el lote exacto que una persona va a aprobar, sellado y sin escribir.
 *
 * Sigue el molde que `discard`, `reset` y `reseal` ya comparten, y por las mismas
 * razones. El sello cubre TODO lo material —qué acciones, sobre qué recursos, en
 * qué orden, con qué clases de efecto y contra qué estado leído—, así que
 * cualquier cambio produce otro digest y un reintento idéntico no vuelve a
 * preguntar. Y la vista previa se DERIVA del objeto sellado en vez de guardarse
 * al lado: lo que se muestra y lo que se aplica tienen que salir de los mismos
 * bytes, o la vista previa es una segunda descripción del cambio que puede
 * discrepar con él.
 *
 * El `read_set` es el compare-and-swap: los archivos que se leyeron para decidir,
 * con su digest. `apply` los relee, y si alguno se movió entre la vista previa y
 * la aprobación, no aplica — porque el lote se armó sobre un estado que ya no
 * está.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import { SELF_AUTHORIZABLE_CLASSES } from "../../domain/capability/effects.js";
import type { DoctorAction, DoctorFinding, DoctorReport } from "../../domain/doctor/model.js";
import { doctorOperation } from "../../domain/doctor/operations.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { type DoctorRunDeps, type DoctorRunOptions, runDoctor } from "./report.js";

export interface DoctorBatchAction {
  /** El hallazgo que esta acción repara. Es lo que la selección nombra. */
  finding_id: string;
  host: string;
  /** El recurso, tal como el informe lo nombra. */
  resource: string;
  op: string;
  args: Record<string, string>;
  effects: string[];
  depends_on: string[];
  expected: string;
  /** El comando equivalente, para mostrar. Nunca se ejecuta como texto. */
  verb: string;
  summary: string;
  /**
   * El programa y sus argumentos de un flujo declarado, ya separados.
   *
   * Entra al sello: aprobar un lote que ejecuta un comando es aprobar sus tokens
   * exactos, y la vista previa los muestra desde acá para que lo que se aprueba
   * y lo que se corre salgan de los mismos bytes.
   */
  argv?: readonly string[];
  /**
   * Dónde vive el recurso, tal como su propio hallazgo lo declaró.
   *
   * Es material —forma parte de «sobre qué recursos»— y además es lo que deja
   * que el `read_set` de una operación pregunte por el archivo del recurso en vez
   * de por una constante por operación.
   */
  locator: string | null;
}

export interface DoctorReadSetEntry {
  id: string;
  digest: string;
}

export interface DoctorBatch {
  /** En orden topológico: una acción nunca va antes de la que depende. */
  actions: DoctorBatchAction[];
  /** La unión de las clases de efecto del lote, para lo que la aprobación cubre. */
  effects: string[];
  /**
   * Las clases que NO se autorizan solas: exactamente lo que la aprobación de
   * esta persona habilita.
   *
   * Se calcula con `SELF_AUTHORIZABLE_CLASSES`, la misma constante y el mismo
   * filtro que `decision-preview.ts` usa para sellar una propuesta. Escribir acá
   * una segunda regla de «qué necesita aprobación» sería el defecto que este plan
   * existe para cerrar, en el archivo que más caro lo pagaría.
   */
  requires_approval: string[];
}

export interface DoctorProposal {
  digest: string;
  batch: DoctorBatch;
  read_set: DoctorReadSetEntry[];
  preview: string[];
  /** El comando `apply` literal, con su digest y su selección. */
  next: string;
}

export interface DoctorPrepareListing {
  /** Sin selección no se sella nada: sólo se lista lo accionable. */
  actionable: DoctorBatchAction[];
  report: DoctorReport;
}

export type DoctorPrepareOutcome =
  | { ok: true; kind: "listing"; listing: DoctorPrepareListing }
  | { ok: true; kind: "sealed"; proposal: DoctorProposal; report: DoctorReport }
  | { ok: false; rejection: DoctorPrepareRejection };

export interface DoctorPrepareRejection {
  code: "SELECTION_UNKNOWN" | "SELECTION_NOT_ACTIONABLE" | "SELECTION_CYCLE";
  message: string;
  /** Los ids concretos que causaron el rechazo. Nunca una cuenta. */
  candidates: string[];
  action: string;
}

export interface DoctorPrepareInput extends DoctorRunOptions {
  /** Los ids de hallazgo que la persona eligió. Vacío = sólo listar. */
  select?: readonly string[];
}

export async function prepareDoctorBatch(
  ctx: CliContext,
  input: DoctorPrepareInput = {},
  deps: DoctorRunDeps = {},
): Promise<DoctorPrepareOutcome> {
  const report = await runDoctor(ctx, input, deps);
  const actionable = actionableOf(report);
  const select = [...(input.select ?? [])];
  if (select.length === 0) return { ok: true, kind: "listing", listing: { actionable, report } };

  const rejection = rejectSelection(select, report, actionable);
  if (rejection !== null) return { ok: false, rejection };

  const chosen = actionable.filter((action) => select.includes(action.finding_id));
  const ordered = topological(chosen);
  if (ordered === null) {
    return {
      ok: false,
      rejection: {
        code: "SELECTION_CYCLE",
        message: "las acciones seleccionadas dependen unas de otras en círculo",
        candidates: chosen.map((action) => action.finding_id),
        action: "quitá una de las acciones del ciclo y volvé a preparar",
      },
    };
  }

  const effects = effectsOf(ordered);
  const batch: DoctorBatch = {
    actions: ordered,
    effects,
    requires_approval: effects.filter(
      (effect) => !(SELF_AUTHORIZABLE_CLASSES as readonly string[]).includes(effect),
    ),
  };
  const readSet = readSetFor(ctx, ordered);
  // El sello cubre el lote Y el estado leído, y NADA que no sea material: sin
  // versión de CLI, sin marcas de tiempo, sin el informe entero. Dos corridas
  // sobre el mismo estado tienen que sellar igual, o «un reintento idéntico no
  // vuelve a preguntar» deja de ser cierto.
  const digest = semanticDigest({ batch, read_set: readSet });
  return {
    ok: true,
    kind: "sealed",
    report,
    proposal: {
      digest,
      batch,
      read_set: readSet,
      preview: previewOf(batch, readSet, digest),
      next: `aw doctor apply --approval ${digest}${ordered
        .map((action) => ` --select ${action.finding_id}`)
        .join("")}`,
    },
  };
}

/** Los hallazgos que el anotador dejó con acción, como acciones del lote. */
export function actionableOf(report: DoctorReport): DoctorBatchAction[] {
  const actions: DoctorBatchAction[] = [];
  for (const finding of report.findings) {
    const action = finding.remediation.action;
    if (finding.remediation.kind !== "supported" || action === null) continue;
    actions.push(toBatchAction(finding, action));
  }
  return actions;
}

function toBatchAction(finding: DoctorFinding, action: DoctorAction): DoctorBatchAction {
  const spec = doctorOperation(action.op);
  return {
    finding_id: finding.id,
    host: finding.host,
    resource: finding.resource.name,
    op: action.op,
    args: { ...action.args },
    effects: [...action.effects],
    depends_on: [...action.depends_on],
    expected: action.expected,
    verb: spec === null ? action.op : spec.verb(action.args),
    summary: spec === null ? finding.summary : spec.summary,
    locator: finding.resource.locator,
    ...(action.argv === undefined ? {} : { argv: [...action.argv] }),
  };
}

/**
 * Un id que no se puede seleccionar se rechaza NOMBRÁNDOLO, y antes de sellar.
 *
 * Las dos razones son distintas y la persona necesita la suya: el id no existe
 * en este informe (se escribió mal, o el estado cambió y el hallazgo ya no está)
 * o existe y no es accionable (es un recurso ajeno, o su remedio es manual). Un
 * rechazo que sólo dijera «selección inválida» obligaría a adivinar cuál de las
 * dos.
 */
function rejectSelection(
  select: readonly string[],
  report: DoctorReport,
  actionable: readonly DoctorBatchAction[],
): DoctorPrepareRejection | null {
  const known = new Set(report.findings.map((finding) => finding.id));
  const withAction = new Set(actionable.map((action) => action.finding_id));

  const unknown = select.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      code: "SELECTION_UNKNOWN",
      message: `este informe no tiene ${unknown.length === 1 ? "el hallazgo" : "los hallazgos"} ${unknown.join(", ")}`,
      candidates: unknown,
      action: "corré `aw doctor` y elegí un id de los que ese informe lista",
    };
  }
  const inert = select.filter((id) => !withAction.has(id));
  if (inert.length > 0) {
    return {
      code: "SELECTION_NOT_ACTIONABLE",
      message: `${inert.join(", ")} no tiene una reparación automatizable: su remedio es manual o el recurso no es de Workline`,
      candidates: inert,
      action: "leé la guía de ese hallazgo en `aw doctor`; seleccionalo sólo si propone una acción",
    };
  }
  return null;
}

/**
 * Orden topológico estable, y `null` ante un ciclo.
 *
 * Estable porque el orden es parte del sello: dos corridas sobre la misma
 * selección tienen que producir la misma secuencia, o el digest cambiaría sin
 * que nada material cambie. Se recorre en el orden en que el informe ya venía
 * —host, categoría, recurso— y una acción entra recién cuando entraron todas las
 * que nombra.
 */
function topological(actions: readonly DoctorBatchAction[]): DoctorBatchAction[] | null {
  const selected = new Set(actions.map((action) => action.finding_id));
  const placed = new Set<string>();
  const ordered: DoctorBatchAction[] = [];
  let pending = [...actions];

  while (pending.length > 0) {
    // Sólo cuentan las dependencias que están EN el lote: una acción que depende
    // de algo que nadie seleccionó no puede esperarlo para siempre.
    const ready = pending.filter((action) =>
      action.depends_on.every((id) => !selected.has(id) || placed.has(id)),
    );
    if (ready.length === 0) return null;
    for (const action of ready) {
      ordered.push(action);
      placed.add(action.finding_id);
    }
    pending = pending.filter((action) => !placed.has(action.finding_id));
  }
  return ordered;
}

function effectsOf(actions: readonly DoctorBatchAction[]): string[] {
  const classes = new Set<string>();
  for (const action of actions) for (const effect of action.effects) classes.add(effect);
  return [...classes].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Lo que se leyó para decidir, con su digest: el compare-and-swap del lote.
 *
 * Se lee por `node:fs` y no por el puerto a propósito: son archivos de los
 * HOSTS, fuera del workspace, que es donde el puerto vive. Un archivo ausente
 * entra igual con el digest `absent`, porque «no estaba» es un estado del que
 * también depende la decisión: si aparece entre la vista previa y la aprobación,
 * el lote se armó sobre otra realidad.
 */
function readSetFor(ctx: CliContext, actions: readonly DoctorBatchAction[]): DoctorReadSetEntry[] {
  const paths = new Set<string>();
  // Por el servicio de rutas y no por un `join` propio: una segunda forma de
  // decir dónde vive el registro es una que puede quedar apuntando a otro lado.
  paths.add(ctx.paths.userMcpConnectionsFile());
  for (const action of actions) {
    for (const target of targetsOf(ctx, action)) paths.add(target);
  }
  return [...paths]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((path) => ({ id: path, digest: digestOf(path) }));
}

function targetsOf(ctx: CliContext, action: DoctorBatchAction): string[] {
  const home = ctx.env.homeDir();
  const workspace = ctx.paths.workspaceDir();
  const scope = action.args.scope === "global" ? home : workspace;
  switch (action.op) {
    case "mcp.setup":
    case "mcp.remove":
    case "mcp.migrate":
      return [
        join(scope, ".mcp.json"),
        join(scope, ".claude.json"),
        join(scope, ".codex", "config.toml"),
      ];
    case "skills.reinstall":
      return [join(home, ".agents", "skills")];
    // Lo que se leyó para decidir que falta autenticar es el archivo que el
    // SUJETO declaró, no una ruta por operación: el proveedor de conexiones —el
    // dueño de `dsn.env`— declara `flow: null`, así que ninguna acción de flujo
    // puede ser suya y cablear su archivo acá sellaría bytes ajenos al recurso.
    // Un sujeto que no declara archivo no aporta ninguno: la otra mitad de su
    // estado es el entorno del proceso, que no tiene bytes que sellar — y por eso
    // una variable exportada entre la vista previa y la aprobación NO invalida el
    // digest; lo que la ataja es que el recurso pasa a reportar sano y `apply`
    // responde `already` en vez de correr un flujo que ya no hace falta.
    case "auth.flow":
      return action.locator === null ? [] : [action.locator];
    case "multiroot.attach":
    case "multiroot.detach":
      return [join(scope, ".claude", "settings.local.json"), join(scope, ".codex", "config.toml")];
    default:
      return [join(home, ".claude", "settings.json")];
  }
}

function digestOf(path: string): string {
  try {
    return semanticDigest(readFileSync(path, "utf-8"));
  } catch {
    return "absent";
  }
}

/**
 * La vista previa, derivada del objeto sellado.
 *
 * Cada línea sale del lote: si el lote cambia, la vista previa cambia con él, y
 * no hay forma de mostrar una cosa y aplicar otra. El digest va abajo porque es
 * lo que la persona aprueba.
 */
function previewOf(
  batch: DoctorBatch,
  readSet: readonly DoctorReadSetEntry[],
  digest: string,
): string[] {
  const lines = [`${batch.actions.length} acción(es), en este orden:`];
  batch.actions.forEach((action, index) => {
    lines.push(`  ${index + 1}. ${action.summary} — ${action.resource} (${action.host})`);
    lines.push(`     comando equivalente: ${action.verb}`);
    // Los tokens exactos, cuando la acción corre un programa: aprobar sin verlos
    // sería aprobar «un flujo», no ESTE flujo.
    if (action.argv !== undefined) {
      lines.push(`     se ejecutará, tal cual: ${action.argv.join(" ")}`);
    }
    lines.push(`     efectos: ${action.effects.join(", ")}`);
    if (action.depends_on.length > 0) {
      lines.push(`     después de: ${action.depends_on.join(", ")}`);
    }
    lines.push(`     estado esperado: ${action.expected}`);
  });
  lines.push(`efectos del lote: ${batch.effects.join(", ")}`);
  lines.push(
    batch.requires_approval.length === 0
      ? "nada de esto exige tu aprobación: todas las clases se autorizan solas"
      : `lo que tu aprobación habilita: ${batch.requires_approval.join(", ")}`,
  );
  lines.push(`estado leído para decidir: ${readSet.length} archivo(s)`);
  lines.push(`digest: ${digest}`);
  return lines;
}
