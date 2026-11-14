import { isPlanHandoffHeading } from "../domain/plan-handoff.js";
import type { WorklineNodeId } from "../domain/workline-node.js";
import { scanMarkdown } from "./markdown.js";
import { type DerivedPass, productionStandingOf } from "./release-pass-ledger.js";

export interface DeclaredPlanPass {
  environment: "cert" | "prod";
  version: string;
  state: "done" | "pending" | "unregistered";
  /** The book's name of the linked pass, only when it differs from the plan's prose. */
  pass?: string;
}

/** Only real list items in a handoff section declare passes; examples in fences do not. */
export function planPassDeclarations(
  text: string,
): Array<Pick<DeclaredPlanPass, "environment" | "version">> {
  const markdown = scanMarkdown(text);
  const headings = new Map(markdown.headings.map((heading) => [heading.line, heading]));
  const declarations: Array<Pick<DeclaredPlanPass, "environment" | "version">> = [];
  let inHandoff = false;
  for (const [index, line] of markdown.lines.entries()) {
    if (markdown.fenced[index]) continue;
    const heading = headings.get(index);
    if (heading?.level === 2) inHandoff = isPlanHandoffHeading(heading.title);
    if (!inHandoff) continue;
    const match = /^\s*[-*+]\s+Pase a (cert|prod):\s*(\S(?:.*\S)?)\s*$/i.exec(line);
    if (match?.[1] && match[2]) {
      declarations.push({
        environment: match[1].toLowerCase() as "cert" | "prod",
        version: match[2],
      });
    }
  }
  return declarations;
}

/** A semver-shaped word, the name passes are usually declared under (`30.0.0`, `v1.2.0-rc.1`). */
const VERSION_WORD = /(?<![\w./-])v?\d+\.\d+\.\d+(?:-\w+(?:\.\w+)*)?(?![\w/-]|\.\w)/;

/** The name to suggest for an unregistered pass: its version when the text has one, else the whole text. */
export function suggestedPassName(declaration: string): string {
  return VERSION_WORD.exec(declaration)?.[0] ?? declaration;
}

/**
 * A plan's «Pase a» line is free prose; the pass is named in the book, usually by
 * its version. The line names a pass when it is that name or carries it as a whole word.
 */
function declarationNamesPass(declaration: string, name: string): boolean {
  if (declaration === name) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`).test(declaration);
}

/**
 * Prose written before the version existed («publicar la versión menor…») names
 * no pass: it has no version word and is more than one word. A single word
 * (`corte-1`) is a pass name and keeps requiring that name.
 */
function namesNoPass(declaration: string): boolean {
  return !VERSION_WORD.test(declaration) && /\s/.test(declaration);
}

function linksPlan(pass: DerivedPass, plan: WorklineNodeId): boolean {
  return pass.pass.plans.some((node) => node.kind === "plan" && node.key === plan.key);
}

/** A declaration belongs to this plan only when the named pass carries it. */
export function standingOfPlanPasses(
  declarations: readonly Pick<DeclaredPlanPass, "environment" | "version">[],
  passes: readonly DerivedPass[],
  plan: WorklineNodeId,
): DeclaredPlanPass[] {
  return declarations.map((declaration) => {
    const named = passes.filter(
      (pass) =>
        declarationNamesPass(declaration.version, pass.pass.version) && linksPlan(pass, plan),
    );
    // The whole prose, then the version it suggests, then any other name it carries;
    // prose that names no pass at all goes by the book's latest pass linking the plan.
    const linked =
      named.find((pass) => pass.pass.version === declaration.version) ??
      named.find((pass) => pass.pass.version === suggestedPassName(declaration.version)) ??
      named[0] ??
      (namesNoPass(declaration.version)
        ? passes.filter((pass) => linksPlan(pass, plan)).at(-1)
        : undefined);
    if (linked === undefined) return { ...declaration, state: "unregistered" };
    const done =
      declaration.environment === "prod"
        ? productionStandingOf([linked], plan).axis === "in-production"
        : linked.applications.some(
            (application) => application.environment.toLowerCase() === "cert",
          );
    const state = done ? "done" : "pending";
    return linked.pass.version === declaration.version
      ? { ...declaration, state }
      : { ...declaration, state, pass: linked.pass.version };
  });
}
