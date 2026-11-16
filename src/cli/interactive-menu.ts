import { dirname, resolve } from "node:path";
import { readHubBlock } from "../application/parsers/hub-block.js";
import { isAgentWorkflowRoot } from "../runtime/agent-workflow-marker.js";
import type { CliContext } from "./types.js";

export interface MenuPredicateInput {
  command: string | undefined;
  isTTY: boolean;
  hasHelp: boolean;
}

export function shouldShowInteractiveMenu(input: MenuPredicateInput): boolean {
  return input.command === undefined && input.isTTY && !input.hasHelp;
}

/** What `aw` with no arguments prints outside a hub, instead of opening the TUI. */
export const OUTSIDE_HUB_TEXT =
  "Aquí no hay un hub de agent-workflow. Créalo con `aw hub-init`, o abre `aw` dentro de uno.\n";

/** A hub carries its marker or its block in AGENTS.md; $HOME never is one. */
export async function insideHub(ctx: Pick<CliContext, "fs" | "rawFs" | "paths">): Promise<boolean> {
  const fs = ctx.rawFs ?? ctx.fs;
  const root = resolve(ctx.paths.hubDir());
  if (root === dirname(ctx.paths.userRoot())) return false;
  if (await isAgentWorkflowRoot(fs, root, ctx.paths.namespace)) return true;
  return (await readHubBlock(fs, root, ctx.paths.blockMarkers())) !== null;
}
