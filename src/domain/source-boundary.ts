/** The only execution surface a Workline plan may use to close a phase. */
export type ExecutionSurface = "checkout";

/** Evidence id shared by every gate that decides whether local proof is enough. */
export const SOURCE_BOUNDED_EVIDENCE = "workline.source-bounded";

/**
 * The local checkout a boundary's source-bounded evidence will be measured against.
 *
 * It exists because the prover could not deduce it. The digest is computed over a
 * directory this run resolved, and until that directory was published the only way
 * to learn it was to have a proof rejected — which is the one thing a boundary's
 * attempts cannot afford.
 *
 * Deliberately NOT part of {@link CheckoutProof}: a proof that carried its own root
 * would look transferable between hosts, and it is not. The transferable half is the
 * resolution RULE, which `aw flow --help` states; the path is an observation of this
 * run on this machine.
 */
export interface CheckoutIdentity {
  /** The eligible alias: `workspace`, or one of this session's isolated units. */
  source: string;
  /** Absolute local root this run resolved for that alias, on THIS host. */
  root: string;
}

/** A reproducible local observation tied to one checkout. */
export interface CheckoutProof {
  kind: "command" | "inspection";
  source: string;
  relative_cwd: string;
  checkout_digest: string;
  invocation: { program: string; args: string[] } | { artifact: string };
}

/** A remote read is research context, never a validation or closure proof. */
export interface RemoteContextSnapshot {
  kind: "remote-read";
  connection: string;
  readonly: true;
  query_artifact: string;
  captured_at: string;
  result_digest: string;
}
