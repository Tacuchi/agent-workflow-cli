// `run.mjs --auth-check`: the person runs it before the real run. It prepares
// each selected host's disposable root exactly as the run does (credential copy,
// token file, profile), runs ONLY each host's auth probe, reports per host, keeps
// any rotated credential, and cleans up. It never opens a Herdr workspace or pane.
//
// Same gates as a launch — a real TTY, no agent host or Herdr in the env or among
// the ancestors — plus the typed confirmation word AUTH_CHECK_WORD. A word, not
// the digest: nothing here runs the scenario, and the output says up front which
// probes spend a model prompt (agy, crush, kimi) so the person confirms knowing it.

import { refusal } from "./approval.mjs";
import { HOSTS } from "./hosts.mjs";

export const AUTH_CHECK_WORD = "check";

/** Hosts whose probe is one model turn (they have no login-status subcommand). */
export const PROMPT_PROBES = Object.keys(HOSTS).filter(
  (id) => HOSTS[id].probeSpendsPrompt === true,
);

/** One host's outcome from its preparation log: authenticated, or why not (a category). */
export function authOutcome(log) {
  const failed = log.find((s) => !s.ok);
  if (!failed) return "authenticated";
  if (failed.step.startsWith("auth probe")) return "NOT authenticated (probe failed)";
  const category = failed.step.split(/\s+/).slice(0, 3).join(" ").replace(/:$/, "");
  return `NOT authenticated (preparation failed at: ${category})`;
}

/**
 * deps = {stdinIsTTY, stdoutIsTTY, env, markers, ancestor() → string|null, hosts,
 * tokens: {host: "present"|"absent"}, ask(question) → Promise<string>, log(msg),
 * prepare(host) → Promise<log[]> | log[], finish() → void, herdr?}. `herdr` is
 * accepted only so a test can prove it is never touched.
 */
export async function authCheck(deps) {
  const why = refusal({
    stdinIsTTY: deps.stdinIsTTY,
    stdoutIsTTY: deps.stdoutIsTTY,
    env: deps.env,
    markers: deps.markers,
    ancestor: deps.ancestor ? deps.ancestor() : null,
  });
  if (why !== null) {
    deps.log(why.replace("run.mjs", "run.mjs --auth-check"));
    return 1;
  }
  announce(deps);
  const typed = await deps.ask(`Type '${AUTH_CHECK_WORD}' to run the auth probes: `);
  if (typeof typed !== "string" || typed.trim() !== AUTH_CHECK_WORD) {
    deps.log("not confirmed: nothing was prepared");
    return 1;
  }
  try {
    deps.beforePrepare?.();
    return (await probeAll(deps)) === 0 ? 0 : 1;
  } finally {
    deps.finish();
  }
}

/** What the person is told before confirming: what runs, what it costs, what it uses. */
function announce(deps) {
  deps.log(`--auth-check prepares a disposable root for: ${deps.hosts.join(", ")}.`);
  deps.log("It runs only each host's auth probe. It opens NO Herdr workspace or pane.");
  const spending = deps.hosts.filter((h) => PROMPT_PROBES.includes(h));
  deps.log(
    spending.length > 0
      ? `These probes spend one model prompt each: ${spending.join(", ")}.`
      : "No selected probe spends a model prompt.",
  );
  for (const [host, state] of Object.entries(deps.tokens ?? {})) {
    if (deps.hosts.includes(host))
      deps.log(`${HOSTS[host].token.label}: ${state} (value never shown)`);
  }
  for (const note of deps.notes ?? []) deps.log(note);
}

/** Each host's probe, one after the other; returns how many did not authenticate. */
async function probeAll(deps) {
  let failures = 0;
  for (const host of deps.hosts) {
    const outcome = authOutcome(await deps.prepare(host));
    if (outcome !== "authenticated") failures += 1;
    deps.log(`  ${host.padEnd(12)} ${outcome}`);
  }
  return failures;
}
