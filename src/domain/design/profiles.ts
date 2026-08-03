import type { AdapterProfile, AdapterRegistry } from "./adapter.js";
import type { RenditionProvider } from "./rendition.js";
import type { DesignFailure } from "./validation.js";

/**
 * The v1 conformance profiles, and what each provider's locator has to say.
 *
 * Conformance v1 is deliberately small: two USABLE profiles, neither of which
 * needs an account, an API key or a request. `portable-html` produces something a
 * person can open; `figma` prepares the context and records where the result
 * ended up. Everything else in this file is the same shape applied to the other
 * destinations the spec names — Stitch, Claude Design, Claude.ai Artifacts — which
 * receive the SAME bundle and register their own locators.
 *
 * Two rules make this a contract instead of a list.
 *
 * **A locator locates.** `file_key`, `project_id`, `artifact` — each provider has
 * its own minimum, and a rendition claiming that provider has to carry it. What a
 * locator never does is identify: the Workline id, revision and digest are the
 * identity, and a locator that went missing costs a link, never the evidence.
 *
 * **A provider with no stable version says so here.** Whether the tool can name
 * the exact version a snapshot came from is a property OF THE TOOL, not something
 * a rendition can be blamed for. So it is declared per provider: where there is a
 * stable version identity, `provider.version` is required; where there is none,
 * `null` is the honest answer and `source_digest` plus the local snapshot are what
 * keep the evidence verifiable.
 */

/** The shared loss of every v1 profile: nothing here automates the tool. */
const MANUAL_OPERATION = {
  subject: "operation:automation",
  why: "la conformidad v1 prepara el contexto y registra el resultado; operar la herramienta es manual o asistido",
} as const;

/**
 * HTML portable / Claude Artifact — `handoff + record + snapshot`.
 *
 * The one profile that keeps a consultable copy, which is why it is the one that
 * survives a dead account and a cut network. Its `network: never` is not a
 * courtesy: an export under this profile that reaches for a URL is rejected by
 * `checkOfflineHtml`.
 */
export const PORTABLE_HTML: AdapterProfile = {
  id: "portable-html",
  title: "HTML portable / Claude Artifact",
  version: 1,
  capabilities: {
    handoff: true,
    record: true,
    snapshot: true,
    generate: false,
    push: false,
    pull: false,
    compare: false,
  },
  losses: [
    MANUAL_OPERATION,
    {
      subject: "medium:motion",
      why: "un export estático no representa animación ni temporización; una transición se evidencia con un storyboard",
    },
    {
      subject: "section:design_system_deltas",
      why: "el HTML muestra el resultado, no el delta respecto del design system: eso vive en la screen",
    },
  ],
  network: "never",
};

/**
 * The four capabilities no v1 profile implements — declared false, not omitted.
 *
 * `handoff + record` is what conformance means for a provider-backed profile: the
 * bundle is prepared and the result is registered, and the tool is operated by a
 * person. Saying so here once is what keeps the four from drifting into "probably
 * works" in one profile and "not supported" in the next.
 */
const NOT_IN_V1 = { generate: false, push: false, pull: false, compare: false } as const;

/** What every provider-backed profile is known to drop. */
const providerLosses = (name: string): AdapterProfile["losses"] => [
  MANUAL_OPERATION,
  {
    subject: "authority:semantics",
    why: `lo que se edite en ${name} no es la fuente: la Screen Specification sigue siendo la autoridad y una vuelta externa entra como propuesta`,
  },
];

/**
 * Figma — `handoff + record`, the second half of v1 conformance.
 *
 * No API, no token, no request: it prepares the context and registers `file_key`,
 * `node_id` and the version the result ended up at. That is deliberately the whole
 * profile — automating `generate` or `pull` is explicitly out of scope, and
 * declaring them false is how a caller finds that out without trying.
 */
export const FIGMA: AdapterProfile = {
  id: "figma",
  title: "Figma",
  version: 1,
  capabilities: { handoff: true, record: true, snapshot: false, ...NOT_IN_V1 },
  losses: providerLosses("Figma"),
  network: "opt_in",
};

export const STITCH: AdapterProfile = {
  id: "stitch",
  title: "Stitch",
  version: 1,
  capabilities: { handoff: true, record: true, snapshot: false, ...NOT_IN_V1 },
  losses: providerLosses("Stitch"),
  network: "opt_in",
};

export const CLAUDE_DESIGN: AdapterProfile = {
  id: "claude-design",
  title: "Claude Design",
  version: 1,
  capabilities: { handoff: true, record: true, snapshot: false, ...NOT_IN_V1 },
  losses: [
    ...providerLosses("Claude Design"),
    {
      subject: "provider:version",
      why: "no expone una versión estable a la que anclar un snapshot; lo verificable es el export local y su source_digest",
    },
  ],
  network: "opt_in",
};

/**
 * Claude.ai Artifacts — `handoff + record + snapshot`.
 *
 * The one provider-backed profile that also snapshots, because an artifact IS an
 * HTML export: what it registers is where the artifact lives, and what it keeps is
 * the same self-sufficient file `portable-html` produces.
 */
export const CLAUDE_ARTIFACT: AdapterProfile = {
  id: "claude-artifact",
  title: "Claude.ai Artifacts",
  version: 1,
  capabilities: { handoff: true, record: true, snapshot: true, ...NOT_IN_V1 },
  losses: providerLosses("Claude.ai"),
  network: "opt_in",
};

/** Every registered profile, by id. */
export const DESIGN_ADAPTERS: AdapterRegistry = {
  [PORTABLE_HTML.id]: PORTABLE_HTML,
  [FIGMA.id]: FIGMA,
  [STITCH.id]: STITCH,
  [CLAUDE_DESIGN.id]: CLAUDE_DESIGN,
  [CLAUDE_ARTIFACT.id]: CLAUDE_ARTIFACT,
};

/** What a provider needs in its locator, and whether it can name a version. */
export interface LocatorRequirement {
  /** Keys the locator must carry, all of them. */
  required: readonly string[];
  /** Groups where at least one key of each group is enough. */
  anyOf: ReadonlyArray<readonly string[]>;
  /** False when the tool exposes no stable version identity for a snapshot. */
  stableVersion: boolean;
}

/**
 * Locator minimums per provider name, as the spec states them.
 *
 * Keyed by `provider.name` rather than by profile id because a rendition records
 * the tool it came out of, and the same tool may be reached by more than one
 * profile. A name that is not here is not an error: `provider.name` is free text
 * and a package may register a tool this Workline never heard of — what would be
 * wrong is INVENTING a requirement for it.
 */
export const LOCATOR_REQUIREMENTS: Readonly<Record<string, LocatorRequirement>> = {
  figma: { required: ["file_key", "node_id"], anyOf: [], stableVersion: true },
  stitch: { required: ["project_id", "screen_id"], anyOf: [], stableVersion: true },
  // Claude Design identifies the project or the URL, and the handoff/export it
  // produced; it exposes no version identity a snapshot can be pinned to.
  "claude-design": {
    required: [],
    anyOf: [["project_id", "url"], ["export"]],
    stableVersion: false,
  },
  "claude-artifact": {
    required: [],
    anyOf: [["artifact_id", "url"], ["export"]],
    stableVersion: true,
  },
};

/**
 * Does this rendition's provider locate what it claims to?
 *
 * Returns `[]` for a purely local rendition: `provider: null` is the normal shape
 * of the evidence that does not depend on anybody, and demanding a locator for it
 * would invert the whole point of the local path.
 */
export function checkProviderLocator(
  provider: RenditionProvider | null,
  artifact: string,
): DesignFailure[] {
  if (provider === null) return [];
  const rule = LOCATOR_REQUIREMENTS[provider.name];
  if (rule === undefined) return [];

  const failures: DesignFailure[] = [];
  const has = (key: string): boolean => (provider.locator[key] ?? "").length > 0;

  for (const key of rule.required) {
    if (has(key)) continue;
    failures.push({
      code: "DESIGN_LOCATOR_INCOMPLETE",
      artifact,
      message: `el locator de '${provider.name}' no trae '${key}'`,
      action: `un locator de ${provider.name} necesita ${rule.required.join(" y ")}: completalo, o registrá la rendition como local (provider: null)`,
    });
  }
  for (const group of rule.anyOf) {
    if (group.some(has)) continue;
    failures.push({
      code: "DESIGN_LOCATOR_INCOMPLETE",
      artifact,
      message: `el locator de '${provider.name}' no trae ninguno de ${group.join(", ")}`,
      action: `declará al menos uno de ${group.join(" o ")}: un locator que no localiza nada es peor que ninguno`,
    });
  }
  if (rule.stableVersion && provider.version === null) {
    failures.push({
      code: "DESIGN_LOCATOR_INCOMPLETE",
      artifact,
      message: `'${provider.name}' expone una versión estable y esta rendition no la registra`,
      action:
        "copiá la versión del objeto externo (version_id, timestamp o equivalente): sin ella nadie puede decir de qué estado salió el snapshot",
    });
  }
  return failures;
}
