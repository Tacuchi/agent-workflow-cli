/**
 * Tools and authentication — un recorrido por el registro de proveedores.
 *
 * Este archivo no sabe qué es un DSN. Camina el registro, le pregunta a cada
 * proveedor qué sujetos tiene y en qué estado están, y traduce eso al modelo
 * común. Lo que antes estaba cableado acá vive ahora en `auth-dsn.ts`, y la
 * diferencia importa: agregar una cosa autenticable es agregar un proveedor al
 * registro, no editar el diagnóstico.
 *
 * También es el único choke point de la custodia. Los proveedores declaran su
 * flujo; acá se comprueba con `custodyViolation` ANTES de que exista cualquier
 * sugerencia de acción, así que un flujo que pondría el secreto en un argumento
 * —o que no hereda la terminal, o que escribiría— sale como bloqueante con su
 * razón y sin proposal. Como los proveedores no construyen hallazgos, no hay
 * ningún camino que se saltee esta comprobación.
 */
import {
  type DoctorAuthCheck,
  type DoctorAuthState,
  type DoctorAuthSubject,
  authFindingState,
  custodyViolation,
} from "../../domain/doctor/auth.js";
import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
import { DOCTOR_AUTH_PROVIDERS, type DoctorAuthCliProvider } from "./auth-registry.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "tools-auth" as const;
const SCOPE_HOST = "workspace";

export interface ToolsAuthProviderDeps {
  /** El registro. Inyectable para probar la maquinaria con un doble. */
  providers?: readonly DoctorAuthCliProvider[];
}

export function createToolsAuthProvider(deps: ToolsAuthProviderDeps = {}): DoctorProvider {
  const providers = deps.providers ?? DOCTOR_AUTH_PROVIDERS;
  return {
    category: CATEGORY,
    async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
      const enumerated = providers.flatMap((provider) =>
        provider.subjects(input.ctx).map((subject) => ({ provider, subject })),
      );
      if (enumerated.length === 0) {
        return {
          coverage: [
            coverage(
              CATEGORY,
              SCOPE_HOST,
              "not-applicable",
              "no hay ninguna cosa autenticable registrada en este entorno",
            ),
          ],
          findings: [],
        };
      }

      const findings: DoctorFinding[] = [];
      const seen = new Map<string, string>();
      for (const { provider, subject } of enumerated) {
        const owner = seen.get(subject.id);
        if (owner !== undefined) {
          findings.push(collisionFinding(subject, owner, provider.id));
          continue;
        }
        seen.set(subject.id, provider.id);
        findings.push(await subjectFinding(provider, subject, input));
      }
      return { coverage: [coverage(CATEGORY, SCOPE_HOST, "checked")], findings };
    },
  };
}

export const toolsAuthProvider: DoctorProvider = createToolsAuthProvider();

/**
 * Qué dice el informe de cada estado de autenticación.
 *
 * La tabla existe para que el mapeo estado → hallazgo viva en UN lugar: el
 * estado sale de `authFindingState`, en el dominio, y la prosa de acá. Antes la
 * rama sana cortaba antes de llegar al mapeo y el resto se decidía con dos
 * ternarios en el call site, así que la mitad de la regla vivía en el proveedor y
 * la rama `present` del dominio no la alcanzaba ningún camino.
 */
const SUBJECT_PROSE: Record<
  DoctorAuthState,
  { summary: (label: string) => string; impact: string }
> = {
  present: {
    summary: (label) => `la autenticación de (${label}) está resuelta`,
    impact: "el recurso que depende de esta credencial puede autenticarse",
  },
  absent: {
    summary: (label) => `falta la autenticación de (${label})`,
    impact: "el recurso que depende de esta credencial va a fallar cuando se use",
  },
  unverified: {
    summary: (label) => `no se pudo verificar la autenticación de (${label})`,
    impact: "el recurso puede estar sin autenticar y el informe no puede afirmar lo contrario",
  },
};

async function subjectFinding(
  provider: DoctorAuthCliProvider,
  subject: DoctorAuthSubject,
  input: DoctorProviderInput,
): Promise<DoctorFinding> {
  const observed = await observe(provider, subject, input);
  const base = {
    id: doctorFindingId(SCOPE_HOST, CATEGORY, subject.id),
    host: SCOPE_HOST,
    category: CATEGORY,
    resource: { kind: "credential" as const, name: subject.label, locator: subject.locator },
    evidence: observed.evidence,
    ownership: "ours" as const,
  };

  const flow = provider.flow(subject, input.ctx);
  const custody = flow === null ? null : custodyViolation(flow);
  if (flow !== null && custody !== null) {
    // La custodia se rompe por la DECLARACIÓN, no por el estado del sujeto: un
    // flujo así es peligroso aunque la credencial ya esté puesta, y que el
    // veredicto salga 1 es lo correcto — es un defecto de este CLI, no del
    // entorno de la persona.
    return {
      ...base,
      state: "blocking",
      summary: `el flujo declarado para (${subject.label}) no puede preservar la custodia del secreto`,
      impact: "no se ofrece ninguna reparación automática: correrlo filtraría la credencial",
      evidence: [...observed.evidence, `custodia: ${custody}`],
      remediation: {
        kind: "manual",
        action: null,
        guidance: [
          ...provider.guidance(subject, input.ctx),
          `el flujo del proveedor (${provider.id}) quedó bloqueado y hay que corregirlo en el CLI`,
        ],
      },
    };
  }

  const prose = SUBJECT_PROSE[observed.state];
  const authenticated = observed.state === "present";
  const finding: DoctorFinding = {
    ...base,
    state: authFindingState(observed.state),
    summary: prose.summary(subject.label),
    impact: prose.impact,
    // Al sano no se le ofrece nada: no hay remedio para lo que no está roto. Los
    // otros dos llevan la guía del proveedor, que nombra la variable y el archivo
    // y nunca el valor.
    remediation: authenticated
      ? { kind: "none", action: null, guidance: [] }
      : { kind: "manual", action: null, guidance: provider.guidance(subject, input.ctx) },
  };
  // Un flujo declarado que pasa la custodia es una SUGERENCIA, no una acción:
  // quién la recibe lo decide el anotador, en un solo lugar, con los predicados
  // de propiedad. Y al sano no se le sugiere: la sugerencia existe para que algo
  // se repare.
  if (flow === null || authenticated) return finding;
  return {
    ...finding,
    proposal: { op: "auth.flow", args: { provider: provider.id, subject: subject.id }, flow },
  };
}

/**
 * Qué se observó del sujeto: la lectura barata, o la verificación si se pidió.
 *
 * La verificación REEMPLAZA a `check` en vez de acompañarla. Son dos lecturas
 * del mismo hecho, y ponerlas juntas en la evidencia las hace leer como dos
 * hechos distintos; la verificación es la observación más fuerte y es la que
 * queda.
 *
 * Y el nivel de autorización que el proveedor DECLARA se hace valer acá, que es
 * el único lugar que llama a `verify`. Antes el campo `authorization` no lo leía
 * nadie: cada proveedor repetía el control adentro de su propio `run`, así que la
 * declaración podía mentir sin consecuencia y un proveedor nuevo que se olvidara
 * del control salía de la máquina en una corrida donde nadie autorizó nada. Con
 * el control acá, `run` puede confiar en que su autorización está concedida.
 *
 * Cuando falta esa autorización la observación se DEGRADA a la lectura barata y
 * lo dice en la evidencia: una verificación que no corrió y se calla se lee como
 * una que corrió.
 */
async function observe(
  provider: DoctorAuthCliProvider,
  subject: DoctorAuthSubject,
  input: DoctorProviderInput,
): Promise<DoctorAuthCheck> {
  const granted = input.verifyAuthorization;
  if (granted === undefined) return await provider.check(subject, input.ctx);
  const needed = provider.verify.authorization;
  if (needed !== null && !granted.includes(needed)) {
    const shallow = await provider.check(subject, input.ctx);
    return {
      ...shallow,
      evidence: [
        ...shallow.evidence,
        `la verificación profunda NO corrió: esta corrida no autorizó '${needed}' (lo autoriza \`aw doctor --verify-connection\`)`,
      ],
    };
  }
  return await provider.verify.run(subject, input.ctx, granted);
}

/**
 * Dos sujetos con el mismo id, denunciado en vez de perdido.
 *
 * El id del sujeto es la identidad del hallazgo. Dos iguales colapsan en una
 * fila y el informe pierde uno sin decir nada — el mismo defecto que ya costó
 * una ronda en este plan, cuando sanear un id lo volvió no inyectivo y los
 * hallazgos desaparecieron de un `Map`. Así que la colisión es bloqueante y
 * nombra a los dos proveedores.
 */
function collisionFinding(
  subject: DoctorAuthSubject,
  owner: string,
  duplicate: string,
): DoctorFinding {
  return {
    // El id lleva al proveedor DUPLICADO y no sólo al sujeto: con tres
    // proveedores declarando lo mismo, dos colisiones distintas colapsarían en
    // una fila y el informe volvería a perder un hallazgo — que es exactamente
    // el defecto que esta rama existe para denunciar.
    id: doctorFindingId(SCOPE_HOST, CATEGORY, `colision:${duplicate}:${subject.id}`),
    host: SCOPE_HOST,
    category: CATEGORY,
    resource: { kind: "credential", name: subject.label, locator: subject.locator },
    state: "blocking",
    summary: `dos proveedores de autenticación declaran el sujeto ${subject.id}`,
    impact: "uno de los dos no se comprobó y el informe no puede hablar por él",
    evidence: [`lo declaran los proveedores (${owner}) y (${duplicate})`],
    ownership: "ours",
    remediation: {
      kind: "manual",
      action: null,
      guidance: [`prefijá los ids de sujeto del proveedor (${duplicate}) para que no colisionen`],
    },
  };
}
