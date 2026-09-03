/**
 * The one shape every doctor provider speaks, and the only one the report emits.
 *
 * Six diagnostic engines already exist and each named the same idea differently
 * — `level`, `severity`, `status` — so a reader had to learn three vocabularies
 * to read one environment. Nothing here re-diagnoses: this is the vocabulary the
 * providers translate INTO, modelled on the one engine that already separated
 * the three things a person needs (`ReadinessVerdict`: state, evidence, action).
 */
import type { HarnessId, InstallTarget } from "../harnesses.js";

/** A new field raises this; a field is never renamed inside one version. */
export const DOCTOR_SCHEMA_VERSION = 1;

/**
 * The six categories, in the order the report presents them.
 *
 * The order is part of the contract: two runs over the same environment produce
 * byte-comparable reports, and a diff that reorders sections is a diff nobody
 * can read.
 */
export const DOCTOR_CATEGORIES = [
  "installation-hosts",
  "mcps",
  "skills",
  "tools-auth",
  "plugins-hooks",
  "workspace-visibility",
] as const;

export type DoctorCategory = (typeof DOCTOR_CATEGORIES)[number];

/**
 * What one finding says about one resource.
 *
 * `healthy` is EMITTED, never inferred from an empty list: "nothing was wrong"
 * and "nothing was looked at" are different answers, and a counter cannot tell
 * them apart. `unverified` is the third: the check did not run or could not
 * conclude, and presenting that as passed is the failure this whole model exists
 * to prevent.
 */
export type DoctorFindingState = "healthy" | "warning" | "blocking" | "unverified";

/** Whether Workline may act on the resource at all. Decided by the existing predicates, never by name. */
export type DoctorOwnership = "ours" | "foreign" | "ambiguous" | "n/a";

/** What the run actually managed to look at, per category and host. */
export type DoctorCoverageState = "checked" | "not-applicable" | "skipped" | "unavailable";

/** Whether a finding has an automatable repair, written instructions, or nothing safe. */
export type DoctorRemediationKind = "supported" | "manual" | "none";

export interface DoctorResource {
  /** What kind of thing it is: `host`, `mcp-entry`, `skill`, `connection`, `hook`, … */
  kind: string;
  name: string;
  /** Where it lives — a path, a config file, a variable name. Never a value. */
  locator: string | null;
}

/**
 * The repair a finding proposes.
 *
 * `action` stays `null` until a phase that owns repair fills it. A finding whose
 * remediation is `manual` carries its guidance and nothing else; one whose
 * remediation is `none` carries neither, and that is a legitimate answer for a
 * resource nobody may touch safely.
 */
export interface DoctorRemediation {
  kind: DoctorRemediationKind;
  action: DoctorAction | null;
  guidance: string[];
}

/** A repair the CLI can run, named by the operation it delegates to. */
export interface DoctorAction {
  op: string;
  args: Record<string, string>;
  /** Effect classes from the closed vocabulary the capability contract owns. */
  effects: string[];
  /** Ids of the findings whose actions must succeed first. */
  depends_on: string[];
  /** The finding state expected after it applies. */
  expected: DoctorFindingState;
}

/**
 * Lo que un proveedor SUGIERE que repararía este recurso — y nunca la acción.
 *
 * Existe porque el proveedor es el único que tiene el contexto (qué host, qué
 * instancia, qué scope, qué nombre) y el id no lo lleva: recomponerlo con una
 * expresión regular sobre el id es des-renderizar la presentación para recuperar
 * un dato estructural que estaba a la vista donde se emitió.
 *
 * Es una SUGERENCIA y no una acción por una razón que es la promesa entera del
 * plan: quién puede recibir una acción lo decide el anotador, en un solo lugar,
 * con los predicados de propiedad. Un proveedor que emitiera acciones sería un
 * segundo lugar donde esa regla vive, y ahí es donde AC-08 se rompe sin que
 * nadie lo note.
 *
 * NUNCA llega al informe emitido: `runDoctor` la consume y la retira. Lo que el
 * esquema publica es `remediation`.
 */
export interface DoctorRepairHint {
  /** Id de una operación del catálogo. Una que no existe se descarta. */
  op: string;
  /** Los argumentos que esa operación necesita, ya resueltos por el proveedor. */
  args: Record<string, string>;
}

export interface DoctorFinding {
  /** Deterministic: `<host>/<category>/<resource>`. Stable across runs over the same state. */
  id: string;
  host: string;
  category: DoctorCategory;
  resource: DoctorResource;
  state: DoctorFindingState;
  summary: string;
  /** What it costs the person — never a restatement of the state. */
  impact: string;
  /** The observations the state rests on, as read. */
  evidence: string[];
  ownership: DoctorOwnership;
  remediation: DoctorRemediation;
  /** Interno: la sugerencia del proveedor. Ver {@link DoctorRepairHint}. */
  proposal?: DoctorRepairHint;
}

export interface DoctorCoverage {
  category: DoctorCategory;
  host: string;
  state: DoctorCoverageState;
  /** Never empty for anything but `checked`: a gap without its reason is noise. */
  reason: string | null;
}

export interface DoctorHostView {
  host: HarnessId;
  target: InstallTarget;
  label: string;
  status: string;
  /** True for the host the run was invoked from. Highlights; never filters. */
  current: boolean;
  runtime: { state: string; version: string | null };
  workline_installed: boolean;
}

export interface DoctorSummary {
  healthy: number;
  warning: number;
  blocking: number;
  unverified: number;
  /** Findings carrying a remediation that is not `none`. */
  actionable: number;
}

export interface DoctorVerdict {
  exit_code: 0 | 1;
  reason: string;
}

export interface DoctorScope {
  workspace_dir: string;
  current_host: string | null;
  only: string[];
}

export interface DoctorReport {
  schema_version: number;
  cli_version: string;
  scope: DoctorScope;
  hosts: DoctorHostView[];
  /** Hosts never configured here. Enumerated, never turned into a warning. */
  hosts_absent: string[];
  coverage: DoctorCoverage[];
  findings: DoctorFinding[];
  summary: DoctorSummary;
  verdict: DoctorVerdict;
}

/** `<host>/<category>/<resource>` — the id a selection names and a re-check finds again. */
export function doctorFindingId(host: string, category: DoctorCategory, resource: string): string {
  return `${host}/${category}/${resource}`;
}

const CATEGORY_ORDER = new Map(DOCTOR_CATEGORIES.map((category, index) => [category, index]));

/**
 * The stable order, applied once over the consolidated report.
 *
 * Host order comes from the catalog and is passed in rather than recomputed:
 * the hosts section and the findings section disagreeing about which host comes
 * first is the kind of thing a person reads as two different environments.
 */
export function sortDoctorFindings(
  findings: readonly DoctorFinding[],
  hostOrder: readonly string[],
): DoctorFinding[] {
  const host = new Map(hostOrder.map((id, index) => [id, index]));
  const rank = (id: string): number => host.get(id) ?? host.size;
  return [...findings].sort(
    (left, right) =>
      rank(left.host) - rank(right.host) ||
      (CATEGORY_ORDER.get(left.category) ?? 0) - (CATEGORY_ORDER.get(right.category) ?? 0) ||
      left.resource.name.localeCompare(right.resource.name) ||
      left.id.localeCompare(right.id),
  );
}

export function sortDoctorCoverage(
  coverage: readonly DoctorCoverage[],
  hostOrder: readonly string[],
): DoctorCoverage[] {
  const host = new Map(hostOrder.map((id, index) => [id, index]));
  const rank = (id: string): number => host.get(id) ?? host.size;
  return [...coverage].sort(
    (left, right) =>
      (CATEGORY_ORDER.get(left.category) ?? 0) - (CATEGORY_ORDER.get(right.category) ?? 0) ||
      rank(left.host) - rank(right.host) ||
      left.host.localeCompare(right.host),
  );
}

export function summarizeDoctorFindings(findings: readonly DoctorFinding[]): DoctorSummary {
  const count = (state: DoctorFindingState): number =>
    findings.filter((finding) => finding.state === state).length;
  return {
    healthy: count("healthy"),
    warning: count("warning"),
    blocking: count("blocking"),
    unverified: count("unverified"),
    actionable: findings.filter((finding) => finding.remediation.kind !== "none").length,
  };
}

/**
 * The verdict, and it is the exit code.
 *
 * Two things make it 1: a blocking finding, and a provider that fell over. The
 * second matters as much as the first — a doctor that returns 0 because it could
 * not look is worse than one that says nothing, since the person reads the zero
 * as health.
 */
export function doctorVerdict(
  findings: readonly DoctorFinding[],
  coverage: readonly DoctorCoverage[],
): DoctorVerdict {
  const blocking = findings.filter((finding) => finding.state === "blocking");
  const unavailable = coverage.filter((entry) => entry.state === "unavailable");
  if (blocking.length > 0) {
    const names = blocking.map((finding) => finding.id).join(", ");
    return { exit_code: 1, reason: `hay ${blocking.length} hallazgo(s) bloqueante(s): ${names}` };
  }
  if (unavailable.length > 0) {
    const names = [...new Set(unavailable.map((entry) => entry.category))].join(", ");
    return {
      exit_code: 1,
      reason: `no se pudo comprobar ${unavailable.length} cobertura(s) (${names}): el entorno no queda declarado sano`,
    };
  }
  return {
    exit_code: 0,
    reason: "ningún bloqueo y ningún proveedor caído dentro de la cobertura comprobada",
  };
}
