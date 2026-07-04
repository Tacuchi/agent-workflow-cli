/**
 * Renderer for SESSION.md — the brief descriptor of an internal session
 * (Layer 3), created by a loop (not the user). Shape mirrors
 * `skills/w/artifacts/artifacts-core/SESSION.md`:
 *
 *   # SESSION — <name>
 *   ## Objective         (from --objetivo)
 *   ## Origin            (list derived from a plain origin string; placeholder when absent)
 *   ## Type              (the --type value, set by the parent loop)
 *   ## Success criteria  (blank `[ ]` checklist) — the verification-first done-condition
 *
 * `## Success criteria` is the run's done-condition, seeded at creation
 * (verification-first / generalized TDD): a falsifiable `[ ]` checklist the loop
 * fills BEFORE executing and persists toward — executable tests for code, a
 * by-inspection rubric for analysis/design. Emitted for EVERY type; the parent
 * loop owns the actual criteria.
 * Components stays omitted: empty boilerplate that added no signal.
 */

export interface SessionTemplateValues {
  /** Folder/name of the session (verbatim --name). */
  name: string;
  /** Session type set by the loop: research | refine | exec | quick. */
  type: string;
  /** What this session resolves (from --objetivo). */
  objetivo: string;
  /** Optional plain origin string (from --from): who/where it was created from. */
  origin?: string;
}

function renderOriginSection(origin: string | undefined): string {
  const trimmed = origin?.trim();
  if (!trimmed) {
    return "<!-- Who created it and from where: parent loop, source document, trigger. -->\n- ";
  }
  // Allow a comma-separated origin string to become a small bullet list.
  const items = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderSessionMarkdown(values: SessionTemplateValues): string {
  return `# SESSION — ${values.name}

## Objective
${values.objetivo}

## Origin
${renderOriginSection(values.origin)}

## Type
${values.type}

## Success criteria
<!-- Verification-first done-condition, seeded BEFORE executing: falsifiable [ ] items (tests for code, a by-inspection rubric for analysis/design). The loop persists until all are green and flips each to [x] at the convergence gate; replace this comment when filling. -->
- [ ]
`;
}
