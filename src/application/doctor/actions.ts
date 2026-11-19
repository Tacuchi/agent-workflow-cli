/**
 * Quién recibe una acción, y en un solo lugar.
 *
 * Los proveedores sugieren (`finding.proposal`); acá se decide. Es una sola
 * función a propósito: AC-08 promete que sólo los recursos atribuibles a
 * agent-workflow se modifican, y una promesa que se cumple en seis archivos distintos
 * es seis lugares donde puede dejar de cumplirse. Los ajenos y los ambiguos
 * salen de acá con guía y sin acción, sin importar lo que el proveedor haya
 * sugerido.
 *
 * También es donde nace el orden: `depends_on` se resuelve entre las acciones de
 * la MISMA corrida, porque una dependencia sólo puede nombrar algo que también
 * se va a ejecutar.
 */
import type { DoctorAction, DoctorFinding } from "../../domain/doctor/model.js";
import { doctorOperation } from "../../domain/doctor/operations.js";

/** El sano nunca lleva acción: no hay nada que reparar. */
const REPAIRABLE_STATES = new Set(["warning", "blocking", "unverified"]);

export function annotateRepairs(findings: readonly DoctorFinding[]): DoctorFinding[] {
  const eligible = new Set(findings.filter(isEligible).map((finding) => finding.id));
  // Instalar el bundle en un host es la precondición de armar sus hooks: si las
  // dos acciones entran al mismo lote, la de hooks va después. Se resuelve entre
  // las acciones de ESTA corrida, no contra el catálogo, porque una dependencia
  // que nombra algo que nadie va a ejecutar bloquea para siempre.
  const installByHost = new Map<string, string>();
  for (const finding of findings) {
    if (!eligible.has(finding.id)) continue;
    if (finding.proposal?.op === "self.install-skill") installByHost.set(finding.host, finding.id);
  }

  return findings.map((finding) => {
    const { proposal, ...rest } = finding;
    if (!eligible.has(finding.id)) return withoutAction(rest, finding);
    const action = buildAction(finding, installByHost);
    if (action === null) return withoutAction(rest, finding);
    return { ...rest, remediation: { ...finding.remediation, kind: "supported", action } };
  });
}

/**
 * El gate, y nada más que el gate.
 *
 * Tres condiciones, y cada una es una forma distinta de que una acción no
 * corresponda: nadie la sugirió, el recurso no es nuestro, o el estado no tiene
 * nada que reparar.
 */
function isEligible(finding: DoctorFinding): boolean {
  if (finding.proposal === undefined) return false;
  if (finding.ownership !== "ours") return false;
  return REPAIRABLE_STATES.has(finding.state);
}

function buildAction(
  finding: DoctorFinding,
  installByHost: ReadonlyMap<string, string>,
): DoctorAction | null {
  const hint = finding.proposal;
  if (hint === undefined) return null;
  const spec = doctorOperation(hint.op);
  // Una sugerencia que nombra una operación que el catálogo no declara se
  // descarta en silencio hacia la guía manual: el catálogo es la autoridad sobre
  // qué se puede ejecutar, y una acción sin especificación no tiene ni clases de
  // efecto que aprobar.
  if (spec === null) return null;

  const dependsOn: string[] = [];
  if (hint.op === "self.install-hooks") {
    const install = installByHost.get(finding.host);
    if (install !== undefined) dependsOn.push(install);
  }

  return {
    op: spec.op,
    args: { ...hint.args },
    effects: [...spec.effects],
    depends_on: dependsOn,
    expected: spec.expected,
  };
}

/**
 * Sin acción, y con la guía que ya traía.
 *
 * `kind` se degrada a `manual` sólo si había una sugerencia: un hallazgo que
 * nunca propuso nada conserva el `none` o el `manual` que su proveedor decidió,
 * porque «no hay acción segura» y «hay que hacerlo a mano» son respuestas
 * distintas y el proveedor es el que sabe cuál es.
 */
function withoutAction(
  rest: Omit<DoctorFinding, "proposal">,
  original: DoctorFinding,
): DoctorFinding {
  if (original.proposal === undefined) {
    return { ...rest, remediation: { ...original.remediation, action: null } };
  }
  const spec = doctorOperation(original.proposal.op);
  const guidance =
    original.remediation.guidance.length > 0
      ? original.remediation.guidance
      : spec === null
        ? []
        : [spec.verb(original.proposal.args)];
  return {
    ...rest,
    remediation: {
      kind: original.remediation.kind === "none" ? "none" : "manual",
      action: null,
      guidance,
    },
  };
}
