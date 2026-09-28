import {
  type DoctorCoverage,
  type DoctorFinding,
  doctorFindingId,
} from "../../domain/doctor/model.js";
import {
  type CapabilityReadinessReport,
  type ReadinessVerdict,
  capabilityReadiness,
} from "../capability/readiness.js";
import { resolveSkills } from "../skills-resolver-service.js";
/** Workline-owned capability readiness and direct wrapper health, per host. */
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "skills" as const;

export const skillsProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const findings: DoctorFinding[] = [];
    const covered: DoctorCoverage[] = [];
    const bindings = await resolveSkills(input.ctx.fs, input.ctx.paths);
    for (const [index, warning] of bindings.warnings.entries()) {
      if (!warning.includes("no aplicable")) continue;
      findings.push({
        id: doctorFindingId("workspace", CATEGORY, `binding:${index}`),
        host: "workspace",
        category: CATEGORY,
        resource: { kind: "binding", name: `skills.toml:${index}`, locator: null },
        state: "warning",
        summary: "binding histórico no aplicable a Workline",
        impact: "no selecciona mejoras ni modifica el floor propio",
        evidence: [warning],
        ownership: "foreign",
        remediation: {
          kind: "manual",
          action: null,
          guidance: [
            "gestioná esa skill desde el host o marketplace elegido; el archivo queda intacto",
          ],
        },
      });
    }
    if (bindings.warnings.some((warning) => warning.includes("no aplicable"))) {
      covered.push(coverage(CATEGORY, "workspace", "checked"));
    }

    // The floor is host-independent; the direct wrapper is checked against each
    // participating host's own tree. With no host, report only applicable
    // historical binding notices, never invented capability installations.
    for (const host of input.hosts) {
      for (const report of await capabilityReadiness({
        fs: input.ctx.fs,
        env: input.ctx.env,
        paths: input.ctx.paths,
        host: host.host,
      })) {
        findings.push(capabilityFinding(host.host, report));
      }
      covered.push(coverage(CATEGORY, host.host, "checked"));
    }

    return { coverage: covered, findings };
  },
};

/** The two states readiness calls usable. Everything else owes a reason. */
function isReady(state: string): boolean {
  return state === "ready" || state === "resolved";
}

/** The `direct` verdict, and only when the capability declares that route. */
function directVerdict(report: CapabilityReadinessReport): ReadinessVerdict | null {
  return report.exposure.includes("direct") ? report.exposures.direct : null;
}

/**
 * The first of the two verdicts that fails, or null when both are usable.
 *
 * The capability comes first and the host's `direct` route second, which is the
 * honest order: a capability that does not resolve is not fixed by installing a
 * wrapper, so its reason is the one worth printing.
 */
function failingVerdict(report: CapabilityReadinessReport): ReadinessVerdict | null {
  if (!isReady(report.state)) {
    return { state: report.state, reason: report.reason, action: report.action };
  }
  const direct = directVerdict(report);
  return direct !== null && !isReady(direct.state) ? direct : null;
}

/** Both verdicts as read, with the host-dependent half named by its host. */
function capabilityEvidence(host: string, report: CapabilityReadinessReport): string[] {
  const direct = directVerdict(report);
  return [
    `estado: ${report.state}`,
    ...(report.reason === null ? [] : [report.reason]),
    ...(direct === null ? [] : [`ruta directa en '${host}': ${direct.state}`]),
    ...(direct === null || direct.reason === null ? [] : [direct.reason]),
  ];
}

/**
 * A capability's readiness ON ONE HOST, translated one field at a time.
 *
 * `ReadinessVerdict` already separates the three things: `state`, the `reason`
 * behind it and the `action` that fixes it. Mapping is all that happens here —
 * inventing a second wording for a reason the engine already wrote is how the
 * two surfaces end up telling the person different stories.
 *
 * Two verdicts are read, in this order: the capability itself, and — only when
 * it declares the route — its `direct` exposure, which is the one that depends
 * on the host. The order is the honest one: a capability that does not resolve
 * is not fixed by installing a wrapper, so its reason comes first. Reporting
 * only the top-level verdict was the defect: it is identical on every host, so a
 * missing wrapper in one host's tree left no trace anywhere in the report.
 */
function capabilityFinding(host: string, report: CapabilityReadinessReport): DoctorFinding {
  const failed = failingVerdict(report);
  return {
    id: doctorFindingId(host, CATEGORY, `capability:${report.capability}`),
    host,
    category: CATEGORY,
    resource: { kind: "capability", name: report.capability, locator: null },
    state: failed === null ? "healthy" : "warning",
    summary:
      failed === null
        ? `la capacidad '${report.capability}' está lista en '${host}'`
        : `la capacidad '${report.capability}' está ${failed.state} en '${host}'`,
    impact:
      failed === null
        ? "sus operaciones se pueden invocar"
        : (failed.reason ?? "algunas de sus operaciones pueden no estar disponibles"),
    evidence: capabilityEvidence(host, report),
    ownership: "ours",
    remediation:
      failed === null
        ? { kind: "none", action: null, guidance: [] }
        : {
            kind: "manual",
            action: null,
            guidance: failed.action === null ? [] : [failed.action],
          },
  };
}
