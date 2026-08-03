import type { BundleAdapter, BundleLoss } from "./render-bundle.js";
import type { DesignFailure } from "./validation.js";

/**
 * What a renderer or adapter says it can do — and the refusal to infer the rest.
 *
 * Every integration declares a COMPLETE matrix. That is the whole content of
 * this module: an absent capability is never "probably fine", never "try it and
 * see", never a call that silently does half the job. Asking for one that was
 * not declared comes back as an explicit degradation naming what is missing and
 * what does exist instead — or, when the caller cannot continue without it, as a
 * failure. Never as silence.
 *
 * The matrix is a TYPE, not a document: `Record<RenderCapability, boolean>` is
 * exhaustive, so a profile that forgets to answer for `compare` does not
 * compile. There is no JSON schema here on purpose — a profile is code shipped
 * with the CLI, and validating it at runtime would be checking a fact the
 * compiler already proved.
 *
 * A one-way adapter is perfectly valid. `handoff + record` — prepare the context,
 * register where the result ended up — is the whole Figma conformance profile of
 * v1, and it is honest precisely because it declares the other five as absent.
 */

/**
 * The seven capabilities, in decreasing order of how local they are.
 *
 * - `handoff` — hand the bundle over. The floor: no account, no network.
 * - `record` — register where a result lives, as a rendition.
 * - `snapshot` — keep a local, consultable copy of the result.
 * - `generate` — create the visual result in the tool, automatically.
 * - `push` — write Workline's semantics into the tool.
 * - `pull` — bring the tool's state back.
 * - `compare` — diff the tool's state against a revision.
 */
export const RENDER_CAPABILITIES = [
  "handoff",
  "record",
  "snapshot",
  "generate",
  "push",
  "pull",
  "compare",
] as const;

export type RenderCapability = (typeof RENDER_CAPABILITIES)[number];

/**
 * The three v1 conformance is defined in terms of. Optional means "may be
 * declared false", never "may be left out of the matrix": the difference between
 * those two is exactly what this contract exists to remove.
 */
export const CONFORMANCE_CAPABILITIES = ["handoff", "record", "snapshot"] as const;

/** The four that no v1 profile implements, and that all of them must declare. */
export const OPTIONAL_CAPABILITIES = ["generate", "push", "pull", "compare"] as const;

/** Whether a profile can reach a third party at all, and under what discipline. */
export type NetworkPosture = "never" | "opt_in";

export interface AdapterProfile {
  /** Slug identity, and the value a bundle's `adapter.profile` carries. */
  id: string;
  title: string;
  /** Determinism is promised PER version: bump it when the profile's needs change. */
  version: number;
  /** Complete by construction — the type admits no missing capability. */
  capabilities: Readonly<Record<RenderCapability, boolean>>;
  /** What this profile is known to drop, in its own words. */
  losses: readonly BundleLoss[];
  network: NetworkPosture;
}

/** Adapters by id. A registry with nothing in it is a legitimate state. */
export type AdapterRegistry = Readonly<Record<string, AdapterProfile>>;

/**
 * The nearest declared capability that answers the SAME need, so a degradation
 * can offer a way forward instead of just a refusal. `handoff` has none below
 * it: it is the floor, and a profile that cannot even hand the bundle over has
 * nothing to fall back to.
 */
const FALLBACK: Readonly<Record<RenderCapability, RenderCapability | null>> = {
  handoff: null,
  record: "handoff",
  snapshot: "record",
  generate: "handoff",
  push: "handoff",
  pull: "record",
  compare: "snapshot",
};

const HOW_TO_INSTEAD: Readonly<Record<RenderCapability, string>> = {
  handoff: "entregá el bundle y operá la herramienta a mano",
  record: "registrá el resultado como rendition con su locator",
  snapshot: "conservá una copia local del resultado y sellala con su source_digest",
  generate: "creá el diseño en la herramienta a partir del bundle",
  push: "aplicá los cambios en la herramienta a mano",
  pull: "traé el resultado a mano y registralo como propuesta",
  compare: "compará contra el snapshot local",
};

/** Why a capability cannot be exercised, and what can be done instead. */
export interface CapabilityDegradation {
  adapter: string;
  capability: RenderCapability;
  message: string;
  /** A capability this adapter DOES declare, or null when there is none. */
  alternative: RenderCapability | null;
  action: string;
}

export type CapabilityResolution =
  | { ok: true; capability: RenderCapability }
  | { ok: false; degradation: CapabilityDegradation };

/**
 * Resolve a request against the matrix.
 *
 * The two outcomes are the contract: a declared capability is exercised, an
 * undeclared one degrades. There is no third branch where the caller guesses,
 * and no branch at all where the answer is nothing.
 */
export function resolveCapability(
  adapter: AdapterProfile,
  capability: RenderCapability,
): CapabilityResolution {
  if (adapter.capabilities[capability]) return { ok: true, capability };

  const fallback = FALLBACK[capability];
  const alternative =
    fallback !== null && adapter.capabilities[fallback]
      ? fallback
      : (RENDER_CAPABILITIES.find((c) => adapter.capabilities[c]) ?? null);

  return {
    ok: false,
    degradation: {
      adapter: adapter.id,
      capability,
      message: `el perfil '${adapter.id}' no declara '${capability}'`,
      alternative,
      action:
        alternative === null
          ? "este perfil no declara ninguna capacidad: elegí otro adapter, o hacé el handoff neutral local"
          : `usá '${alternative}': ${HOW_TO_INSTEAD[alternative]}`,
    },
  };
}

/** The same degradation as a failure, for a caller that cannot continue without it. */
export function degradationFailure(
  degradation: CapabilityDegradation,
  artifact: string,
): DesignFailure {
  return {
    code: "DESIGN_CAPABILITY_UNDECLARED",
    artifact,
    message: degradation.message,
    action: degradation.action,
  };
}

/** Look an adapter up. Null — never a guess — when the registry does not have it. */
export function findAdapter(id: string, registry: AdapterRegistry): AdapterProfile | null {
  return registry[id] ?? null;
}

/**
 * Ask for an adapter that has to be there. Separate from `findAdapter` so the
 * diagnostic can list what IS registered: "no existe 'figma-api'" is a dead end
 * when the answer the caller needed was "hay 'figma' y 'portable-html'".
 */
export function requireAdapter(
  id: string,
  registry: AdapterRegistry,
  artifact: string,
): { ok: true; value: AdapterProfile } | { ok: false; failure: DesignFailure } {
  const found = findAdapter(id, registry);
  if (found !== null) return { ok: true, value: found };
  const known = Object.keys(registry).sort();
  return {
    ok: false,
    failure: {
      code: "DESIGN_ADAPTER_UNKNOWN",
      artifact,
      message: `no hay ningún perfil de renderer/adapter '${id}'`,
      action:
        known.length === 0
          ? "no hay perfiles registrados: el camino local (validar, leer y handoff neutral) no necesita ninguno"
          : `los perfiles registrados son: ${known.join(", ")}`,
    },
  };
}

/** The adapter facet a bundle records. */
export function bundleAdapterOf(adapter: AdapterProfile): BundleAdapter {
  return { profile: adapter.id, version: adapter.version };
}

/**
 * Everything this profile cannot represent, as a bundle's loss report.
 *
 * Its own declared losses PLUS one entry per undeclared capability. The second
 * half is what makes the report answer "what can this not do with my design"
 * rather than only "what does this renderer draw badly".
 */
export function declaredLosses(adapter: AdapterProfile): BundleLoss[] {
  return [
    ...adapter.losses,
    ...RENDER_CAPABILITIES.filter((c) => !adapter.capabilities[c]).map((c) => ({
      subject: `capability:${c}`,
      why: `el perfil '${adapter.id}' no declara '${c}'${
        FALLBACK[c] !== null && adapter.capabilities[FALLBACK[c] as RenderCapability]
          ? `; lo más cercano que declara es '${FALLBACK[c] as string}'`
          : ""
      }`,
    })),
  ];
}

/** Does this profile satisfy v1 conformance for the capabilities it claims? */
export function conformanceOf(adapter: AdapterProfile): RenderCapability[] {
  return CONFORMANCE_CAPABILITIES.filter((c) => adapter.capabilities[c]);
}
