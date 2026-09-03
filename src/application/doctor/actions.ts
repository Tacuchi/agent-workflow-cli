/**
 * Quién recibe una acción, y en un solo lugar.
 *
 * Los proveedores sugieren (`finding.proposal`); acá se decide. Es una sola
 * función a propósito: AC-08 promete que sólo los recursos atribuibles a
 * Workline se modifican, y una promesa que se cumple en seis archivos distintos
 * es seis lugares donde puede dejar de cumplirse. Los ajenos, los ambiguos y los
 * que tienen una credencial embebida salen de acá con guía y sin acción, sin
 * importar lo que el proveedor haya sugerido.
 *
 * También es donde nace el orden: `depends_on` se resuelve entre las acciones de
 * la MISMA corrida, porque una dependencia sólo puede nombrar algo que también
 * se va a ejecutar.
 */
import { custodyViolation } from "../../domain/doctor/auth.js";
import type { DoctorAction, DoctorFinding } from "../../domain/doctor/model.js";
import { doctorOperation } from "../../domain/doctor/operations.js";

/** El sano nunca lleva acción: no hay nada que reparar. */
const REPAIRABLE_STATES = new Set(["warning", "blocking", "unverified"]);

/**
 * La categoría que admite UNA sola operación, y por qué esa.
 *
 * En `tools-auth` el recurso no es un archivo: es un secreto de una persona. La
 * única acción admisible ahí es correr el flujo que su proveedor declaró —el que
 * hereda la terminal, para que el valor vaya de la persona al programa sin pasar
 * por el CLI—. Cualquier otra operación sobre esta categoría implicaría que el
 * CLI escribe la credencial en algún lado, y entonces la custodia del secreto
 * pasa a ser suya, que es exactamente lo que no puede pasar.
 *
 * Con el catálogo de hoy esto NO habilita nada: ningún proveedor real declara
 * flujo, así que ninguna variable DSN recibe una acción. Lo que habilita es la
 * maquinaria, probada con un doble.
 */
const CATEGORY_ONLY_OP: ReadonlyMap<string, string> = new Map([["tools-auth", "auth.flow"]]);

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
 * Cinco condiciones, y cada una es una forma distinta de que una acción no
 * corresponda: nadie la sugirió, el recurso no es nuestro, el estado no tiene
 * nada que reparar, la categoría no admite esa operación, o la evidencia dice
 * que hay una credencial embebida — y sobre un archivo que guarda un secreto de
 * otra persona no se escribe, aunque el recurso pareciera nuestro.
 *
 * La custodia de un flujo se comprueba acá TAMBIÉN, y no es una guarda repetida:
 * las dos deciden cosas distintas. El proveedor de diagnóstico decide el ESTADO
 * PUBLICADO —es el único que puede degradar su propio hallazgo a bloqueante con
 * la razón, y por eso la persona se entera— y esta decide la ELEGIBILIDAD. Hacen
 * falta las dos porque el proveedor de `tools-auth` es UN productor de
 * sugerencias y este es el punto por donde pasa TODA acción: `flow` vive en la
 * sugerencia compartida, así que cualquier proveedor de cualquier categoría podría
 * adjuntar uno, y sellar un `argv` con una credencial adentro es el defecto más
 * caro que este plan puede tener. Cada una tiene su propia prueba, así que
 * ninguna tapa a la otra.
 */
function isEligible(finding: DoctorFinding): boolean {
  if (finding.proposal === undefined) return false;
  if (finding.ownership !== "ours") return false;
  if (!REPAIRABLE_STATES.has(finding.state)) return false;
  const only = CATEGORY_ONLY_OP.get(finding.category);
  if (only !== undefined && finding.proposal.op !== only) return false;
  return !hasEmbeddedCredentialEvidence(finding);
}

/** La evidencia que el proveedor de MCPs escribe cuando encuentra una credencial. */
function hasEmbeddedCredentialEvidence(finding: DoctorFinding): boolean {
  return finding.evidence.some((line) => line.includes("credencial embebida"));
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
  // Un flujo que no puede preservar la custodia NO se vuelve acción, venga de
  // donde venga. Es la misma regla del dominio, aplicada en el punto por donde
  // toda acción pasa: acá no hay a quién explicarle la razón —eso lo hace el
  // hallazgo del proveedor—, pero sí hay qué impedir.
  if (hint.flow !== undefined && custodyViolation(hint.flow) !== null) return null;

  const dependsOn: string[] = [];
  if (hint.op === "self.install-hooks") {
    const install = installByHost.get(finding.host);
    if (install !== undefined) dependsOn.push(install);
  }

  return {
    op: spec.op,
    args: { ...hint.args },
    // Las clases de la operación MÁS las que el flujo declara. Aprobar un lote
    // que corre un flujo que sale a la red bajo una aprobación que sólo cubría
    // `execute` sería una autorización que no autorizó lo que pasó.
    effects: [...new Set([...spec.effects, ...(hint.flow?.effects ?? [])])],
    depends_on: dependsOn,
    expected: spec.expected,
    // El `argv` queda SELLADO en la acción: aprobar un lote que ejecuta un
    // comando es aprobar sus tokens exactos, y quien los corre no vuelve a
    // resolverlos.
    ...(hint.flow === undefined ? {} : { argv: [...hint.flow.argv] }),
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
