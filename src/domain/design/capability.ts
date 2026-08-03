import type { SkillRole } from "../skills.js";

/**
 * What the `design` capability IS, said once.
 *
 * The public identity is `design` and nothing else. `ui-design` — the role this
 * replaces — and `ui-spec` — the skill that used to fill it — are not aliases,
 * not alternative implementations and not accepted names (S013/AC-CAP-01). A
 * second name for one capability is a second contract wearing a disguise: the
 * day they disagree, there is no way to say which one the package obeys.
 *
 * Typed as `SkillRole` on purpose: if `design` ever left the role catalog this
 * stops compiling, so the identity cannot rot into a string that means nothing.
 */
export const DESIGN_CAPABILITY: SkillRole = "design";

/**
 * The five semantic operations, all over the SAME package (S013/AC-CAP-02).
 *
 * - `create` — the first revision of a package.
 * - `update` — the next revision of one that exists.
 * - `validate` — judge without writing: schemas, naming, references, maturity.
 * - `render` — regenerate the projections; never normative, never sealed.
 * - `record` — seal a governance decision about a revision that exists.
 *
 * `create` and `update` are one route with a different compare-and-swap base,
 * not two formats. `render` and `record` write files a baseline never selects.
 * None of them may invent a layout or a schema of its own — that is the whole
 * content of «no parallel format».
 */
export const DESIGN_OPERATIONS = ["create", "update", "validate", "render", "record"] as const;

export type DesignOperation = (typeof DESIGN_OPERATIONS)[number];

/**
 * Every format this capability produces, and the only ones it accepts.
 *
 * The validators read their id from here rather than repeating a literal, so
 * the registry is load-bearing instead of documentation: a new format cannot
 * appear in code without appearing here, and `design-schema-guard` proves this
 * table and the published JSON Schemas under `skills/w/schemas/design/` name
 * the same things.
 *
 * This is the canonical authority (S013/AC-CAP-03). The built-in floor and any
 * third-party improvement bound to the role write these and are validated by
 * the same code; a contributor extends the domain by adding fields to a schema,
 * never by declaring a format of their own.
 */
export const CANONICAL_SCHEMAS = {
  manifest: "workline.design-manifest/v1",
  baseline: "workline.design-baseline/v1",
  flow: "workline.ui-flow/v1",
  screen: "workline.ui-screen/v1",
  review: "workline.design-review/v1",
  revocation: "workline.design-revocation/v1",
  rendition: "workline.design-rendition/v1",
  renderBundle: "workline.design-render-bundle/v1",
} as const;

export type CanonicalFormat = keyof typeof CANONICAL_SCHEMAS;
