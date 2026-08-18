// The vocabulary every hook dialect shares: what a transform could not carry,
// what it carried with something missing, and whose a command is.
//
// It sits apart from any one dialect because all three answers are the same
// question in every host — and the TOML transform owned them first only because
// Kimi Code was the first host that needed a dialect at all.

export interface HookSkip {
  event: string;
  reason: string;
}

/**
 * A hook that DID install but not whole. Kept apart from {@link HookSkip} because
 * the two say different things to whoever reads the install output: a skip means
 * the hook is not there, a degradation means it is there and does less. Collapsing
 * them would report a working hook as missing, or a missing one as working.
 */
export interface HookDegradation {
  event: string;
  /** What the host could not carry, and what it does instead. */
  reason: string;
}

/**
 * True when this command line invokes THIS CLI (and not a lookalike binary).
 *
 * OWNERSHIP IS BY DATA, NOT BY COMMENT: a host that re-serializes its own config
 * drops every marker we could write, so what identifies our entries is the one
 * thing that survives — every command we install invokes this CLI.
 */
export function isOurCommand(command: string): boolean {
  const trimmed = command.trimStart();
  return trimmed === "agent-workflow" || trimmed.startsWith("agent-workflow ");
}
