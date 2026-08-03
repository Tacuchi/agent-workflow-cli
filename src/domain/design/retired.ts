import type { DesignFailure } from "./validation.js";

/**
 * The retired design path, reported instead of read (AC-COMP-01/02).
 *
 * A document that still carries the legacy render is not an input this contract
 * accepts and not evidence any gate honors. It is REPORTED — never parsed as a
 * contract, never imported, converted, migrated on touch or bulk-migrated. The
 * asymmetry is deliberate: reading it would make the old format a second source
 * of truth, and the day the two disagree nothing could say which one governs.
 *
 * Retirement is not destruction. Nothing here writes, moves or rewrites a file:
 * a `## UI spec` section written last year stays exactly where it is, byte for
 * byte. What changes is that Workline answers `retired/unsupported` and asks for
 * the result to be recreated over the UI Design Package.
 */

export const RETIRED_CODE = "DESIGN_RETIRED_UNSUPPORTED";

const RECREATE =
  "recreá ese diseño sobre el UI Design Package: no hay importador, conversión ni migración";

interface RetiredForm {
  /** What the legacy surface looks like in a document. */
  test: RegExp;
  what: string;
}

/**
 * Each form is recognized on purpose rather than by one loose pattern: telling
 * an author WHICH retired surface they presented is the difference between a
 * diagnostic and a rejection.
 */
const FORMS: readonly RetiredForm[] = [
  {
    // A heading of its own, so prose that merely mentions the old name is not a
    // false positive — a plan explaining the retirement is not carrying one.
    test: /^\s*#{2,}\s+UI spec\s*$/m,
    what: "una sección '## UI spec'",
  },
  {
    // A real filename, so the literal placeholder `NNN-SPEC-<SLUG>.md` that the
    // doctrine uses to NAME the retired shape is not itself an offender.
    test: /\b\d{3}-SPEC-[A-Z0-9-]+\.md\b/,
    what: "un design SPEC de sesión (NNN-SPEC-<SLUG>.md)",
  },
];

/**
 * Legacy surfaces this text presents. Empty for a document that carries none —
 * which is every current document, so the check costs nothing to keep on.
 */
export function reportRetiredDesign(text: string, artifact: string): DesignFailure[] {
  return FORMS.filter((form) => form.test.test(text)).map((form) => ({
    code: RETIRED_CODE,
    artifact,
    message: `'${artifact}' presenta ${form.what}: es un camino retirado y no se lee como contrato ni cuenta como evidencia`,
    action: RECREATE,
  }));
}

/**
 * A binding or invocation naming a retired identity is refused one layer up, by
 * `RETIRED_SKILL_IDENTITIES` in the skills resolver: the line is ignored with a
 * warning and the role keeps its built-in default, so the capability is never
 * left mute. Nothing is duplicated here — one rule, one home.
 *
 * An **output of `ui-spec-generator`** is retired too, and is stated in the
 * doctrine rather than pattern-matched: that repository is outside this topology
 * and its output format is not ours to recognize. A detector keyed on the tool's
 * NAME would fire on every document that explains the retirement, which is the
 * opposite of a useful guard. What a document can actually carry — a `## UI spec`
 * section or a session design SPEC — is what the forms above catch.
 */
