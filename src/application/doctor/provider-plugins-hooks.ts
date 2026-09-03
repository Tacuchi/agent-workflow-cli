import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
/**
 * Plugins and hooks — external dependencies, armed hooks, and what a host cannot
 * carry from the bundled template.
 *
 * The three come from three existing readers and stay three findings. Folding
 * the template losses into "hooks armed" is precisely what the loss report
 * exists to prevent: a host that expresses part of the set would read as fully
 * armed while one hook silently is not there.
 *
 * `template_read: false` is `unverified`, never "no losses". The difference
 * between "nothing was lost" and "nobody could tell" is the whole point.
 */
import type { HostDoctorFinding } from "../host-doctor-service.js";
import { runHostDoctor } from "../host-doctor-service.js";
import type { HookTemplateLossReport, HooksArmedReport } from "../self/host-states.js";
import { reportHookTemplateLosses, reportHooksArmed } from "../self/host-states.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "plugins-hooks" as const;
const SCOPE_HOST = "workspace";

export const pluginsHooksProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const host = await runHostDoctor(input.ctx.fs, input.ctx.env, input.ctx.process);
    const participating = new Set(input.hosts.map((candidate) => candidate.target));
    const findings: DoctorFinding[] = [
      ...host.findings.map(dependencyFinding),
      ...(await reportHooksArmed(input.ctx))
        .filter((report) => participating.has(report.target))
        .map((report) => hooksArmedFinding(hostOf(input, report.target), report)),
      ...(await reportHookTemplateLosses(input.ctx))
        .filter((loss) => participating.has(loss.target))
        // A host that carries the whole template has nothing to say here: the
        // armed finding beside it already reports the healthy case, and a second
        // "nothing was lost" row per host would bury the ones that did lose.
        .filter((loss) => !loss.template_read || loss.losses.length > 0)
        .map((loss) => templateLossFinding(hostOf(input, loss.target), loss)),
    ];

    return {
      coverage: [
        coverage(CATEGORY, SCOPE_HOST, "checked"),
        ...input.hosts.map((candidate) => coverage(CATEGORY, candidate.host, "checked")),
      ],
      findings,
    };
  },
};

/** An external dependency an installed third-party plugin needs. Never ours to install. */
function dependencyFinding(finding: HostDoctorFinding): DoctorFinding {
  const platform = process.platform;
  const hint =
    platform === "darwin" || platform === "linux" || platform === "win32"
      ? finding.install_hint[platform]
      : finding.install_hint.linux;
  return {
    id: doctorFindingId(SCOPE_HOST, CATEGORY, `dependencia:${finding.dependency}`),
    host: SCOPE_HOST,
    category: CATEGORY,
    resource: { kind: "dependency", name: finding.dependency, locator: null },
    state: finding.severity === "ok" ? "healthy" : "warning",
    summary: finding.message,
    impact:
      finding.severity === "ok"
        ? "los plugins que la requieren pueden usarla"
        : `los plugins que la requieren fallan al usarla: ${finding.required_by.join(", ")}`,
    evidence: [
      `requerida por: ${finding.required_by.join(", ") || "ningún plugin"}`,
      ...finding.plugin_paths.map((path) => `plugin en ${path}`),
    ],
    ownership: "n/a",
    remediation:
      finding.severity === "ok"
        ? { kind: "none", action: null, guidance: [] }
        : { kind: "manual", action: null, guidance: [hint] },
  };
}

function hooksArmedFinding(host: string, report: HooksArmedReport): DoctorFinding {
  return {
    id: doctorFindingId(host, CATEGORY, "hooks"),
    host,
    category: CATEGORY,
    resource: { kind: "hooks", name: report.label, locator: report.path },
    state: report.armed ? "healthy" : "warning",
    summary: report.armed
      ? `los hooks de Workline están armados en ${report.label}`
      : `los hooks de Workline no están armados en ${report.label}`,
    impact: report.armed
      ? "el host ejecuta los hooks que Workline instala"
      : "el host no dispara los hooks de Workline: la continuidad entre turnos se degrada",
    evidence: [`archivo inspeccionado: ${report.path}`],
    ownership: "ours",
    remediation: report.armed
      ? { kind: "none", action: null, guidance: [] }
      : { kind: "manual", action: null, guidance: ["aw self install-hooks"] },
  };
}

/**
 * What this host cannot carry from the bundled template.
 *
 * `template_read: false` is `unverified`, never "no losses": the difference
 * between "nothing was lost" and "nobody could tell" is the whole point.
 */
function templateLossFinding(host: string, loss: HookTemplateLossReport): DoctorFinding {
  return {
    id: doctorFindingId(host, CATEGORY, "plantilla-hooks"),
    host,
    category: CATEGORY,
    resource: { kind: "hooks", name: "plantilla de hooks", locator: null },
    state: loss.template_read ? "warning" : "unverified",
    summary: loss.template_read
      ? "este host no puede expresar parte de la plantilla de hooks"
      : "no se pudo leer la plantilla de hooks: no se sabe qué se pierde",
    impact: loss.template_read
      ? "algunos hooks no existen acá aunque el resto esté armado"
      : "no se puede afirmar que la plantilla se exprese entera",
    evidence: loss.template_read ? loss.losses : ["la plantilla no se pudo leer"],
    ownership: "ours",
    remediation: { kind: "none", action: null, guidance: [] },
  };
}

function hostOf(input: DoctorProviderInput, target: string): string {
  return input.hosts.find((candidate) => candidate.target === target)?.host ?? target;
}
