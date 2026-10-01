/**
 * Doctor reports built with the model's own functions, for the surface tests.
 *
 * The summary and the verdict are computed by production from the findings, so
 * the exit code a test asserts is never a number the test wrote.
 */
import {
  DOCTOR_SCHEMA_VERSION,
  type DoctorCategory,
  type DoctorCoverage,
  type DoctorFinding,
  type DoctorHostView,
  type DoctorReport,
  doctorFindingId,
  doctorVerdict,
  sortDoctorCoverage,
  sortDoctorFindings,
  summarizeDoctorFindings,
} from "../../src/domain/doctor/model.js";
import { HARNESSES, type HarnessId } from "../../src/domain/harnesses.js";

/** La etiqueta que el informe humano imprime sale del catálogo real, no de esta prueba. */
export function hostLabel(id: HarnessId): string {
  const spec = HARNESSES.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`el catálogo no declara el host ${id}`);
  return spec.label;
}

/**
 * Dos formas de host DELIBERADAMENTE opuestas: `installed` decide a la vez el
 * estado, el runtime y la instalación de Workline.
 *
 * Con dos hosts idénticos las ramas «ausente» y «sin runtime» no se renderizan
 * nunca, así que invertir `workline_installed` en producción no cambiaría una
 * sola letra del texto y ninguna prueba podría notarlo.
 */
export function hostView(
  id: HarnessId,
  current: boolean,
  installed: boolean,
  degradations: DoctorHostView["degradations"] = [],
): DoctorHostView {
  const spec = HARNESSES.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`el catálogo no declara el host ${id}`);
  return {
    host: spec.id,
    target: spec.installTarget,
    label: spec.label,
    status: installed ? "ready" : "degraded",
    current,
    runtime: installed
      ? { state: "available", version: "1.2.3" }
      : { state: "missing", version: null },
    workline_installed: installed,
    degradations,
  };
}

export function finding(
  host: string,
  category: DoctorCategory,
  resource: string,
  state: DoctorFinding["state"],
  over: Partial<DoctorFinding> = {},
): DoctorFinding {
  return {
    id: doctorFindingId(host, category, resource),
    host,
    category,
    resource: { kind: "mcp-entry", name: resource, locator: `~/.config/${host}/${resource}` },
    state,
    summary: `${resource} quedó en estado ${state}`,
    impact: `lo que cuesta: ${resource}`,
    evidence: [`leído de ~/.config/${host}/${resource}`],
    ownership: "ours",
    remediation: { kind: "manual", action: null, guidance: [`revisá ${resource} a mano`] },
    ...over,
  };
}

export function coverageOf(
  category: DoctorCategory,
  host: string,
  state: DoctorCoverage["state"],
  reason: string | null = null,
): DoctorCoverage {
  return { category, host, state, reason };
}

/**
 * El informe se ensambla con las funciones del modelo, no a mano: el resumen y
 * el veredicto los calcula producción a partir de los hallazgos, así que el
 * `exitCode` que se afirma más abajo no es un número escrito por la prueba.
 */
export function reportOf(findings: DoctorFinding[], coverage: DoctorCoverage[]): DoctorReport {
  const hostOrder = [...HARNESSES.map((spec) => spec.id), "workspace"];
  const orderedFindings = sortDoctorFindings(findings, hostOrder);
  const orderedCoverage = sortDoctorCoverage(coverage, hostOrder);
  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    cli_version: "0.0.0-test",
    scope: { hub_dir: "/w", current_host: "claude-code", only: [] },
    hosts: [hostView("claude-code", true, true), hostView("codex", false, false)],
    hosts_absent: ["kimi"],
    coverage: orderedCoverage,
    findings: orderedFindings,
    summary: summarizeDoctorFindings(orderedFindings),
    verdict: doctorVerdict(orderedFindings, orderedCoverage),
  };
}

/** Tres estados de cobertura distintos: «lo miré» no puede leerse igual que «no lo miré». */
export const COVERAGE = [
  coverageOf("installation-hosts", "claude-code", "checked"),
  coverageOf("installation-hosts", "codex", "checked"),
  coverageOf("mcps", "claude-code", "checked"),
  coverageOf("mcps", "codex", "skipped", "se pidió --skip-native"),
  coverageOf("skills", "claude-code", "checked"),
  coverageOf("skills", "codex", "not-applicable", "el host no descubre skills"),
];

/**
 * Un informe con un bloqueo: el veredicto sale 1 y el comando NO puede
 * reportarlo como fallo.
 *
 * Los cuatro estados llegan con cifras DISTINTAS (3 sanos, 2 advertencias, 1
 * bloqueo, 4 no verificados) a propósito: con un hallazgo de cada uno, permutar
 * dos rótulos del resumen —lo primero que una persona lee— es invisible para
 * cualquier aserción sobre esas cifras.
 */
export function blockingReport(): DoctorReport {
  return reportOf(
    [
      finding("claude-code", "installation-hosts", "runtime", "healthy"),
      finding("claude-code", "installation-hosts", "bundle", "healthy"),
      finding("claude-code", "skills", "replica", "healthy"),
      finding("claude-code", "mcps", "workline", "blocking"),
      finding("codex", "skills", "w:plan-exec", "warning"),
      finding("codex", "skills", "w:quick", "warning"),
      finding("codex", "mcps", "database", "unverified"),
      finding("codex", "mcps", "elicitation", "unverified"),
      finding("codex", "installation-hosts", "runtime", "unverified"),
      finding("codex", "installation-hosts", "hooks", "unverified"),
    ],
    COVERAGE,
  );
}

export function healthyReport(): DoctorReport {
  return reportOf([finding("claude-code", "installation-hosts", "runtime", "healthy")], COVERAGE);
}
