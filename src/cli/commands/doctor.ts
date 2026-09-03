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
import { runDoctor } from "../../application/doctor/report.js";
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

export const doctorCommand: CliCommand<DoctorReport> = {
  name: "doctor",
  describe:
    "aw doctor: diagnóstico contextual de la instalación y los recursos de Workline en los hosts detectados, con cobertura por categoría y veredicto en el código de salida.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<DoctorReport>> {
    const report = await runDoctor(ctx, {
      host: flagValue(args, "host") ?? null,
      only: onlyHosts(args),
      skipNative: args.flags.has("--skip-native"),
    });
    return { ok: true, data: report, exitCode: report.verdict.exit_code };
  },
  renderHuman(result: CommandResult<DoctorReport>, _context): string {
    const report = result.data;
    if (report === undefined) return "el diagnóstico no produjo informe.";
    return [
      ...hostLines(report),
      "",
      ...coverageLines(report),
      "",
      ...findingLines(report),
      "",
      ...summaryLines(report),
    ].join("\n");
  },
};

/** `--only` may repeat; `--host` never does. One reads a list, the other a name. */
function onlyHosts(args: ParsedArgs): string[] {
  const multi = args.valuesMulti.get("only");
  if (multi !== undefined) return multi;
  const single = flagValue(args, "only");
  return single === undefined ? [] : [single];
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
  return (
    text
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
