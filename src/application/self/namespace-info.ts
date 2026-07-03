import { dirname } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { namespaceConfigFile } from "../../runtime/namespace-resolver.js";
import { normalizeNamespace } from "../../runtime/namespace.js";

export interface SelfNamespaceData {
  namespace: string;
  source: string;
}

export interface SelfNamespacePinData {
  pinned: string;
  path: string;
}

export async function selfNamespace(ctx: CliContext): Promise<CommandResult<SelfNamespaceData>> {
  return {
    ok: true,
    data: {
      namespace: ctx.namespace.namespace,
      source: ctx.namespace.source,
    },
    exitCode: 0,
  };
}

/**
 * Writes the global namespace-pin file (mkdir -p + `<name>\n`). The single write
 * site for that file, shared by the command wrapper below and the TUI, so the
 * path/format live in one place. Assumes `name` is already a valid namespace.
 */
export async function writeNamespacePin(
  fs: FileSystemPort,
  homeDir: string,
  name: string,
): Promise<string> {
  const path = namespaceConfigFile(homeDir);
  await fs.mkdirp(dirname(path));
  await fs.writeText(path, `${name}\n`);
  return path;
}

/**
 * Pins the global namespace to `~/.config/agent-workflow/namespace` — the same
 * file NamespaceResolver reads with source "config". Cross-platform via Node fs:
 * the portable replacement for the SessionStart `sh -c`/`$HOME` hook. The name is
 * validated with the shared normalizer before writing.
 */
export async function selfNamespacePin(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<SelfNamespacePinData>> {
  let normalized: string;
  try {
    normalized = normalizeNamespace(name);
  } catch (err) {
    return {
      ok: false,
      error: { code: "INVALID_NAMESPACE", message: (err as Error).message },
      exitCode: 1,
    };
  }
  const path = await writeNamespacePin(ctx.fs, ctx.env.homeDir(), normalized);
  return { ok: true, data: { pinned: normalized, path }, exitCode: 0 };
}
