import type { EnvPort } from "../ports/env.js";

/**
 * Neutral conversation-identity boundary.
 *
 * The core never interprets the id's format — it only needs an opaque, stable
 * value per host conversation. Which host injects it, and how, belongs to the
 * multi-host surface work (spec 010); here the CLI reads the agreed env var.
 */
export const CONTEXT_ID_ENV = "AW_CONTEXT_ID";

/** The conversation id, or `undefined` when the host supplied none. */
export function readContextId(env: EnvPort): string | undefined {
  const raw = env.get(CONTEXT_ID_ENV)?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}
