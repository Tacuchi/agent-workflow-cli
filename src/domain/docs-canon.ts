/**
 * The fixed core of the documentary layout.
 *
 * The workspace may configure non-core export folders, but research, specs and
 * plans form a graph consumed by lifecycle operations. Keep their default in a
 * dependency-free domain module so every reader can name the same locations
 * without importing an application service or recreating a literal.
 */
export const DEFAULT_CORE_DOCS_CANON = {
  research: "docs/research",
  spec: "docs/specs",
  plan: "docs/plans",
} as const;

export type CoreDocsCategory = keyof typeof DEFAULT_CORE_DOCS_CANON;

export type CoreDocsCanon = Readonly<Record<CoreDocsCategory, string>>;

export type CoreDocumentKind = "spec" | "plan";

export function coreDocumentDirectory(
  canon: Pick<CoreDocsCanon, CoreDocumentKind>,
  kind: CoreDocumentKind,
): string {
  return canon[kind];
}

/** A safe, already-relative core document path belongs to spec or plan. */
export function coreDocumentKindForPath(
  path: string,
  canon: Pick<CoreDocsCanon, CoreDocumentKind> = DEFAULT_CORE_DOCS_CANON,
): CoreDocumentKind | null {
  const normalized = path.split("\\").join("/");
  if (!normalized.endsWith(".md")) return null;
  if (normalized.startsWith(`${canon.spec}/`)) return "spec";
  if (normalized.startsWith(`${canon.plan}/`)) return "plan";
  return null;
}

export function coreDocumentLocations(
  canon: Pick<CoreDocsCanon, CoreDocumentKind> = DEFAULT_CORE_DOCS_CANON,
): string {
  return `${canon.spec} o ${canon.plan}`;
}
