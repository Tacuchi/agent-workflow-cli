#!/usr/bin/env node
import { hasAgentWorkflowMarker } from "../runtime/agent-workflow-marker.js";
const argv = process.argv.slice(2);
// Help reads no hub, so it is served wherever it is asked for.
const asksHelp = argv.includes("--help") || argv.includes("-h");
// What a host runs on its own events, everywhere: outside a hub it stays silent.
const scoped =
  !asksHelp &&
  (argv[0] === "checkpoint-write" ||
    (argv[0] === "self" && argv[1] === "namespace" && argv.includes("--pin")));

async function scopedHubVisible(): Promise<boolean> {
  const { homedir } = await import("node:os");
  // $HOME is never a hub, though the user-level ~/.workflow carries a marker.
  if (process.cwd() === homedir()) return false;
  if (await hasAgentWorkflowMarker(process.cwd())) return true;
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

if (scoped) {
  if (await scopedHubVisible()) await import("./full-cli.js");
} else {
  await import("./full-cli.js");
}
