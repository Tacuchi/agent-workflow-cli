/**
 * Renderer for SESSION.md — the brief descriptor of an internal session
 * (Layer 3), created by a loop (not the user). Shape mirrors
 * `skills/w/artifacts/artifacts-core/SESSION.md`:
 *
 *   # SESSION — <name>
 *   ## Objective    (from --objetivo)
 *   ## Origin       (list derived from a plain origin string; placeholder when absent)
 *   ## Type         (the --type value, set by the parent loop)
 *   ## Success criteria (blank `[ ]` checklist) — research sessions only
 *
 * Components and (for non-research types) Success criteria are intentionally
 * omitted: empty boilerplate sections made dogfooded sessions look "empty".
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
  // Research sessions are the only type that opens with explicit success
  // criteria; other types (refine | exec | quick) omit the section so the
  // descriptor stays free of empty boilerplate.
  const successCriteria =
    values.type === "research"
      ? `

## Success criteria
<!-- Checklist that, when met, closes the session and triggers the report back to the loop. -->
- [ ]`
      : "";
  return `# SESSION — ${values.name}

## Objective
${values.objetivo}

## Origin
${renderOriginSection(values.origin)}

## Type
${values.type}${successCriteria}
`;
}
