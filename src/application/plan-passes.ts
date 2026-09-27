import { isPlanHandoffHeading } from "../domain/plan-handoff.js";
import type { WorklineNodeId } from "../domain/workline-node.js";
import { scanMarkdown } from "./markdown.js";
import { type DerivedPass, productionStandingOf } from "./release-pass-ledger.js";

export interface DeclaredPlanPass {
  environment: "cert" | "prod";
  version: string;
  state: "done" | "pending" | "unregistered";
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

/** A declaration belongs to this plan only when the named pass carries it. */
export function standingOfPlanPasses(
  declarations: readonly Pick<DeclaredPlanPass, "environment" | "version">[],
  passes: readonly DerivedPass[],
  plan: WorklineNodeId,
): DeclaredPlanPass[] {
  return declarations.map((declaration) => {
    const linked = passes.find(
      (pass) =>
        pass.pass.version === declaration.version &&
        pass.pass.plans.some((node) => node.kind === "plan" && node.key === plan.key),
    );
    if (linked === undefined) return { ...declaration, state: "unregistered" };
    const done =
      declaration.environment === "prod"
        ? productionStandingOf([linked], plan).axis === "in-production"
        : linked.applications.some(
            (application) => application.environment.toLowerCase() === "cert",
          );
    return { ...declaration, state: done ? "done" : "pending" };
  });
}
