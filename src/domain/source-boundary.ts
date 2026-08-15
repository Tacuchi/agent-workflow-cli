/** The only execution surface a Workline plan may use to close a phase. */
export type ExecutionSurface = "checkout";

/** Evidence id shared by every gate that decides whether local proof is enough. */
export const SOURCE_BOUNDED_EVIDENCE = "workline.source-bounded";

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
