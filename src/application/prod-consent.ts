import { HARNESSES } from "../domain/harnesses.js";
import type { EnvPort } from "../ports/env.js";

/**
 * Who is asking to publish in PROD, and the consent only the person can give.
 *
 * Spec 051: only the person publishes in PROD, and where Workline cannot tell
 * the person from an agent it does not publish. The agent's ordinary path — its
 * Bash tool — has no terminal; agents that open a terminal of their own export a
 * marker. Either one is enough to deny.
 */

/**
 * Warp is the person's terminal, not an agent: its marker and its TERM_PROGRAM
 * never deny. Its agent, Oz, marks with its own variable, which does. That is
 * also why this does not reuse `runHarness`, which reads Warp as the host.
 */
const PERSON_TERMINALS: ReadonlySet<string> = new Set(["warp"]);

/** Exported by Claude Code and shared as a convention across agents. */
const SHARED_AGENT_MARKER = "AI_AGENT";

export const AGENT_MARKERS: readonly string[] = [
  ...HARNESSES.filter((h) => !PERSON_TERMINALS.has(h.id)).flatMap((h) => h.envMarkers),
  SHARED_AGENT_MARKER,
];

export type Attribution = { person: true } | { person: false; reason: string };

// Only the two readings below produce an attribution a consent can rest on: a
// literal `{ person: true }` written by some caller grants nothing.
const attributed = new WeakSet<Attribution>();

function attribution(value: Attribution): Attribution {
  attributed.add(value);
  return value;
}

/** The first agent marker present in the environment, or null. */
export function agentMarkerIn(env: EnvPort): string | null {
  return AGENT_MARKERS.find((marker) => env.get(marker) !== undefined) ?? null;
}

/** A CLI invocation is the person's only with a terminal on both ends and no agent marker. */
export function attributeCliInvocation(env: EnvPort, hasTty: boolean): Attribution {
  if (!hasTty) {
    return attribution({
      person: false,
      reason: "la invocación no tiene terminal interactiva en la entrada y la salida",
    });
  }
  return attributeByMarkers(env);
}

/** The TUI always owns a terminal: what denies a keypress there is an agent marker. */
export function attributeTuiKeypress(env: EnvPort): Attribution {
  return attributeByMarkers(env);
}

function attributeByMarkers(env: EnvPort): Attribution {
  const marker = agentMarkerIn(env);
  return attribution(
    marker === null
      ? { person: true }
      : { person: false, reason: `el entorno tiene el marcador de agente ${marker}` },
  );
}

/**
 * The person's yes to publishing exactly these sources, once, with exactly the
 * plan they were shown: `plan` is the preview's digest, so a hub block
 * rewritten while the question waited publishes nothing.
 */
export interface ProdConsent {
  readonly sources: readonly string[];
  readonly plan: string;
}

// Only `grantProdConsent` puts a consent here, and using one takes it out: an
// object with the same shape built anywhere else, or a consent already spent,
// publishes nothing.
const granted = new WeakSet<ProdConsent>();

export function grantProdConsent(
  who: Attribution,
  sources: readonly string[],
  plan: string,
): ProdConsent | null {
  if (!who.person || !attributed.has(who)) return null;
  const consent: ProdConsent = Object.freeze({ sources: Object.freeze([...sources]), plan });
  granted.add(consent);
  return consent;
}

/** Whether `consent` was granted for exactly `sources` and `plan`; a matching one is spent. */
export function spendProdConsent(
  consent: ProdConsent | undefined,
  sources: readonly string[],
  plan: string,
): boolean {
  if (consent === undefined || !granted.has(consent)) return false;
  const same =
    consent.plan === plan &&
    consent.sources.length === sources.length &&
    sources.every((alias) => consent.sources.includes(alias));
  if (same) granted.delete(consent);
  return same;
}
