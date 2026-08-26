import type { CliContext } from "../types.js";

/**
 * The bootstrap coordinate is authoritative in production. The last branch
 * keeps lightweight, pre-directory UI mocks working while they migrate.
 */
export function workspaceRoot(ctx: CliContext): string {
  if (ctx.directory !== undefined) return ctx.directory.root;

  const workspaceDir = ctx.paths.workspaceDir;
  if (typeof workspaceDir === "function") return workspaceDir.call(ctx.paths);

  return ctx.env.cwd();
}
