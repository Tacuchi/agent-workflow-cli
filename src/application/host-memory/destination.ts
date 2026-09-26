import { join, resolve } from "node:path";
import type { CliContext } from "../../cli/types.js";
import { type Harness, harnessById } from "../../domain/harnesses.js";
import type { HostMemoryDestination } from "../../domain/host-memory/model.js";
import { CODEX_AD_HOC_NAME_FORMAT, codexMemoryPaths, readCodexMemoriesSwitch } from "./codex.js";

export interface DestinationResolution {
  destination: HostMemoryDestination | null;
  reason: string | null;
  /** The part of the current host's memory that says whether it already holds a learning. */
  presenceRoot: string | null;
}

/**
 * Where the current host would save a learning. The CLI never saves: it names
 * the place, and the host's agent writes there through its own channel.
 */
export async function resolveDestination(
  host: Harness,
  ctx: CliContext,
): Promise<DestinationResolution> {
  const home = ctx.env.homeDir();
  if (host === "claude-code") {
    const root = await gitRootOf(ctx, ctx.env.cwd());
    const path = join(home, ".claude", "projects", claudeProjectKey(root), "memory");
    const destination = { path, channel: "claude-code-memory-note", name_format: null } as const;
    return { destination, reason: null, presenceRoot: path };
  }
  if (host === "codex") {
    const paths = codexMemoryPaths(home);
    const off = await readCodexMemoriesSwitch(ctx.fs, paths.config);
    if (off !== null) return nowhere(`la memoria de Codex no está activa: ${off.reason}`);
    const destination = {
      path: paths.notesDir,
      channel: "codex-ad-hoc-note",
      name_format: CODEX_AD_HOC_NAME_FORMAT,
    } as const;
    // Codex's memory is global, and consolidation may carry a note's mark into MEMORY.md.
    return { destination, reason: null, presenceRoot: paths.memories };
  }
  if (host === "unknown") {
    return nowhere("host no reconocido: sin --host ni marcador de entorno no hay memoria propia");
  }
  const label = harnessById(host)?.label ?? host;
  return nowhere(`${label} no guarda memoria curada propia: no tiene dónde guardar`);
}

function nowhere(reason: string): DestinationResolution {
  return { destination: null, reason, presenceRoot: null };
}

/** Claude Code files a project's memory under its git root, every non-alphanumeric turned into `-`. */
function claudeProjectKey(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, "-");
}

async function gitRootOf(ctx: CliContext, dir: string): Promise<string> {
  // git counts the prefix over the physical path; climbing it from a symlinked
  // spelling of the same directory would land in a folder Claude Code never reads.
  const physical = await ctx.fs.realPath(dir);
  const prefix = await ctx.git.repoPrefix(physical);
  if (prefix === null) return physical;
  const depth = prefix.split("/").filter(Boolean).length;
  return resolve(physical, ...Array<string>(depth).fill(".."));
}
