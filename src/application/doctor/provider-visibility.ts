import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
/**
 * Workspace visibility — the declared sources against the ones each host has
 * registered.
 *
 * One finding per drift CLASS that is actually present, driven by the `missing`
 * and `extra` lists rather than by the aggregate status: a report whose status
 * is `missing-paths` may also carry extras, and a single finding per host would
 * hide one of the two.
 *
 * With no project block in the current directory there is nothing to compare,
 * and that is `not-applicable` — not a warning. Someone running the doctor from
 * a directory that is not a workspace has not misconfigured anything.
 */
import { harnessForMcpHost } from "../../domain/harnesses.js";
import { runVisibilityDoctor } from "../visibility-doctor-service.js";
import type { VisibilityHostReport } from "../visibility-doctor-service.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "workspace-visibility" as const;

/**
 * The visibility engine speaks `McpHost` ids and the report speaks catalog ids.
 *
 * They differ for exactly one host — `claude` against `claude-code` — and that
 * one difference is enough to make a report list the same machine twice under
 * two names. Translated at the boundary, once.
 */
function catalogHost(host: string): string {
  return harnessForMcpHost(host as Parameters<typeof harnessForMcpHost>[0])?.id ?? host;
}

export const visibilityProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const result = await runVisibilityDoctor(input.ctx.fs, input.ctx.env, input.ctx.paths, {
      workspace: input.workspaceDir,
      global: true,
    });
    const reports = [...result.reports, ...result.global_reports];
    const findings: DoctorFinding[] = [];
    const coverages: ReturnType<typeof coverage>[] = [];
    // The visibility engine always inspects its own hardcoded set of hosts; the
    // run's selection is the aggregator's answer, and it is the one that counts.
    // `selectDoctorHosts` already split the participants from the hosts with no
    // trace here and applied `--only`. Without this filter the report enumerated
    // a host as absent and, two sections below, declared it `comprobada ✔` with
    // a healthy finding — and `--only kimi` still diagnosed claude-code, codex
    // and warp.
    const participants = new Set<string>(input.hosts.map((host) => host.host));

    for (const report of reports) {
      const host = catalogHost(report.host);
      if (!participants.has(host)) continue;
      if (report.status === "no-project-block") {
        coverages.push(
          coverage(
            CATEGORY,
            host,
            "not-applicable",
            `no hay bloque de proyecto para ${report.host} en ${input.workspaceDir}`,
          ),
        );
        continue;
      }
      coverages.push(coverage(CATEGORY, host, "checked"));
      findings.push(...driftFindings(report));
    }

    // Y el complemento: un host participante que este motor NO sabe mirar
    // declara `not-applicable`, no silencio. El motor sólo inspecciona
    // claude/codex/warp; filtrar sin decirlo dejaba una máquina cuyo único host
    // es gemini con CERO filas de esta categoría, y el agregador leía ese
    // silencio como «no se pudo comprobar» y sacaba el doctor en 1 sobre un
    // entorno sano. No mirar por diseño y no haber podido mirar son dos estados
    // distintos, y sólo el segundo escala.
    const covered = new Set(coverages.map((entry) => entry.host));
    const uncovered = input.hosts
      .filter((host) => !covered.has(host.host))
      .map((host) =>
        coverage(
          CATEGORY,
          host.host,
          "not-applicable",
          `la visibilidad multiroot no se declara para ${host.label}: sólo Claude Code, Codex y Warp registran rutas del workspace`,
        ),
      );

    return { coverage: [...dedupe(coverages), ...uncovered], findings };
  },
};

function driftFindings(report: VisibilityHostReport): DoctorFinding[] {
  const resource = `${report.scope}:visibilidad`;
  const host = catalogHost(report.host);
  const base = {
    host,
    category: CATEGORY,
    resource: {
      kind: "visibility" as const,
      name: `${host} (${report.scope})`,
      locator: report.target,
    },
    ownership: "ours" as const,
  };
  const findings: DoctorFinding[] = [];
  if (report.missing.length > 0) {
    findings.push({
      ...base,
      id: doctorFindingId(host, CATEGORY, `${resource}:faltantes`),
      state: "warning",
      summary: `${host} no tiene registradas ${report.missing.length} ruta(s) declarada(s)`,
      impact: "el host no ve esas fuentes: sus lecturas y ediciones ahí fallan",
      evidence: report.missing.map((path) => `falta: ${path}`),
      remediation: { kind: "manual", action: null, guidance: ["aw attach-multiroot"] },
      proposal: { op: "multiroot.attach", args: { scope: report.scope } },
    });
  }
  if (report.extra.length > 0) {
    findings.push({
      ...base,
      id: doctorFindingId(host, CATEGORY, `${resource}:sobrantes`),
      state: "warning",
      summary: `${host} tiene registradas ${report.extra.length} ruta(s) que nadie declaró`,
      impact: "el host ve directorios fuera del workspace declarado",
      evidence: report.extra.map((path) => `sobra: ${path}`),
      remediation: { kind: "manual", action: null, guidance: ["aw detach-multiroot"] },
      proposal: { op: "multiroot.detach", args: { scope: report.scope } },
    });
  }
  if (report.status === "no-settings") {
    findings.push({
      ...base,
      id: doctorFindingId(host, CATEGORY, `${resource}:sin-config`),
      state: "warning",
      summary: `${host} no tiene el archivo de configuración que declara sus rutas`,
      impact: "el host no ve ninguna fuente declarada del workspace",
      evidence: [`archivo esperado: ${report.target}`],
      remediation: { kind: "manual", action: null, guidance: ["aw attach-multiroot"] },
      proposal: { op: "multiroot.attach", args: { scope: report.scope } },
    });
  }
  if (findings.length === 0) {
    findings.push({
      ...base,
      id: doctorFindingId(host, CATEGORY, resource),
      state: "healthy",
      summary: `${host} tiene registradas exactamente las rutas declaradas (${report.scope})`,
      impact: "el host ve el workspace completo y nada más",
      evidence: [
        `archivo: ${report.target}`,
        `rutas registradas: ${report.registered_paths.length}`,
      ],
      remediation: { kind: "none", action: null, guidance: [] },
    });
  }
  return findings;
}

// A host inspected in both scopes reports its coverage twice; the report keeps
// one row per category and host.
function dedupe(entries: readonly ReturnType<typeof coverage>[]): ReturnType<typeof coverage>[] {
  const byHost = new Map<string, ReturnType<typeof coverage>>();
  for (const entry of entries) {
    const held = byHost.get(entry.host);
    if (held === undefined || held.state === "not-applicable") byHost.set(entry.host, entry);
  }
  return [...byHost.values()];
}
