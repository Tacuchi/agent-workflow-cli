/**
 * What the DIRECT route adds on top of the capability contract.
 *
 * The generic half — envelope, attempts, outcomes, receipt correlation, the
 * rule that a direct invocation opens no flow session — is already delivered
 * and tested by the capability layer. Three things are left, and all three are
 * design-domain decisions:
 *
 * - **Where the output lands.** Inside a workspace it defaults to
 *   `docs/designs/`; outside one it needs an explicit root and still produces
 *   something portable. A capability that simply refused outside a workspace
 *   would make "design something on a machine that has no Workline project" an
 *   error instead of an answer.
 * - **Which domain fields the receipt carries.** The canonical receipt already
 *   says operation, validations, degradations, effects and next action; it
 *   knows nothing about packages, baselines or maturity. Those are added here
 *   and nowhere else — repeating the canonical ones would be a second receipt.
 * - **What maturity the result may claim.** The one rule the whole ladder rests
 *   on: an omission that could change behavior means the answer is `outline`
 *   with a gap, never a `handoff` nobody can trace back.
 */

import { checkSafeRelativePath } from "../safe-path.js";
import type { DesignMaturity } from "./artifact.js";
import type { DesignRouteMode, FiredSignal } from "./expansion.js";
import type { DesignSource, SourceReport } from "./sources.js";
import { handoffGapsFrom } from "./sources.js";
import type { DesignFailure } from "./validation.js";

/** The conventional home of packages inside a workspace. */
export const DESIGNS_DIR = "docs/designs";

export type OutputRoot =
  /** Inside a workspace: `docs/designs/` unless the caller narrowed it. */
  | { kind: "workspace"; root: string; declared: boolean }
  /** Outside one: whatever absolute root the caller named. */
  | { kind: "explicit"; root: string };

export type OutputRootResolution =
  | { ok: true; value: OutputRoot }
  | { ok: false; failure: DesignFailure };

/**
 * Decide where a directly-invoked operation writes.
 *
 * Being outside a workspace is not an error — it is a different mode, and the
 * only thing it costs is that the caller has to say where. What is refused is
 * guessing: writing a package into whatever directory the process happened to
 * start in is how a design ends up somewhere nobody looks again.
 */
export function resolveOutputRoot(
  workspace: string | null,
  target: string | null,
  artifact = "design",
): OutputRootResolution {
  if (workspace === null) {
    if (target === null || target.trim().length === 0) {
      return {
        ok: false,
        failure: {
          code: "DESIGN_OUTPUT_ROOT_REQUIRED",
          artifact,
          message: "fuera de un workspace hace falta una raíz explícita para el package",
          action: "pasá 'target' con la ruta donde debe quedar el package",
        },
      };
    }
    // An explicit root outside a workspace is the caller's own path: it is not
    // validated as workspace-relative, because it is not relative to one.
    return { ok: true, value: { kind: "explicit", root: target.trim() } };
  }

  if (target === null || target.trim().length === 0) {
    return { ok: true, value: { kind: "workspace", root: DESIGNS_DIR, declared: false } };
  }

  const safe = checkSafeRelativePath(target.trim());
  if (!safe.ok) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_OUTPUT_ROOT_UNSAFE",
        artifact,
        message: `'${target}' no es una ruta relativa válida dentro del workspace: ${safe.why}`,
        action: `usá una ruta relativa dentro del workspace, por ejemplo '${DESIGNS_DIR}'`,
      },
    };
  }
  return { ok: true, value: { kind: "workspace", root: safe.path, declared: true } };
}

/**
 * Whether a package written at this root is discoverable by the index.
 *
 * Only the ones under `docs/designs/` are. That is not a limitation of the
 * index — it is what makes `AC-DIR-06` meaningful: a package created directly
 * inside a workspace can be referenced later by a spec or a plan without ever
 * having had a relationship with those flows, precisely because it landed where
 * discovery looks.
 */
export function isIndexable(root: OutputRoot): boolean {
  if (root.kind !== "workspace") return false;
  const segments = root.root.split("/").filter((s) => s.length > 0);
  const expected = DESIGNS_DIR.split("/");
  return expected.every((segment, i) => segments[i] === segment);
}

export interface DesignBaselineRef {
  revision: number;
  digest: string;
}

/**
 * The domain fields `design` adds to the canonical receipt.
 *
 * Deliberately does NOT repeat operation, validations, degradations, effects or
 * next action: those already travel in the capability receipt, and carrying
 * them twice is how two records of one attempt start disagreeing.
 */
export interface DesignReceiptFields {
  package: string | null;
  baseline: DesignBaselineRef | null;
  /**
   * Why this attempt carries no baseline — null whenever it carries one.
   *
   * `render` and `record` publish without minting a revision, and that is their
   * nature rather than a failure: a projection is derived from the manifest and
   * a governance decision decides ON a baseline instead of creating one. What
   * was a defect is a receipt that showed `baseline: null` and said nothing, so
   * "no sealed anything" and "had nothing to seal" read the same.
   */
  unsealed: string | null;
  /** Where it landed, and under which root mode. */
  path: string | null;
  root: OutputRoot["kind"] | null;
  indexable: boolean;
  maturity: {
    requested: DesignMaturity | null;
    /**
     * DERIVED from the gates' verdict, on every route.
     *
     * It used to be fixed per route — `null` for a simple design, "the ladder
     * the route has" for a package — and a maturity that answers differently
     * depending on which code path published the same evidence is not a verdict.
     * Worse, `null` made `handoff` unreachable on the route that is the default:
     * the ceiling existed and nothing could ever touch it.
     */
    attained: DesignMaturity;
  };
  sources: DesignSource[];
  /** Rendition ids produced or refreshed by this attempt. */
  renditions: string[];
  /**
   * Which route this attempt took and WHY — the answer to "what is this extra
   * structure for". Simple carries an empty signal list and no cause; every
   * package artifact beyond the simple document traces back to one of them.
   */
  route: {
    mode: DesignRouteMode;
    signals: FiredSignal[];
    cause: string | null;
  };
}

export interface AttainedMaturity {
  attained: DesignMaturity;
  /** Non-empty exactly when the requested maturity was not reached. */
  gaps: string[];
}

/**
 * The maturity the result may honestly claim.
 *
 * Two independent reasons to fall back to `outline`, and both are ceilings
 * rather than opinions: the document-level verdict the `012` gate already
 * computes, and an essential source that did not contribute. Neither can be
 * argued past — a floor and an improvement get the same answer here, which is
 * what stops an improvement from "achieving" a `handoff` the evidence does not
 * support.
 */
export function attainedMaturity(
  requested: DesignMaturity | null,
  gateVerdict: DesignMaturity,
  report: SourceReport,
): AttainedMaturity {
  const gaps = handoffGapsFrom(report);
  if (report.blocksHandoff) return { attained: "outline", gaps };
  if (requested === "handoff" && gateVerdict !== "handoff") {
    return {
      attained: gateVerdict,
      gaps: [
        `se pidió 'handoff' y la evidencia del package alcanza '${gateVerdict}': completá lo que el gate reclama`,
      ],
    };
  }
  return { attained: gateVerdict, gaps: [] };
}
