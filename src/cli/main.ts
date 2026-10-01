#!/usr/bin/env node
import { hasWorklineMarker } from "../runtime/workline-marker.js";
const argv = process.argv.slice(2);
// Help reads no hub, so it is served wherever it is asked for.
const asksHelp = argv.includes("--help") || argv.includes("-h");
// The lifecycle targets a host runs everywhere: outside a hub they stay silent.
const LIFECYCLE_HOOKS = new Set(["pre-compact", "post-compact", "session-end"]);
const lifecycleHook = argv[0] === "hook" && LIFECYCLE_HOOKS.has(argv[1] ?? "");
const scoped =
  !asksHelp &&
  (argv[0] === "checkpoint-write" ||
    lifecycleHook ||
    (argv[0] === "self" && argv[1] === "namespace" && argv.includes("--pin")));

async function scopedHubVisible(): Promise<boolean> {
  const { homedir } = await import("node:os");
  // $HOME is never a hub, though the user-level ~/.workflow carries a marker.
  if (process.cwd() === homedir()) return false;
  if (await hasWorklineMarker(process.cwd())) return true;
  // A source without its own marker can still belong to a registered hub.
  // Consult the user-level index without creating hub runtime or invoking git.
  const { declaringHubs } = await import("../application/hub-registry.js");
  const { NodeFileSystem } = await import("../adapters/node-file-system.js");
  const flag = argv.indexOf("--namespace");
  const namespace =
    flag < 0 ? (process.env.AW_NAMESPACE ?? "workflow") : (argv[flag + 1] ?? "workflow");
  try {
    return (
      (await declaringHubs(new NodeFileSystem(), homedir(), namespace, process.cwd())).length > 0
    );
  } catch {
    return false;
  }
}

if (argv[0] === "hook" && argv[1] !== "sql-mutation-guard" && !lifecycleHook && !asksHelp) {
  // A retired hook invoked by an old host config must not materialize runtime
  // or block an edit. Refuse it directly, without loading the full CLI.
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: { code: "INVALID_INPUT", message: `hook: unknown subcommand '${argv[1] ?? ""}'` },
    })}\n`,
  );
  process.exitCode = 1;
} else if (scoped) {
  if (await scopedHubVisible()) await import("./full-cli.js");
} else {
  // sql-mutation-guard protects user-level connections, even without a hub.
  await import("./full-cli.js");
}
