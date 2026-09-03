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
/**
 * Skills — what is registered, whether its replicas landed, and whether the one
 * capability that has a contract is actually ready.
 *
 * `listSkills` already answers the first two and `capabilityReadiness` the
 * third, with a verdict that separates state, reason and action — the shape this
 * whole model was modelled on. Neither is re-derived: an incomplete replica is
 * read off the booleans the manager publishes, not re-inspected here.
 *
 * The seed list is deliberately empty. It only supplies descriptions and the
 * `recommended` status, and a doctor that turned "you could also install this"
 * into a finding would teach people to skim past the ones that matter.
 *
 * The category answers TWO things with two different scopes, and they are kept
 * apart on purpose (AC-02):
 *
 * - The registered skills and their replicas belong to the PERSON, not to a
 *   host: the registry and the three replica roots hang off `$HOME`
 *   (`~/.agents`, `~/.claude`, `~/.gemini`) and no host governs them. Reporting
 *   the same user-level answer once per participating host would be the same
 *   sentence repeated N times, so it is anchored at the `workspace` pseudo-host
 *   — the same anchor the aggregate uses when no host participates.
 * - A capability's DIRECT route is per host: it resolves against that host's own
 *   skills tree, so it can be installed in one and absent in the next. That half
 *   IS emitted per host, one coverage row each.
 */
import { listSkills } from "../self/skills-manager.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "skills" as const;
/** Where a user-level skill finding lives: the workspace, not a host — replicas are per-user. */
const SCOPE_HOST = "workspace";

export const skillsProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const findings: DoctorFinding[] = [];
    const covered: DoctorCoverage[] = [coverage(CATEGORY, SCOPE_HOST, "checked")];

    for (const skill of await listSkills(input.ctx, [])) {
      if (skill.status === "recommended") continue;
      findings.push(skillFinding(skill));
    }

    // One readiness read per participating host. The capability-level verdict is
    // the same everywhere, but `exposures.direct` is resolved against THIS
    // host's skills tree — exactly the half that can be missing in one host and
    // present in the next. And when no host participates (`--only` over a host
    // that is not on this machine) none is invented: there are no capability
    // findings and no coverage row claims a host was checked.
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

/**
 * A registered skill's `source`, with any URL userinfo removed.
 *
 * `source` is the string the person typed at register time, kept verbatim — and
 * without a credential helper the usual way to reach a private repo is
 * `https://<token>@github.com/acme/skills.git`. The global redaction cannot see
 * that: `CONNECTION_URI` only covers `postgres|mysql|mongodb` and
 * `SECRET_ASSIGNMENT` only `key=value` shapes, so the token would reach
 * `evidence` and `resource.locator` intact (AC-11). The whole userinfo goes,
 * never just the password half: a PAT is perfectly valid on its own in the user
 * position, so telling a harmless username apart from a secret is not something
 * this can decide — and the repo, which is what identifies the skill, survives.
 */
function withoutUrlUserinfo(source: string): string {
  return source.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1***@");
}

function skillFinding(skill: {
  name: string;
  status: string;
  source: string;
  replicas: { agents: boolean; claude: boolean; gemini: boolean };
}): DoctorFinding {
  const missing = Object.entries(skill.replicas)
    .filter(([, present]) => !present)
    .map(([host]) => host);
  const source = withoutUrlUserinfo(skill.source);
  const evidence = [
    `estado en el registro: ${skill.status}`,
    `origen: ${source}`,
    `réplicas presentes: ${
      Object.entries(skill.replicas)
        .filter(([, present]) => present)
        .map(([host]) => host)
        .join(", ") || "ninguna"
    }`,
  ];
  const base = {
    id: doctorFindingId(SCOPE_HOST, CATEGORY, skill.name),
    host: SCOPE_HOST,
    category: CATEGORY,
    resource: { kind: "skill" as const, name: skill.name, locator: source },
    evidence,
  };
  // `unmanaged` is a skill living in the canonical root that this CLI never
  // registered: it is somebody else's, so it is reported and left alone.
  if (skill.status === "unmanaged") {
    return {
      ...base,
      state: "warning",
      summary: `'${skill.name}' está en el árbol canónico y Workline no la registró`,
      impact: "Workline no la actualiza ni la retira: no sabe de dónde vino",
      ownership: "foreign",
      remediation: {
        kind: "manual",
        action: null,
        guidance: [`si es tuya, registrala con 'aw self skills register'; si no, dejala como está`],
      },
    };
  }
  if (missing.length === 0) {
    return {
      ...base,
      state: "healthy",
      summary: `'${skill.name}' está registrada con todas sus réplicas`,
      impact: "la skill se ve desde los hosts que leen esas réplicas",
      ownership: "ours",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  return {
    ...base,
    state: "warning",
    summary: `'${skill.name}' tiene réplicas faltantes: ${missing.join(", ")}`,
    impact: "los hosts que leen esas réplicas no ven la skill",
    ownership: "ours",
    remediation: {
      kind: "manual",
      action: null,
      guidance: [`aw self skills reinstall --name ${skill.name}`],
    },
  };
}

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
