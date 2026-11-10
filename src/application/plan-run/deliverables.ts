/**
 * Where a flow may write in the hub (spec 066, ID06): its own spec or plan and
 * the four deliverable folders, each with the shape its category has always had.
 * Without sessions there is nothing to export from, so deliverables are born in
 * `docs/` and travel in the hub's commit.
 */
const DELIVERABLE_SHAPES: readonly { folder: string; pattern: RegExp; shape: string }[] = [
  {
    folder: "docs/specs",
    pattern: /^docs\/specs\/\d{3,}-spec-[a-z0-9-]+\.md$/,
    shape: "NNN-spec-<slug>.md",
  },
  {
    folder: "docs/plans",
    pattern: /^docs\/plans\/\d{3,}-plan-[a-z0-9-]+\.md$/,
    shape: "PPP-plan-<slug>.md",
  },
  {
    folder: "docs/scripts",
    pattern: /^docs\/scripts\/[^/]+\.sql$/,
    shape: "un .sql suelto en la raíz de docs/scripts/",
  },
  {
    folder: "docs/manuals",
    pattern: /^docs\/manuals\/(?:[^/]+\/)?[^/]+\.md$/,
    shape: "Markdown, plano o en un expediente numerado",
  },
  { folder: "docs/reports", pattern: /^docs\/reports\/(?:[^/]+\/)?[^/]+\.md$/, shape: "Markdown" },
  {
    folder: "docs/diagrams",
    pattern: /^docs\/diagrams\/(?:[^/]+\/)?[^/]+\.(?:md|mmd|svg|html|png)$/,
    shape: "md, mmd, svg, html o png",
  },
];

export interface DeliverableViolation {
  path: string;
  reason: string;
}

/** Every hub path a commit carries must be a flow document or a well-shaped deliverable. */
export function deliverableViolations(paths: readonly string[]): DeliverableViolation[] {
  const out: DeliverableViolation[] = [];
  for (const path of paths) {
    const category = DELIVERABLE_SHAPES.find((entry) => path.startsWith(`${entry.folder}/`));
    if (category === undefined) {
      out.push({
        path,
        reason: `fuera de ${DELIVERABLE_SHAPES.map((entry) => entry.folder).join(", ")}`,
      });
    } else if (!category.pattern.test(path)) {
      out.push({ path, reason: `${category.folder} espera ${category.shape}` });
    }
  }
  return out;
}
