/**
 * The command's half: find the session, take the run's lock, advance, persist.
 *
 * Everything decision-shaped lives in the engine and the registry; what is here
 * is the plumbing that makes the advance atomic and addressable — which session,
 * which state, one write.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { journeyOfFlow } from "../../domain/flow/authority.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import { type FlowRunState, newRunState } from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { WORKLINE_FLOWS, type WorklineFlow } from "../capability/compose.js";
import type { PathsService } from "../paths-service.js";
import { recordFlowAdoption } from "../session-custody-recorder.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import { advanceFlowRun } from "./advance.js";
import type { InternalActionExecutor } from "./internal-actions.js";
import { driveInternalActions } from "./internal-drive.js";
import { applyUnderLock, locateRun } from "./run-state-service.js";

export interface AdvanceFlowInput {
  code?: string;
  contextId?: string;
  /** Required only to adopt a session that has no run state yet. */
  flow?: string;
  /** Initialize the run state of a legacy session instead of refusing. */
  adopt: boolean;
  /**
   * How this process materializes the actions the registry classifies internal.
   *
   * Optional because not every caller can supply one, and the absence is a real
   * answer rather than a hole: without it an internal action is emitted as the
   * boundary it always was, with its invocation, and nothing is credited. See
   * {@link driveInternalActions}.
   */
  executor?: InternalActionExecutor;
}

export type AdvanceFlowResult =
  | { ok: true; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure }
  | { ok: false; session: SessionResolutionError };

export async function advanceFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: AdvanceFlowInput,
): Promise<AdvanceFlowResult> {
  // A write path: a closed line is never advanced by accident, and nothing is
  // chosen by recency — several active sessions with no association is ambiguous.
  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind: true,
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };

  const session = resolution.session.folder;
  const location = locateRun(paths, session);
  // Read BEFORE the advance: afterwards the state file always exists, so this is
  // the only moment that can tell an adoption from an ordinary advance.
  const adopting = input.adopt && !(await fs.exists(location.statePath));

  const applied = await applyUnderLock<FlowDirective>(
    fs,
    location,
    (current) => {
      const seeded = current ?? seed(input, session);
      if ("failure" in seeded) return { ok: false, failure: seeded.failure };
      const advance = advanceFlowRun({
        state: seeded,
        journey: journeyOfFlow(seeded.flow),
      });
      if (!advance.ok) return { ok: false, failure: advance.failure };
      return { ok: true, state: advance.state, value: advance.directive };
    },
    { allowAbsent: input.adopt },
  );

  if (!applied.ok) return { ok: false, failure: applied.failure };
  // What the session IS, recorded once, from the adoption that really happened.
  if (adopting) await recordFlowAdoption({ fs, paths }, session, applied.state.flow);
  // Deciding stopped at the first delegated step; executing continues past every
  // one of them this process owns. Two calls and not one loop, because the walk is
  // pure and the execution is not.
  const driven = await driveInternalActions(fs, location, input.executor, {
    ok: true,
    state: applied.state,
    value: applied.value,
  });
  if (!driven.ok) return { ok: false, failure: driven.failure };
  return { ok: true, directive: driven.value };
}

/**
 * The state a legacy session gets when it is adopted.
 *
 * Adoption needs the flow named explicitly: guessing it from the folder suffix
 * would make the CLI infer the one thing the whole run hangs off, and a wrong
 * guess would walk the wrong journey.
 */
function seed(
  input: AdvanceFlowInput,
  session: string,
): FlowRunState | { failure: CapabilityFailure } {
  const flow = input.flow;
  if (flow === undefined || !(WORKLINE_FLOWS as readonly string[]).includes(flow)) {
    return {
      failure: {
        code: "FLOW_ADOPTION_FLOW_MISSING",
        message:
          flow === undefined
            ? "adoptar una sesión legacy exige nombrar su flow"
            : `'${flow}' no es un flow de Workline`,
        action: `pasá --flow con uno de: ${WORKLINE_FLOWS.join(", ")}`,
      },
    };
  }
  return newRunState(flow as WorklineFlow, session);
}
