/** The only execution surface an agent-workflow plan may use to close a phase. */
export type ExecutionSurface = "checkout";

/** Evidence id shared by every gate that decides whether local proof is enough. */
export const SOURCE_BOUNDED_EVIDENCE = "agent-workflow.source-bounded";

/**
 * The local checkout a boundary's source-bounded evidence will be measured against.
 *
 * It exists because the prover could not deduce it. The digest is computed over a
 * directory this run resolved, and until that directory was published the only way
 * to learn it was to have a proof rejected — which is the one thing a boundary's
 * attempts cannot afford.
 *
 * A proof may now carry the root for diagnosis; it is not authorization and never
 * enters the checkout digest. The resolution rule remains the portable half.
 */
export interface CheckoutIdentity {
  /** The eligible alias: `hub`, or one of this session's isolated units. */
  source: string;
  /** Absolute local root this run resolved for that alias, on THIS host. */
  root: string;
}
