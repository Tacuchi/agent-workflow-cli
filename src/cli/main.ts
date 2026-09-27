#!/usr/bin/env node
import { hasWorklineMarker } from "../runtime/workline-marker.js";
import { cacheHookStdin } from "./hook-stdin-cache.js";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const argv = process.argv.slice(2);
const hook = argv[0] === "hook" ? argv[1] : undefined;
const scoped =
  hook === "branch-check" ||
  hook === "turn-start" ||
  hook === "git-commit-advisor" ||
  argv[0] === "checkpoint-write" ||
  argv[0] === "resume-summary" ||
  argv[0] === "auto-compact-on-close" ||
  (argv[0] === "self" && argv[1] === "namespace" && argv.includes("--pin"));

async function scopedWorkspaceVisible(): Promise<boolean> {
  if (await hasWorklineMarker(process.cwd())) return true;
  // A source without its own marker can still belong to a registered hub.
  // Consult the user-level index without creating workspace runtime or invoking git.
  const { declaringHubs } = await import("../application/hub-registry.js");
  const { NodeFileSystem } = await import("../adapters/node-file-system.js");
  const { homedir } = await import("node:os");
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

if (hook === "git-commit-advisor") {
  // Only the advisor needs stdin to decide whether the expensive CLI is needed.
  // A payload meant for another tool cannot be a git commit either.
  const { readHookStdin } = await import("./context-id.js");
  const stdin = await readHookStdin();
  let payload: { tool_name?: unknown; tool_input?: { command?: unknown } } | null = null;
  try {
    payload = JSON.parse(stdin ?? "");
  } catch {
    // The advisor itself treats an invalid payload as a pass.
  }
  if (
    payload?.tool_name !== "Bash" ||
    typeof payload.tool_input?.command !== "string" ||
    !GIT_COMMIT_RE.test(payload.tool_input.command)
  ) {
    process.exitCode = 0;
  } else {
    cacheHookStdin(stdin);
    if (await scopedWorkspaceVisible()) await import("./full-cli.js");
  }
} else if (scoped) {
  if (await scopedWorkspaceVisible()) await import("./full-cli.js");
} else {
  // sql-mutation-guard protects user-level connections, even without a workspace.
  await import("./full-cli.js");
}
