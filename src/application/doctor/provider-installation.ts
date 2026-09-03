import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
/**
 * Installation and hosts — `selfDoctor` plus the catalog's own state report.
 *
 * Nothing is re-derived. `reportAllHostStates` already decides `ready` /
 * `installable` / `residual-config` and already writes the exact next command
 * into `advice`; this provider translates that into the common model and hands
 * the advice over as guidance rather than inventing a second phrasing of it.
 */
import { selfDoctor } from "../self/doctor-self.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "installation-hosts" as const;

export const installationProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const report = await selfDoctor(input.ctx);
    const targets = report.data?.skill.targets ?? [];
    const findings: DoctorFinding[] = [];

    for (const host of input.hosts) {
      const state = input.hostStates.find((candidate) => candidate.host === host.host);
      findings.push(hostFinding(host, state?.advice ?? null));
      const target = targets.find((candidate) => candidate.target === host.target);
      if (target !== undefined) findings.push(...targetFindings(host, target));
    }

    return {
      coverage: input.hosts.map((host) => coverage(CATEGORY, host.host, "checked")),
      findings,
    };
  },
};

function hostFinding(
  host: DoctorProviderInput["hosts"][number],
  advice: string | null,
): DoctorFinding {
  const evidence = [
    `estado del host: ${host.status}`,
    `runtime: ${host.runtime.state}${host.runtime.version === null ? "" : ` ${host.runtime.version}`}`,
    `Workline instalado: ${host.workline_installed ? "sí" : "no"}`,
  ];
  const base = {
    id: doctorFindingId(host.host, CATEGORY, "workline"),
    host: host.host,
    category: CATEGORY,
    resource: { kind: "host", name: host.label, locator: host.target },
    evidence,
    ownership: "ours" as const,
  };
  if (host.status === "ready") {
    return {
      ...base,
      state: "healthy",
      summary: `Workline está instalado en ${host.label} y su runtime responde`,
      impact: "las capacidades de Workline se pueden invocar desde este host",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  const guidance = advice === null ? [] : [advice];
  if (host.status === "installable") {
    return {
      ...base,
      proposal: { op: "self.install-skill", args: { target: host.target } },
      state: "warning",
      summary: `${host.label} está en esta máquina y Workline no está instalado ahí`,
      impact: "los comandos de Workline no existen en ese host hasta instalarlo",
      remediation: { kind: "manual", action: null, guidance },
    };
  }
  return {
    ...base,
    // Retirar lo residual y instalar el bundle no pueden coexistir para un mismo
    // host: el catálogo declara un host `installable` O `residual-config`, nunca
    // los dos, así que la exclusión es del estado y no una regla que haya que
    // recordar acá.
    proposal: { op: "self.uninstall", args: { target: host.target } },
    state: "warning",
    summary: `${host.label} dejó configuración sin un runtime que la use`,
    impact: "la configuración residual puede confundir a otras herramientas que la lean",
    remediation: { kind: "manual", action: null, guidance },
  };
}

/**
 * The two things `selfDoctor` observes per destination that a host state cannot.
 *
 * Both are warnings and neither is inferred from a counter: a leftover reported
 * without its path, or a lock warning folded into the host's own state, is a
 * finding whose resource nobody can locate.
 */
function targetFindings(
  host: DoctorProviderInput["hosts"][number],
  target: {
    legacy_leftover?: boolean;
    legacy_leftover_path?: string;
    legacy_leftover_warning?: string;
    lock_warning?: string;
    path: string;
  },
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (target.legacy_leftover === true) {
    findings.push({
      id: doctorFindingId(host.host, CATEGORY, "resto-legacy"),
      host: host.host,
      category: CATEGORY,
      resource: {
        kind: "bundle",
        name: "resto legacy",
        locator: target.legacy_leftover_path ?? target.path,
      },
      proposal: { op: "self.clean-legacy", args: { target: host.target } },
      state: "warning",
      summary: target.legacy_leftover_warning ?? "quedó un bundle de una instalación anterior",
      impact: "el host puede cargar documentos viejos junto a los vigentes",
      evidence: [`ruta observada: ${target.legacy_leftover_path ?? target.path}`],
      ownership: "ours",
      remediation: { kind: "manual", action: null, guidance: ["aw self clean-legacy"] },
    });
  }
  if (target.lock_warning !== undefined) {
    findings.push({
      id: doctorFindingId(host.host, CATEGORY, "lock"),
      host: host.host,
      category: CATEGORY,
      resource: { kind: "lock", name: "lock de skills", locator: target.path },
      proposal: { op: "self.install-skill", args: { target: host.target } },
      state: "warning",
      summary: target.lock_warning,
      impact: "el registro compartido de skills no describe lo que está instalado",
      evidence: [`destino: ${target.path}`],
      ownership: "ours",
      remediation: { kind: "manual", action: null, guidance: ["aw self install-skill"] },
    });
  }
  return findings;
}
