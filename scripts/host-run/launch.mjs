// The only road from «the person ran run.mjs» to «something is prepared or
// opened». Every side effect is injected, so a test can prove that without a
// TTY, from inside an agent host, or without the exact digest, none happens.

import { approves, refusal } from "./approval.mjs";

/**
 * deps = {stdinIsTTY, stdoutIsTTY, env, markers, ancestor() → string|null, digest,
 * show(), ask(question) →
 * Promise<string>, start() → Promise<number>, log(msg)}. Returns an exit code.
 */
export async function launch(deps) {
  const why = refusal({
    stdinIsTTY: deps.stdinIsTTY,
    stdoutIsTTY: deps.stdoutIsTTY,
    env: deps.env,
    markers: deps.markers,
    ancestor: deps.ancestor ? deps.ancestor() : null,
  });
  if (why !== null) {
    deps.log(why);
    return 1;
  }
  deps.show();
  const typed = await deps.ask(
    `Type the digest ${deps.digest} to approve this scenario and these profiles: `,
  );
  if (!approves(typed, deps.digest)) {
    deps.log("digest does not match: nothing was prepared and no pane was opened");
    return 1;
  }
  return deps.start();
}
