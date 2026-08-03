import type { CapabilityDescriptor } from "../capability/descriptor.js";
import { CAPABILITY_CONTRACT_VERSION } from "../capability/descriptor.js";
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

/**
 * `design` as a capability descriptor — the v1 conformant instance.
 *
 * This is the same capability the table above describes, restated in the ONE
 * form every consumer reads: the wrapper installed into a host, the dispatcher,
 * discovery, the generated help and any flow that composes an operation all
 * derive from this object rather than re-describing it. Two descriptions of one
 * contract is the failure mode the whole layer exists to prevent.
 *
 * The typing is load-bearing twice over. `CapabilityDescriptor` keeps the shape
 * honest, and `name: SkillRole` proves at COMPILE TIME that the capability's
 * public identity and the `skills.toml` binding slot are the same string. The
 * day someone names a capability differently from its role, the parallel public
 * identity `S014/AC-ID-01` forbids reappears — and this annotation is the only
 * barrier against it.
 *
 * The `schema` fields point at formats already published under
 * `skills/w/schemas/design/`; the descriptor references them and does not become
 * another one. That is why it lives here and the CONTRACT lives in
 * `domain/capability` — a design format never has to know a capability exists.
 */
export const DESIGN_DESCRIPTOR: CapabilityDescriptor & { readonly name: SkillRole } = {
  contract_version: CAPABILITY_CONTRACT_VERSION,
  name: DESIGN_CAPABILITY,
  purpose:
    "producir, actualizar, juzgar, proyectar y sellar un UI Design Package v1 sobre un contrato único",
  exposure: ["direct", "compose"],
  default_operation: null,
  operations: [
    {
      name: "create",
      summary: "primera revisión de un package a partir de fuentes declaradas",
      exposure: ["direct", "compose"],
      // Writes a package under `docs/designs/`: without a workspace there is no
      // place for it to land, and inventing one is exactly what AC-REQ-03 bans.
      workspace: "required",
      interaction: "needs_input",
      inputs: [
        { name: "title", kind: "text", required: true, sensitivity: "public", schema: null },
        { name: "sources", kind: "reference", required: true, sensitivity: "public", schema: null },
        { name: "target", kind: "text", required: true, sensitivity: "public", schema: null },
        {
          name: "profile",
          kind: "selection",
          required: false,
          sensitivity: "public",
          schema: null,
        },
        { name: "context", kind: "text", required: false, sensitivity: "public", schema: null },
      ],
      output: {
        kind: "value_and_reference",
        schema: CANONICAL_SCHEMAS.baseline,
        completeness: ["complete", "partial"],
      },
      effects: [
        { class: "read_only", idempotent: true, authorization: "invocation", approval: "none" },
        {
          class: "local_additive",
          idempotent: false,
          authorization: "invocation",
          approval: "none",
        },
      ],
      off: "blocked",
    },
    {
      name: "update",
      summary: "revisión siguiente de un package existente, con base de compare-and-swap",
      exposure: ["direct", "compose"],
      workspace: "required",
      interaction: "needs_input",
      inputs: [
        { name: "package", kind: "reference", required: true, sensitivity: "public", schema: null },
        { name: "base", kind: "reference", required: true, sensitivity: "public", schema: null },
        {
          name: "sources",
          kind: "reference",
          required: false,
          sensitivity: "public",
          schema: null,
        },
        { name: "context", kind: "text", required: false, sensitivity: "public", schema: null },
      ],
      output: {
        kind: "value_and_reference",
        schema: CANONICAL_SCHEMAS.baseline,
        completeness: ["complete", "partial"],
      },
      effects: [
        { class: "read_only", idempotent: true, authorization: "invocation", approval: "none" },
        {
          class: "local_additive",
          idempotent: false,
          authorization: "invocation",
          approval: "none",
        },
        // Publishing a revision moves the manifest's current baseline: an
        // existing file says something else afterwards, so a human sees it first.
        {
          class: "mutate_overwrite",
          idempotent: false,
          authorization: "preflight",
          approval: "visible",
        },
      ],
      off: "blocked",
    },
    {
      name: "validate",
      summary: "juzgar un package sin escribir: schemas, naming, referencias y madurez",
      exposure: ["direct", "compose"],
      // The one operation a flow can reach with `design` off, so it must not
      // depend on workspace state it might not have.
      workspace: "optional",
      interaction: "single_pass",
      inputs: [
        { name: "package", kind: "reference", required: true, sensitivity: "public", schema: null },
        {
          name: "profile",
          kind: "selection",
          required: false,
          sensitivity: "public",
          schema: null,
        },
      ],
      output: { kind: "value", schema: null, completeness: ["complete"] },
      effects: [
        { class: "read_only", idempotent: true, authorization: "invocation", approval: "none" },
      ],
      // Survives `off` on purpose: a package that already exists stays
      // consultable and consumable, or turning the capability off would
      // retroactively invalidate work nobody asked to discard.
      off: "allowed",
    },
    {
      name: "render",
      summary: "regenerar las proyecciones de una revisión y preparar el handoff a un proveedor",
      exposure: ["direct", "compose"],
      workspace: "required",
      interaction: "single_pass",
      inputs: [
        { name: "package", kind: "reference", required: true, sensitivity: "public", schema: null },
        { name: "profile", kind: "selection", required: true, sensitivity: "public", schema: null },
      ],
      output: {
        kind: "reference",
        schema: CANONICAL_SCHEMAS.renderBundle,
        completeness: ["complete", "partial"],
      },
      effects: [
        { class: "read_only", idempotent: true, authorization: "invocation", approval: "none" },
        {
          class: "local_additive",
          idempotent: true,
          authorization: "invocation",
          approval: "none",
        },
        // A provider profile can leave the machine. Declared here rather than
        // decided at call time: the preflight is what makes the destination and
        // the payload visible before anything is sent.
        {
          class: "network_external",
          idempotent: false,
          authorization: "preflight",
          approval: "visible",
        },
      ],
      off: "blocked",
    },
    {
      name: "record",
      summary: "sellar una decisión de gobierno sobre una revisión existente",
      exposure: ["direct", "compose"],
      workspace: "required",
      interaction: "single_pass",
      inputs: [
        { name: "package", kind: "reference", required: true, sensitivity: "public", schema: null },
        {
          name: "revision",
          kind: "reference",
          required: true,
          sensitivity: "public",
          schema: null,
        },
        { name: "decision", kind: "text", required: true, sensitivity: "public", schema: null },
      ],
      output: {
        kind: "reference",
        schema: CANONICAL_SCHEMAS.review,
        completeness: ["complete"],
      },
      effects: [
        { class: "read_only", idempotent: true, authorization: "invocation", approval: "none" },
        {
          class: "local_additive",
          idempotent: false,
          authorization: "invocation",
          approval: "none",
        },
        // A revocation changes what a published revision means downstream.
        {
          class: "mutate_overwrite",
          idempotent: false,
          authorization: "preflight",
          approval: "visible",
        },
      ],
      off: "blocked",
    },
  ],
  // Core with a built-in floor: the PLAN and SPEC gates that consume a package
  // must keep working on a machine where nothing extra is installed.
  floor: { builtin: true, kind: "core", improvements: "host_selected" },
  degradations: [
    { cause: "opaque_selection", action: "floor" },
    { cause: "incompatible_improvement", action: "floor" },
    { cause: "invalid_binding", action: "floor" },
    { cause: "digest_changed", action: "floor" },
  ],
  compatibility: {
    status: "active",
    minimum_contract_version: CAPABILITY_CONTRACT_VERSION,
    // This descriptor IS the capability, not an improvement to one.
    improves: null,
    // Not aliases. Listed so every entry surface can refuse them by NAME with a
    // corrective action instead of failing with "unknown skill".
    retired_names: ["ui-design", "ui-spec"],
    retired_formats: [
      "spec-section:## UI spec",
      "session-design-spec:NNN-SPEC-<SLUG>.md",
      "ui-spec-generator:output",
    ],
  },
};
