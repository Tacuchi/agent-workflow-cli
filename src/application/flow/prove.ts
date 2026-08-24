/**
 * `aw flow prove` — produce the boundary's `CheckoutProof` and check it BEFORE the
 * submit that would charge for getting it wrong.
 *
 * It exists because the only previously known way to obtain a valid proof was to
 * import the CLI's own modules and re-derive the digest formula by hand. That
 * recipe works, but it makes the formula a de facto public API and it is not
 * discoverable: every executor paid the same tuition, and the tuition is a
 * boundary's attempts.
 *
 * Two properties are load-bearing:
 *
 *  - **It writes nothing.** The digest expires on every write to the tree being
 *    proved, so a capture that touched that tree would invalidate its own result.
 *  - **It prevalidates with the SAME policy `submit` applies**, not a copy of its
 *    rules. A second implementation would eventually disagree, and a proof this
 *    surface blessed being rejected downstream is worse than no surface at all.
 *    One deliberate asymmetry, and it runs in the safe direction only: an unstable
 *    fingerprint is a hard refusal HERE while `submit` merely records it and lets a
 *    matching digest through. So this surface can refuse a capture the submit would
 *    have taken — never the reverse. It fails closed by requirement, not by drift.
 *
 * It never advances the boundary and never spends an attempt: it only reads.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { journeyOfFlow } from "../../domain/flow/authority.js";
import type { FlowBoundaryKind } from "../../domain/flow/directive.js";
import {
  type CheckoutIdentity,
  type CheckoutProof,
  SOURCE_BOUNDED_EVIDENCE,
} from "../../domain/source-boundary.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { PathsService } from "../paths-service.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import { validateCheckoutProof } from "../source-boundary-policy.js";
import { resolveBoundary } from "./advance.js";
import { observeCheckout, resolveCheckoutCandidates } from "./checkout-observation.js";
import { locateRun, readRun } from "./run-state-service.js";

export interface ProveFlowInput {
  code?: string;
  contextId?: string;
  /** Which eligible alias to prove. Defaults to the documentary checkout. */
  source?: string;
  /**
   * Repo-relative artifact to attest instead of the sealed invocation.
   *
   * Present ⇒ an `inspection` proof. Absent ⇒ a `command` proof built from the
   * invocation the boundary sealed, which is the shape almost every boundary wants.
   */
  artifact?: string;
  git: GitPort;
}

/** What the capture produced, plus everything needed to place it in the envelope. */
export interface CheckoutProofReceipt {
  session: string;
  /** The transition the run is standing on, or `null` on a finished journey. */
  boundary: string | null;
  /** The evidence ids this boundary demands, so the reason a proof is needed is visible. */
  evidence: readonly string[];
  /** Alias and the local root the digest was computed over, on THIS host. */
  checkout: CheckoutIdentity;
  /** The proof, ready to paste. Prevalidated by the policy that judges the submit. */
  proof: CheckoutProof;
  /** Where it goes, said once so nobody has to guess the nesting. */
  usage: string;
}

export type ProveFlowResult =
  | { ok: true; receipt: CheckoutProofReceipt }
  | { ok: false; failure: CapabilityFailure }
  | { ok: false; session: SessionResolutionError };

/**
 * The alias is not one this run can prove — and the two reasons need different fixes.
 *
 * With nothing eligible at all, "use workspace" would be advice to repeat what the
 * caller just did: the failure is upstream, in a workspace boundary that could not
 * be read. Only when there ARE eligible sources is naming them the useful answer.
 */
function notEligible(wanted: string, candidates: readonly CheckoutIdentity[]): CapabilityFailure {
  if (candidates.length === 0) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message: `esta corrida no pudo resolver ninguna frontera elegible, así que '${wanted}' no se puede probar`,
      action:
        "el límite del workspace no se pudo leer: comprobá que el marcador de Workline y su bloque de fuentes existan y sean legibles desde este directorio",
    };
  }
  return {
    code: "WORKLINE_CHECKOUT_PROOF_INVALID",
    message: `'${wanted}' no es una fuente elegible de esta corrida (elegibles: ${candidates
      .map((candidate) => candidate.source)
      .join(", ")})`,
    action:
      "usá 'workspace' para el checkout documental, o el alias de una unidad de aislamiento que esta sesión ya tomó",
  };
}

/**
 * Why there is nothing to capture here, said as the thing to do about it.
 *
 * Keyed off the boundary KIND, not off "the action is missing". Those are not the
 * same question: an action is absent at a semantic boundary, a human one AND at an
 * authorization gate, and only the last of the three is fixed by approving an
 * effect. Telling the other two to approve something sends the reader to a control
 * that is not there — the same misdirection this surface exists to stop.
 */
function notApplicable(
  boundary: string | null,
  kind: FlowBoundaryKind,
  blocked: CapabilityFailure | null,
): CapabilityFailure {
  if (boundary === null) {
    return {
      code: "FLOW_PROVE_NOT_APPLICABLE",
      message: "el recorrido ya terminó: no hay frontera que exija un CheckoutProof",
      action: "no queda trabajo pendiente en este recorrido",
    };
  }
  // A blocked boundary already declares WHY, and that cause is the only actionable
  // thing here. The directive contract refuses to emit a block without its error;
  // a read surface over the same boundary must not quietly drop it either.
  if (kind === "blocked" && blocked !== null) {
    return {
      code: "FLOW_PROVE_NOT_APPLICABLE",
      message: `'${boundary}' está bloqueada (${blocked.code}): ${blocked.message}`,
      action: blocked.action ?? "resolvé la causa del bloqueo antes de capturar una prueba",
    };
  }
  if (kind === "authorization") {
    return {
      code: "FLOW_PROVE_NOT_APPLICABLE",
      message: `'${boundary}' está esperando que autorices su efecto, así que todavía no selló su invocación`,
      action:
        "aprobá el efecto que la directiva nombra y volvé a capturar: la invocación se sella recién ahí, y una prueba sin invocación sellada no acredita nada",
    };
  }
  return {
    code: "FLOW_PROVE_NOT_APPLICABLE",
    message: `'${boundary}' no exige evidencia '${SOURCE_BOUNDED_EVIDENCE}'`,
    action:
      "avanzá con 'aw flow advance' hasta una frontera que la exija; su directiva lo dice en 'evidencia exigida'",
  };
}

export async function proveFlowBoundary(
  fs: FileSystemPort,
  paths: PathsService,
  input: ProveFlowInput,
): Promise<ProveFlowResult> {
  // A read intent: proving is not a walk and must never bind, advance or mutate.
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "read",
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind: false,
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };
  const session = resolution.session.folder;

  const run = await readRun(fs, locateRun(paths, session));
  if (!run.ok) return { ok: false, failure: run.failure };

  const resolved = resolveBoundary(run.state, journeyOfFlow(run.state.flow));
  const action = resolved.action;
  if (action === null || !action.evidence.includes(SOURCE_BOUNDED_EVIDENCE)) {
    // Three different situations, and they need three different sentences. Saying
    // "it demands no such evidence" when the run is merely parked at an unapproved
    // effect would be the same wrong blame this surface exists to end: the row may
    // demand it, but no invocation has been sealed yet, so there is nothing to prove.
    return {
      ok: false,
      failure: notApplicable(resolved.stopped?.id ?? null, resolved.kind, resolved.error),
    };
  }

  const wanted = input.source ?? "workspace";
  const candidates = await resolveCheckoutCandidates(fs, paths, session);
  const identity = candidates.find((candidate) => candidate.source === wanted);
  if (identity === undefined) return { ok: false, failure: notEligible(wanted, candidates) };

  // The SAME observation `submit` makes, from the same function. What differs is the
  // policy applied to it, and only in the strict direction: `submit` keeps an
  // unstable reading so its rejection can say the fingerprint moved, while a
  // capture refuses to hand back a proof built on one.
  const state = await observeCheckout(fs, input.git, identity);
  if (state === null) {
    return {
      ok: false,
      failure: {
        code: "FLOW_PROVE_CHECKOUT_UNOBSERVABLE",
        // Three causes reach here and the message names all three, because it used
        // to assert the first two and fire on the third: a root can exist, be a
        // repo, and still yield no fingerprint (un HEAD sin commits, un gitdir
        // movido, el índice tomado). Denying facts that hold is the wrong-blame
        // this surface exists to stop.
        message: `no se pudo observar la raíz de '${identity.source}' (${identity.root}): o no existe, o no es un checkout git, o git no pudo leerla`,
        action:
          "comprobá que esa raíz responda a 'git status' y tenga al menos un commit; para 'workspace' es el ancestro con el marcador de Workline, y para otro alias tomá su unidad con 'aw worktree ensure --source <alias> --code <NNN>'",
      },
    };
  }
  if (state.reproducible === false) {
    return {
      ok: false,
      failure: {
        code: "FLOW_PROVE_FINGERPRINT_UNSTABLE",
        message: `la huella de '${identity.source}' (${identity.root}) no coincide entre dos cómputos consecutivos`,
        action:
          "algo está escribiendo en esa raíz: estabilizala y volvé a capturar, porque una prueba sobre una huella inestable sería rechazada igual",
      },
    };
  }
  const proof: CheckoutProof =
    input.artifact === undefined
      ? {
          kind: "command",
          source: identity.source,
          relative_cwd: ".",
          checkout_digest: state.digest,
          // The sealed invocation's program and args, and ONLY those: `target` and
          // `input` belong to the directive's invocation, and carrying them into a
          // proof is the most natural way to get one rejected — the whole object is
          // right there, so copying it whole is the obvious wrong move.
          invocation: { program: action.invocation.program, args: [...action.invocation.args] },
        }
      : {
          kind: "inspection",
          source: identity.source,
          relative_cwd: ".",
          checkout_digest: state.digest,
          invocation: { artifact: input.artifact },
        };

  // The same function `submit` runs. If this ever disagrees with the submit, it is
  // because the tree moved in between — never because two rule sets drifted apart.
  const rejection = validateCheckoutProof(proof, [state]);
  if (rejection !== null) {
    return {
      ok: false,
      failure: {
        code: rejection.code,
        message: `la prueba capturada no pasa su propia prevalidación: ${rejection.message}`,
        action:
          "no la envíes: corregí lo que el mensaje nombra y volvé a capturar, que es gratis y no gasta el intento de la frontera",
      },
    };
  }

  return {
    ok: true,
    receipt: {
      session,
      boundary: resolved.stopped?.id ?? null,
      evidence: action.evidence,
      checkout: identity,
      proof,
      // The id is spelled out because the validator does not search: it looks up
      // exactly the item called `workline.source-bounded`. Hanging the proof on any
      // other item of the list reads as a proof that never arrived, and that costs
      // an attempt — which is the cost this surface exists to avoid.
      usage: `va como campo 'proof' del ítem de 'validations' cuyo id es exactamente '${SOURCE_BOUNDED_EVIDENCE}', no de otro ítem de la lista. Caduca con la próxima escritura a esa raíz: no toques el árbol entre esta captura y el submit.`,
    },
  };
}
