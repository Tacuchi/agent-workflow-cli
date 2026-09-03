import type { CliContext } from "../../cli/types.js";
/**
 * The aggregate: run every provider, consolidate, redact, and let the verdict
 * fall out of what was found.
 *
 * A provider that throws does not take the report down with it. Its category
 * becomes `unavailable` WITH THE REASON on every participating host, and the
 * verdict turns non-zero — because a doctor that answers 0 after failing to look
 * is read as "healthy", which is the one thing it must never say by accident.
 */
import {
  DOCTOR_SCHEMA_VERSION,
  type DoctorCoverage,
  type DoctorFinding,
  type DoctorReport,
  doctorFindingId,
  doctorVerdict,
  sortDoctorCoverage,
  sortDoctorFindings,
  summarizeDoctorFindings,
} from "../../domain/doctor/model.js";
import type { HarnessId } from "../../domain/harnesses.js";
import { redactSensitiveValue } from "../../domain/redaction.js";
import { readPackageVersion } from "../../runtime/version.js";
import { DOCTOR_HOST_ORDER, type DoctorHostSelection, selectDoctorHosts } from "./hosts.js";
import { installationProvider } from "./provider-installation.js";
import { type McpsProviderDeps, createMcpsProvider } from "./provider-mcps.js";
import { pluginsHooksProvider } from "./provider-plugins-hooks.js";
import { skillsProvider } from "./provider-skills.js";
import { toolsAuthProvider } from "./provider-tools-auth.js";
import { visibilityProvider } from "./provider-visibility.js";
import { type DoctorProvider, type DoctorProviderInput, coverage } from "./types.js";

export interface DoctorRunOptions {
  /** The host the run was invoked from. Highlights; never filters. */
  host?: string | null;
  /** Restricts the run to these hosts. This one DOES filter. */
  only?: readonly string[];
  skipNative?: boolean;
}

export interface DoctorRunDeps {
  providers?: readonly DoctorProvider[];
  mcps?: McpsProviderDeps;
}

export function defaultDoctorProviders(deps: McpsProviderDeps = {}): DoctorProvider[] {
  return [
    installationProvider,
    createMcpsProvider(deps),
    skillsProvider,
    toolsAuthProvider,
    pluginsHooksProvider,
    visibilityProvider,
  ];
}

export async function runDoctor(
  ctx: CliContext,
  options: DoctorRunOptions = {},
  deps: DoctorRunDeps = {},
): Promise<DoctorReport> {
  const currentHost = normalizeHost(options.host ?? null);
  const only = [...(options.only ?? [])];
  const selection = await selectDoctorHosts(ctx, { currentHost, only });
  const workspaceDir = ctx.paths.workspaceDir();

  const input: DoctorProviderInput = {
    ctx,
    hosts: selection.hosts,
    hostStates: selection.states,
    currentHost,
    workspaceDir,
    skipNative: options.skipNative === true,
  };

  // Un `--only` mal escrito se denuncia ANTES de mirar nada: es lo único que
  // explica por qué la corrida no cubrió lo que la persona creía haber pedido.
  const findings: DoctorFinding[] = selection.unknownOnly.map(unknownOnlyFinding);
  const coverages: DoctorCoverage[] = [];
  for (const provider of deps.providers ?? defaultDoctorProviders(deps.mcps)) {
    try {
      const output = await provider.run(input);
      findings.push(...output.findings);
      // Silencio NO es cobertura: una categoría que desaparece del informe deja
      // a `doctorVerdict` sin nada que ver y el doctor sale 0 después de no
      // haber mirado (AC-02, AC-14). Pero el estado del relleno es
      // `not-applicable`, NO `unavailable`: un proveedor calla cuando la corrida
      // no le dio ningún host que le corresponda —una máquina sin ningún host de
      // agente, o un `--only` que no dejó participantes—, y eso es «no había
      // nada que comprobar», no «no se pudo comprobar». Marcarlo caído ponía en
      // rojo un entorno sano; lo que sí escala es el proveedor que LANZA, abajo,
      // y un `--only` que nombra lo que el catálogo no declara, que ya viaja
      // como hallazgo bloqueante.
      coverages.push(
        ...(output.coverage.length > 0
          ? output.coverage
          : [coverage(provider.category, "workspace", "not-applicable", silenceReason(selection))]),
      );
    } catch (error) {
      const reason = `el proveedor falló: ${messageOf(error)}`;
      const scopes =
        selection.hosts.length > 0 ? selection.hosts.map((h) => h.host) : ["workspace"];
      for (const host of scopes) {
        coverages.push(coverage(provider.category, host, "unavailable", reason));
      }
    }
  }

  const hostOrder = [...DOCTOR_HOST_ORDER, "workspace"];
  const orderedFindings = sortDoctorFindings(findings, hostOrder);
  const orderedCoverage = sortDoctorCoverage(coverages, hostOrder);

  const report: DoctorReport = {
    schema_version: DOCTOR_SCHEMA_VERSION,
    cli_version: readPackageVersion(),
    scope: { workspace_dir: workspaceDir, current_host: currentHost, only },
    hosts: selection.hosts.map(({ mcp_host: _mcpHost, ...view }) => view),
    hosts_absent: selection.absent,
    coverage: orderedCoverage,
    findings: orderedFindings,
    summary: summarizeDoctorFindings(orderedFindings),
    verdict: doctorVerdict(orderedFindings, orderedCoverage),
  };

  // Last line of defence, over the WHOLE object and once: the same redaction the
  // CLI already applies to every command's output. A provider that reads a file
  // holding a credential cannot leak it past here.
  return redactSensitiveValue(report) as DoctorReport;
}

/**
 * Por qué una categoría no declaró ni una fila de cobertura.
 *
 * Las tres razones son distintas y la persona necesita la suya: un filtro que
 * no existe, una selección sin hosts, o un proveedor que miró y no dijo nada.
 */
function silenceReason(selection: DoctorHostSelection): string {
  if (selection.unknownOnly.length > 0) {
    return `no había nada que comprobar: --only nombra hosts que el catálogo no declara (${selection.unknownOnly.join(", ")})`;
  }
  if (selection.hosts.length === 0) {
    return "no había nada que comprobar: ningún host participa en esta corrida";
  }
  return "el proveedor no declaró cobertura para ningún host de la corrida";
}

/**
 * El hallazgo de un `--only` que el catálogo no conoce.
 *
 * Bloqueante a propósito: la corrida NO miró el host que se pidió, y un cero
 * ahí se lee como «tu entorno está sano». La sugerencia sale del catálogo, así
 * que `--only claude` apunta a `claude-code` sin que este módulo cablee ningún
 * alias propio.
 */
function unknownOnlyFinding(name: string): DoctorFinding {
  const near = DOCTOR_HOST_ORDER.filter((id) => id.includes(name) || name.includes(id));
  const evidence = [`el catálogo declara: ${DOCTOR_HOST_ORDER.join(", ")}`];
  if (near.length > 0) evidence.push(`el nombre más parecido del catálogo: ${near.join(", ")}`);
  return {
    id: doctorFindingId("workspace", "installation-hosts", `--only=${name}`),
    host: "workspace",
    category: "installation-hosts",
    resource: { kind: "filtro", name: `--only=${name}`, locator: null },
    state: "blocking",
    summary: `--only nombra «${name}», que el catálogo de hosts no declara`,
    impact: "el diagnóstico no cubrió el host que pediste y no puede hablar por él",
    evidence,
    ownership: "n/a",
    remediation: {
      kind: "manual",
      action: null,
      guidance: [
        near.length > 0
          ? `repetí la corrida con --only ${near[0]}`
          : "repetí la corrida con un id del catálogo, o sin --only para mirar todos los hosts",
      ],
    },
  };
}

function normalizeHost(host: string | null): HarnessId | null {
  if (host === null) return null;
  return (DOCTOR_HOST_ORDER as readonly string[]).includes(host) ? (host as HarnessId) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
