import { join } from "node:path";
import { composeEffectiveContract } from "../../domain/effective-contract.js";
import type { FlowRunState } from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readNoteIndex } from "../decision-note-service.js";
import { scanMarkdown } from "../markdown.js";
import { ACCEPTANCE_CRITERIA_KEY, functionalSections } from "../parsers/spec-functional.js";
import { parseSpecCriteria, parseSpecRelation } from "../parsers/spec-relation.js";
import { type PathsService, resolveWorkspaceRootFrom } from "../paths-service.js";
import { readLineage } from "../plan-exec-decision-service.js";

/** Report only this session's effective deviations, without editing their documents. */
export async function closeDocumentGuidance(
  fs: FileSystemPort,
  paths: PathsService,
  state: FlowRunState,
): Promise<string[]> {
  if (state.flow !== "plan-exec" || state.scope === null) return [];
  try {
    const root = await resolveWorkspaceRootFrom(fs, paths);
    const plan = state.scope.plan;
    if (parseSpecRelation(await fs.readText(join(root, plan))).status === "standalone") return [];
    const lineage = await readLineage(fs, { root, plan });
    if (!lineage.ok)
      return [
        `Revisión documental pendiente: ${lineage.failure.message} — ${lineage.failure.action}`,
      ];
    const { baseline, indexPath, specText } = lineage.value;
    const chain = await readNoteIndex(fs, root, indexPath, baseline);
    if (!chain.ok)
      return chain.failures.map(
        (failure) => `Revisión documental pendiente: ${failure.message} — ${failure.action}`,
      );
    const composed = composeEffectiveContract(baseline, chain.read.index.notes);
    if (composed.status === "blocked")
      return composed.failures.map(
        (failure) => `Revisión documental pendiente: ${failure.message} — ${failure.action}`,
      );
    const own = chain.read.index.notes.filter(
      (note) =>
        note.lineage.execution.session === state.session &&
        composed.contract.applied.includes(note.id),
    );
    return own.flatMap((note) => {
      if (note.scope === "plan-only") {
        return [
          `${note.id}: revisar ${note.lineage.plan.path} — /w:plan-refine ${note.lineage.plan.path}`,
        ];
      }
      return composed.contract.assertions
        .filter((assertion) => assertion.state === "amended" && assertion.by === note.id)
        .map((assertion) => {
          const line = criterionLine(specText, baseline.number, assertion.id);
          return `${note.id}: ${assertion.id} amended · ${baseline.path}${line === null ? " (línea no localizada)" : `:${line}`} — /w:spec-refine ${baseline.path}`;
        });
    });
  } catch (error) {
    return [
      `Revisión documental pendiente: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** Prefer a criterion's definition over an earlier mention; share the criterion grammar. */
function criterionLine(text: string, number: string, id: string): number | null {
  const { lines, fenced, headings } = scanMarkdown(text);
  const sections = functionalSections(headings, lines.length).filter(
    (section) => section.key === ACCEPTANCE_CRITERIA_KEY,
  );
  const definition = lines.findIndex(
    (line, index) =>
      !fenced[index] &&
      sections.some((s) => index >= s.start && index < s.end) &&
      definitionNames(line, number, id),
  );
  if (definition >= 0) return definition + 1;
  const reference = lines.findIndex(
    (line, index) => !fenced[index] && parseSpecCriteria(line).includes(id),
  );
  return reference < 0 ? null : reference + 1;
}

function definitionNames(line: string, number: string, id: string): boolean {
  // Only the item's leading label defines it. References inside its prose do not.
  const label = /^\s*[-*+]\s*\[[ xX]\]\s*(\S+)/.exec(line)?.[1];
  return (
    label !== undefined &&
    parseSpecCriteria(`## Acceptance criteria\n- [ ] ${label}`, number).includes(id)
  );
}
