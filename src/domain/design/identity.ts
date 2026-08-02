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

/** `DES-001`, `DES-1042`. Three digits minimum, so the sort order reads well. */
const PACKAGE_ID_RE = /^DES-\d{3,}$/;

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

const ARTIFACT_ID_RE = /^(FLW|SCR|RUL|TOK|VIS|REV|RVK)-\d{3,}$/;

/** `sha256:` + 64 lowercase hex chars. The only digest form the package writes. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

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

const BASELINE_REF_RE = /^(DES-\d{3,})@r(\d+)$/;
const ARTIFACT_REF_RE =
  /^(DES-\d{3,})\/((?:FLW|SCR|RUL|TOK|VIS|REV|RVK)-\d{3,})@r(\d+)(?:#([A-Za-z0-9][A-Za-z0-9_-]*))?$/;

export function parseBaselineRef(raw: unknown): BaselineRef | null {
  if (typeof raw !== "string") return null;
  const m = BASELINE_REF_RE.exec(raw.trim());
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

const ARTIFACT_ID_QUALIFIED_RE = /^(DES-\d{3,})\/((?:FLW|SCR|RUL|TOK|VIS|REV|RVK)-\d{3,})$/;

export function parseArtifactId(raw: unknown): ArtifactId | null {
  if (typeof raw !== "string") return null;
  const m = ARTIFACT_ID_QUALIFIED_RE.exec(raw.trim());
  if (m === null) return null;
  return { package: m[1] as string, artifact: m[2] as string };
}

/**
 * The same grammar with the `g` flag, for scanning prose. Cross-validation only
 * ever recognizes this exact form — never an informally written mention.
 */
export const ARTIFACT_REF_GLOBAL =
  /DES-\d{3,}\/(?:FLW|SCR|RUL|TOK|VIS|REV|RVK)-\d{3,}@r\d+(?:#[A-Za-z0-9][A-Za-z0-9_-]*)?/g;

/**
 * An acceptance criterion as Workline writes it: `S013/AC-SEM-11`, `S046/AC-01`.
 * Cross-validation harvests these from the body the same way it harvests
 * references — closed grammar only, never a sentence.
 */
export const CRITERION_GLOBAL = /S\d{3}\/AC-(?:[A-Z]+-)?\d+/g;

export function parseArtifactRef(raw: unknown): ArtifactRef | null {
  if (typeof raw !== "string") return null;
  const m = ARTIFACT_REF_RE.exec(raw.trim());
  if (m === null) return null;
  const revision = Number(m[3]);
  if (!isRevision(revision)) return null;
  return {
    package: m[1] as string,
    artifact: m[2] as string,
    revision,
    ...(m[4] !== undefined ? { state: m[4] } : {}),
  };
}

/** Revisions are logical and start at 1: `@r0` is not a thing. */
export function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
