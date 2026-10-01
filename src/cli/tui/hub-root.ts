import type { CliContext } from "../types.js";

/**
 * The bootstrap coordinate is authoritative in production. The last branch
 * keeps lightweight, pre-directory UI mocks working while they migrate.
 */
export function hubRoot(ctx: CliContext): string {
  if (ctx.directory !== undefined) return ctx.directory.root;

  const hubDir = ctx.paths.hubDir;
  if (typeof hubDir === "function") return hubDir.call(ctx.paths);

  return ctx.env.cwd();
}
