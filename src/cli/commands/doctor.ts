/**
 * `aw doctor` — one contextual diagnosis over every host this machine has.
 *
 * The output convention here is `plugin-doctor`'s and not `mcp doctor`'s, on
 * purpose: the runtime never calls `renderHuman` when a result is `ok: false`
 * (`main.ts`), so a doctor that reported blocking as a failed result would print
 * one error line exactly when the person most needs the whole report. So the
 * result is always `ok: true`, and THE EXIT CODE CARRIES THE VERDICT — with the
 * verdict repeated inside `data` so the JSON is self-sufficient.
 */
import { type DoctorApplyResult, applyDoctorBatch } from "../../application/doctor/apply.js";
import {
  type DoctorPrepareListing,
  type DoctorProposal,
  prepareDoctorBatch,
} from "../../application/doctor/prepare.js";
import { type DoctorRunOptions, runDoctor } from "../../application/doctor/report.js";
import type { DoctorReport } from "../../domain/doctor/model.js";
import { DOCTOR_CATEGORIES } from "../../domain/doctor/model.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

const STATE_MARK: Record<string, string> = {
  healthy: "✔",
  warning: "!",
  blocking: "✘",
  unverified: "?",
};

const COVERAGE_LABEL: Record<string, string> = {
  checked: "comprobada",
  "not-applicable": "no aplica",
  skipped: "omitida",
  unavailable: "no disponible",
};

/**
 * Quién es dueño del recurso y qué clase de arreglo admite el hallazgo.
 *
 * Se imprimen SIEMPRE porque son las dos cosas que el JSON dice y el texto se
 * callaba: sin la clase, una remediación `manual` cuyo `guidance` viene vacío se
 * renderizaba renglón por renglón igual que una `none`, y la persona leía «acá
 * no hay nada que hacer» sobre un hallazgo que el resumen cuenta como
 * accionable (AC-03). Sin la propiedad, la distinción propio/ajeno —el eje de
 * AC-08— sólo se adivinaba de la prosa del resumen.
 */
const OWNERSHIP_LABEL: Record<string, string> = {
  ours: "de Workline",
  foreign: "ajena",
  ambiguous: "ambigua",
  "n/a": "no aplica",
};

const REMEDIATION_LABEL: Record<string, string> = {
  supported: "automatizable",
  manual: "manual",
  none: "sin acción segura",
};

/**
 * Lo que el comando devuelve, y por qué es una unión y no un sobre.
 *
 * `aw doctor` a secas emite el informe COMO `data`, sin envolverlo: es el
 * contrato que el esquema `schema_version: 1` publica y que un consumidor ya
 * puede leer. Los subverbos traen otra cosa —un listado o una propuesta
 * sellada—, así que se distinguen por su propio `kind`. El informe no lo lleva
 * justamente para no cambiar la forma que ya estaba publicada.
 */
export type DoctorCommandData =
  | DoctorReport
  | ({ kind: "prepare-listing" } & DoctorPrepareListing)
  | ({ kind: "prepare-sealed" } & DoctorProposal)
  | ({ kind: "applied" } & DoctorApplyResult);

/** Los subverbos se distinguen por su propio `kind`; el informe no lo lleva. */
function isSubverb(data: DoctorCommandData): data is Exclude<DoctorCommandData, DoctorReport> {
  return "kind" in data;
}

export const doctorCommand: CliCommand<DoctorCommandData> = {
  name: "doctor",
  describe:
    "aw doctor: diagnóstico contextual de la instalación y los recursos de Workline en los hosts detectados, con cobertura por categoría y veredicto en el código de salida. Con --verify-connection autorizás verificar las credenciales contra su servicio.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<DoctorCommandData>> {
    const options = {
      host: flagValue(args, "host") ?? null,
      only: onlyHosts(args),
      skipNative: args.flags.has("--skip-native"),
      // El flag ES la autorización de red, y no hay ceremonia extra a propósito:
      // nombra exactamente el efecto, lo tipeó la persona, y lo único que habilita
      // es un `SELECT 1` de sólo lectura. Sin él, una verificación que saldría de
      // la máquina se degrada a la presencia y lo DICE en su evidencia.
      ...(args.flags.has("--verify-connection") ? { verify: ["network_external" as const] } : {}),
    };
    if (args.rest[0] === "prepare") return await runPrepare(args, ctx, options);
    if (args.rest[0] === "apply") return await runApply(args, ctx, options);
    const report = await runDoctor(ctx, options);
    return { ok: true, data: report, exitCode: report.verdict.exit_code };
  },
  renderHuman(result: CommandResult<DoctorCommandData>, _context): string {
    const data = result.data;
    if (data === undefined) return "el diagnóstico no produjo informe.";
    if (isSubverb(data)) {
      if (data.kind === "applied") return appliedLines(data);
      return data.kind === "prepare-sealed" ? sealedLines(data) : listingLines(data);
    }
    return [
      ...hostLines(data),
      "",
      ...coverageLines(data),
      "",
      ...findingLines(data),
      "",
      ...summaryLines(data),
    ].join("\n");
  },
};

async function runPrepare(
  args: ParsedArgs,
  ctx: CliContext,
  options: DoctorRunOptions,
): Promise<CommandResult<DoctorCommandData>> {
  const outcome = await prepareDoctorBatch(ctx, {
    ...options,
    select: args.valuesMulti.get("select") ?? selectOne(args),
  });
  if (!outcome.ok) {
    return {
      ok: false,
      // Los `candidates` y la acción de salida VIAJAN: el punto de este rechazo
      // es nombrar los ids concretos, y un error que sólo dice «selección
      // inválida» obliga a la persona a adivinar cuál de los que escribió falla.
      error: {
        code: outcome.rejection.code,
        message: outcome.rejection.message,
        details: {
          candidates: outcome.rejection.candidates,
          action: outcome.rejection.action,
        },
      },
      exitCode: 1,
    };
  }
  if (outcome.kind === "listing") {
    return { ok: true, data: { kind: "prepare-listing", ...outcome.listing }, exitCode: 0 };
  }
  return { ok: true, data: { kind: "prepare-sealed", ...outcome.proposal }, exitCode: 0 };
}

/** `--only` puede repetirse; `--host` nunca. Uno lee una lista, el otro un nombre. */
function onlyHosts(args: ParsedArgs): string[] {
  const multi = args.valuesMulti.get("only");
  if (multi !== undefined) return multi;
  const single = flagValue(args, "only");
  return single === undefined ? [] : [single];
}

async function runApply(
  args: ParsedArgs,
  ctx: CliContext,
  options: DoctorRunOptions,
): Promise<CommandResult<DoctorCommandData>> {
  const outcome = await applyDoctorBatch(ctx, {
    ...options,
    select: args.valuesMulti.get("select") ?? selectOne(args),
    ...(flagValue(args, "approval") === undefined
      ? {}
      : { approval: flagValue(args, "approval") as string }),
  });
  if (!outcome.ok) {
    return {
      ok: false,
      error: {
        code: outcome.rejection.code,
        message: outcome.rejection.message,
        details: {
          candidates: outcome.rejection.candidates,
          action: outcome.rejection.action,
        },
      },
      exitCode: 1,
    };
  }
  // La misma convención que el informe: `ok:true` con el exit code como
  // veredicto, para que la proyección humana se renderice también cuando el lote
  // salió parcial — que es justo cuando la persona necesita ver acción por
  // acción hasta dónde llegó.
  return {
    ok: true,
    data: { kind: "applied", ...outcome.result },
    exitCode: outcome.result.exit_code,
  };
}

/** El resultado del lote: acción por acción, con su recomprobación. */
function appliedLines(data: { kind: "applied" } & DoctorApplyResult): string {
  const mark: Record<string, string> = {
    applied: "✔",
    failed: "✘",
    skipped: "·",
    blocked: "⊘",
  };
  const lines = [`Lote ${data.status} — ${flat(data.reason)}`, ""];
  for (const action of data.actions) {
    lines.push(`  ${mark[action.status] ?? "·"} ${flat(action.finding_id)} · ${action.op}`);
    if (action.reason !== null) lines.push(`      motivo: ${flat(action.reason)}`);
    lines.push(`      recomprobación: ${action.recheck} — ${flat(action.recheck_detail)}`);
  }
  const { applied, failed, skipped, blocked, resolved } = data.summary;
  lines.push("");
  lines.push(
    `Resumen: ${applied} aplicada(s) · ${failed} fallida(s) · ${skipped} omitida(s) · ${blocked} bloqueada(s) · ${resolved} resuelta(s)`,
  );
  lines.push(`Salida ${data.exit_code} · digest aprobado ${data.digest}`);
  return lines.join("\n");
}

/** `--select` puede repetirse; una sola vez llega por `values`. */
function selectOne(args: ParsedArgs): string[] {
  const single = flagValue(args, "select");
  return single === undefined ? [] : [single];
}

/** El listado: qué se PODRÍA reparar. No sella nada y no aprueba nada. */
function listingLines(data: { kind: "prepare-listing" } & DoctorPrepareListing): string {
  if (data.actionable.length === 0) {
    return "No hay ningún hallazgo con reparación automatizable en este informe.";
  }
  const lines = [`${data.actionable.length} hallazgo(s) con reparación automatizable:`];
  for (const action of data.actionable) {
    lines.push(`  ${flat(action.finding_id)}`);
    lines.push(`     ${flat(action.summary)} — ${flat(action.resource)} (${action.host})`);
    lines.push(`     comando equivalente: ${flat(action.verb)}`);
    lines.push(`     efectos: ${action.effects.join(", ")}`);
  }
  lines.push("");
  lines.push("Seleccioná con: aw doctor prepare --select <id> [--select <id> …]");
  return lines.join("\n");
}

/** La propuesta sellada: exactamente lo que `apply` va a hacer, y su digest. */
function sealedLines(data: { kind: "prepare-sealed" } & DoctorProposal): string {
  return [...data.preview.map(flat), "", `siguiente: ${flat(data.next)}`].join("\n");
}

function hostLines(report: DoctorReport): string[] {
  const lines = ["Hosts"];
  for (const host of report.hosts) {
    const mark = host.current ? "→" : " ";
    const version = host.runtime.version === null ? "" : ` ${host.runtime.version}`;
    lines.push(
      `${mark} ${host.label} · ${host.status} · runtime ${host.runtime.state}${version} · Workline ${host.workline_installed ? "instalado" : "ausente"}`,
    );
  }
  if (report.hosts_absent.length > 0) {
    lines.push(`  sin rastro en esta máquina: ${report.hosts_absent.join(", ")}`);
  }
  return lines;
}

function coverageLines(report: DoctorReport): string[] {
  const lines = ["Cobertura"];
  for (const category of DOCTOR_CATEGORIES) {
    const entries = report.coverage.filter((entry) => entry.category === category);
    lines.push(`  ${category}`);
    // Una categoría sin filas se DECLARA, no se saltea: hacerla desaparecer del
    // texto es cómo un informe que no miró instalación ni MCPs se lee como si
    // los hubiera aprobado (AC-02, AC-15).
    if (entries.length === 0) {
      lines.push("    (sin cobertura declarada en esta corrida)");
      continue;
    }
    for (const entry of entries) {
      const reason = entry.reason === null ? "" : ` — ${entry.reason}`;
      lines.push(`    ${entry.host}: ${COVERAGE_LABEL[entry.state] ?? entry.state}${reason}`);
    }
  }
  return lines;
}

/**
 * Una línea del informe, aplanada.
 *
 * Es la última defensa de la PROYECCIÓN, y hace falta porque casi todo lo que se
 * imprime acá nació en un archivo que escribió otra persona: el nombre de una
 * entrada MCP ajena, el motivo que el host reportó, la URL de una skill. Una
 * clave JSON admite saltos de línea, y sin aplanarlos una entrada llamada
 * `"inocente\n  ✔ claude-code/mcps/x — todo sano"` forja renglones de hallazgo
 * que nadie puede rastrear al informe.
 *
 * Va acá y no en el id: la identidad tiene que seguir siendo única (dos nombres
 * distintos no pueden colapsar en una fila), y lo que hay que neutralizar es el
 * texto en el momento de dibujarlo.
 */
function flat(text: string): string {
  // La sangría del principio SE CONSERVA: es la estructura del informe y no
  // contenido ajeno. Aplanar la línea entera dejaba la vista previa sin
  // jerarquía —todas las acciones al mismo margen— y lo que hay que neutralizar
  // son los saltos y los controles de ADENTRO, no el formato de afuera.
  const indent = /^ */.exec(text)?.[0] ?? "";
  return (
    indent +
    text
      .slice(indent.length)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: es exactamente lo que hay que sacar
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function findingLines(report: DoctorReport): string[] {
  const lines = ["Hallazgos"];
  if (report.findings.length === 0) {
    lines.push("  ninguno dentro de la cobertura comprobada");
    return lines;
  }
  for (const finding of report.findings) {
    lines.push(
      `  ${STATE_MARK[finding.state] ?? "·"} ${flat(finding.id)} — ${flat(finding.summary)}`,
    );
    lines.push(`      impacto: ${flat(finding.impact)}`);
    for (const evidence of finding.evidence) lines.push(`      evidencia: ${flat(evidence)}`);
    lines.push(
      `      propiedad: ${OWNERSHIP_LABEL[finding.ownership] ?? finding.ownership} · remediación: ${REMEDIATION_LABEL[finding.remediation.kind] ?? finding.remediation.kind}`,
    );
    if (finding.remediation.kind === "supported" && finding.remediation.action !== null) {
      lines.push(`      acción: ${flat(finding.remediation.action.op)}`);
    }
    for (const guidance of finding.remediation.guidance) {
      lines.push(`      guía: ${flat(guidance)}`);
    }
  }
  return lines;
}

function summaryLines(report: DoctorReport): string[] {
  const { healthy, warning, blocking, unverified, actionable } = report.summary;
  return [
    `Resumen: ${healthy} sano · ${warning} advertencia · ${blocking} bloqueo · ${unverified} no verificado · ${actionable} accionable`,
    `Veredicto: salida ${report.verdict.exit_code} — ${report.verdict.reason}`,
  ];
}
