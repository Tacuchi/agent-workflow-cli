import { resolveBoundary } from "../../src/application/flow/advance.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { type SubmitFlowInput, submitFlow } from "../../src/application/flow/submit.js";
import type { PathsService } from "../../src/application/paths-service.js";
import { journeyForState } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";

/** Cross the explicit route preview in fixtures that exercise a later journey row. */
export async function acceptAdaptiveRoute(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
  input: Pick<SubmitFlowInput, "executor" | "git"> = {},
): Promise<FlowDirective | null> {
  const firstRead = await readRun(fs, locateRun(paths, folder));
  if (!firstRead.ok) throw new Error(firstRead.failure.code);
  const first = resolveBoundary(firstRead.state, journeyForState(firstRead.state));
  if (first.stopped?.id !== "chassis.route-evaluation") return null;
  const proposed = await submitFlow(fs, paths, {
    code: folder,
    raw: JSON.stringify({
      input_digest: first.seal,
      decisions: {
        route: {
          basis: {
            intention: "fixture route",
            checkout: "fixture checkout",
            conventions: "fixture conventions",
            adopted_decisions: "fixture decisions",
          },
          controls: [],
        },
      },
    }),
    approval: null,
    ...input,
  });
  if (!proposed.ok) throw new Error(proposed.failure.code);
  const reviewRead = await readRun(fs, locateRun(paths, folder));
  if (!reviewRead.ok) throw new Error(reviewRead.failure.code);
  const review = resolveBoundary(reviewRead.state, journeyForState(reviewRead.state));
  if (review.stopped?.id !== "chassis.route-evaluation" || review.kind !== "human") {
    throw new Error("la propuesta no abrió la aceptación humana de ruta");
  }
  const accepted = await submitFlow(fs, paths, {
    code: folder,
    raw: JSON.stringify({ input_digest: review.seal, choice: "Aceptar ruta" }),
    approval: null,
    ...input,
  });
  if (!accepted.ok) throw new Error(accepted.failure.code);
  return accepted.directive;
}
