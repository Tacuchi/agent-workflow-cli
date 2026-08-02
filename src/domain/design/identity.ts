/**
 * Identity of a UI Design Package and of the artifacts inside it.
 *
 * The rule the whole contract rests on: an identifier derives from NOTHING — not
 * a spec, a plan, a session, the folder slug, the path or a provider. It is
 * minted once, stored in the manifest, and survives every rename or move. The
 * `NNN-design-<slug>` folder prefix is a human affordance for browsing; nothing
 * resolves through it.
 *
 * This module owns the reference GRAMMAR (what a well-formed identifier looks
 * like). Resolving a reference against the workspace — repairing a stale path
 * hint, rejecting an approximate match, walking a revision line — belongs to the
 * resolver built on top of it.
 */

/**
 * THE grammar, as pattern fragments.
 *
 * Every regex in this module and every `pattern` in the three published JSON
 * Schemas is built from these strings — and a guard test proves the schemas use
 * them. Without that, tightening a regex here silently leaves the normative
 * contract describing something looser, which is exactly what happened once.
 *
 * `DES-0001` and `DES-001` must never be two spellings of one identity, and
 * `@r04` must never be another spelling of `@r4`: references are compared as
 * STRINGS everywhere downstream, so two spellings break every comparison.
 */
export const GRAMMAR = {
  packageId: "DES-(?:[0-9]{3}|[1-9][0-9]{3,})",
  /** Suffix after a kind prefix, e.g. `FLW` + this. */
  serial: "-(?:[0-9]{3}|[1-9][0-9]{3,})",
  revision: "[1-9][0-9]{0,5}",
  anchor: "[A-Za-z0-9][A-Za-z0-9_-]*",
  digest: "sha256:[0-9a-f]{64}",
} as const;

/** `FLW|SCR` → `(?:FLW|SCR)-(?:[0-9]{3}|[1-9][0-9]{3,})`. */
export function artifactIdPattern(prefixes: string): string {
  return `(?:${prefixes})${GRAMMAR.serial}`;
}

const ALL_PREFIXES = "FLW|SCR|RUL|TOK|VIS|REV|RVK";

const PACKAGE_ID_RE = new RegExp(`^${GRAMMAR.packageId}$`);

export type DesignArtifactKind =
  | "flow"
  | "screen"
  | "rule"
  | "token"
  | "rendition"
  | "review"
  | "revocation";

/** ID prefix per artifact kind. Assets have none: they are content-addressed. */
export const ARTIFACT_PREFIX: Record<DesignArtifactKind, string> = {
  flow: "FLW",
  screen: "SCR",
  rule: "RUL",
  token: "TOK",
  rendition: "VIS",
  review: "REV",
  revocation: "RVK",
};

const ARTIFACT_ID_RE = new RegExp(`^${artifactIdPattern(ALL_PREFIXES)}$`);

/** `sha256:` + 64 lowercase hex chars. The only digest form the package writes. */
const DIGEST_RE = new RegExp(`^${GRAMMAR.digest}$`);

/** `<sha256>-<safe-name>.<ext>` — the content-addressed asset file name. */
const ASSET_FILENAME_RE = /^[0-9a-f]{64}-[A-Za-z0-9._-]+$/;

export function isPackageId(value: unknown): value is string {
  return typeof value === "string" && PACKAGE_ID_RE.test(value);
}

export function isArtifactId(value: unknown, kind?: DesignArtifactKind): value is string {
  if (typeof value !== "string" || !ARTIFACT_ID_RE.test(value)) return false;
  return kind === undefined || value.startsWith(`${ARTIFACT_PREFIX[kind]}-`);
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_RE.test(value);
}

export function isAssetFilename(value: string): boolean {
  return ASSET_FILENAME_RE.test(value);
}

/** A published baseline of a package: `DES-001@r4`. */
export interface BaselineRef {
  package: string;
  revision: number;
}

/** An artifact revision, optionally anchored at one of its states. */
export interface ArtifactRef {
  package: string;
  artifact: string;
  revision: number;
  /** Screen state anchor (`#empty`), absent on flows, rules, tokens, renditions. */
  state?: string;
}

const BASELINE_REF_RE = new RegExp(`^(${GRAMMAR.packageId})@r(${GRAMMAR.revision})$`);
const ARTIFACT_REF_RE = new RegExp(
  `^(${GRAMMAR.packageId})/(${artifactIdPattern(ALL_PREFIXES)})@r(${GRAMMAR.revision})(?:#(${GRAMMAR.anchor}))?$`,
);

export function parseBaselineRef(raw: unknown): BaselineRef | null {
  if (typeof raw !== "string") return null;
  const m = BASELINE_REF_RE.exec(raw);
  if (m === null) return null;
  const revision = Number(m[2]);
  if (!isRevision(revision)) return null;
  return { package: m[1] as string, revision };
}

/** A qualified artifact identity WITHOUT a revision: `DES-001/FLW-001`. */
export interface ArtifactId {
  package: string;
  artifact: string;
}

const ARTIFACT_ID_QUALIFIED_RE = new RegExp(
  `^(${GRAMMAR.packageId})/(${artifactIdPattern(ALL_PREFIXES)})$`,
);

export function parseArtifactId(raw: unknown): ArtifactId | null {
  if (typeof raw !== "string") return null;
  const m = ARTIFACT_ID_QUALIFIED_RE.exec(raw);
  if (m === null) return null;
  return { package: m[1] as string, artifact: m[2] as string };
}

/**
 * The same grammar with the `g` flag, for scanning prose. Cross-validation only
 * ever recognizes this exact form — never an informally written mention.
 */
export const ARTIFACT_REF_GLOBAL = new RegExp(
  `${GRAMMAR.packageId}/${artifactIdPattern(ALL_PREFIXES)}@r${GRAMMAR.revision}(?:#${GRAMMAR.anchor})?`,
  "g",
);

/**
 * An acceptance criterion as Workline writes it: `S013/AC-SEM-11`, `S046/AC-01`.
 * Cross-validation harvests these from the body the same way it harvests
 * references — closed grammar only, never a sentence.
 */
export const CRITERION_GLOBAL = /S\d{3}\/AC-(?:[A-Z]+-)?\d+/g;

export function parseArtifactRef(raw: unknown): ArtifactRef | null {
  if (typeof raw !== "string") return null;
  const m = ARTIFACT_REF_RE.exec(raw);
  if (m === null) return null;
  const revision = Number(m[3]);
  if (!isRevision(revision)) return null;
  const artifact = m[2] as string;
  // Only a screen has states. An anchor on a flow, rule, token or rendition is
  // not a stricter reference — it is a reference to something that cannot exist,
  // and letting it parse means the diagnostic later blames the wrong thing.
  if (m[4] !== undefined && !artifact.startsWith("SCR-")) return null;
  return {
    package: m[1] as string,
    artifact,
    revision,
    ...(m[4] !== undefined ? { state: m[4] } : {}),
  };
}

/**
 * No `trim()` on the parsers above, on purpose: `"DES-001@r1 "` would be a
 * second spelling of one identity, and every comparison downstream is by
 * string. Whoever reads from Markdown trims before parsing.
 */

/** Revisions are logical and start at 1: `@r0` is not a thing. */
export function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * True when a reference would parse if it dropped its state anchor — i.e. the
 * anchor is the only thing wrong with it. Lets a call site keep the precise
 * diagnostic ("this list references whole revisions") without restating the
 * rule that only screens have states.
 */
export function anchorIsTheProblem(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.includes("#")) return false;
  return parseArtifactRef(raw) === null && parseArtifactRef(raw.split("#")[0] as string) !== null;
}
