/**
 * The reserved source alias 29.0.0 renamed (`workspace` → `hub`), rewritten
 * only where it still runs: open plans and open runs.
 *
 * A closed plan or a closed run is history and stays byte for byte as it was.
 * An open plan that kept `workspace` would stop passing `aw plan lint`, and an
 * open run would lose the source its scope names.
 */

import { join, relative } from "node:path";
import { parseRunState, sealRunState, serializeRunState } from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import { parsePlanStatus } from "../parsers/plan-status.js";
import type { PathsService } from "../paths-service.js";
import { CLOSED_MARKER, listSessionFolders } from "../session-resolver.js";

const LEGACY_ALIAS = "workspace";
const HUB_ALIAS = "hub";
const LEGACY_WORD = /(?<![\w-])workspace(?![\w-])/g;
const SOURCES_LINE = /^(\s*>\s*Fuentes:)(.*)$/;
const TASK_MARK = /(_\(fuentes:)([^)]*)(\)_)/g;

export interface AliasLine {
  /** 1-based line number in the file as it is today. */
  line: number;
  before: string;
  after: string;
}

export interface PlanAliasRewrite {
  /** Absolute path of the open plan. */
  path: string;
  lines: AliasLine[];
  /** The exact bytes the file will hold. */
  text: string;
}

export interface RunScopeRewrite {
  /** Absolute path of the run state. */
  path: string;
  session: string;
  /** The exact bytes the file will hold, resealed. */
  text: string;
}

/** The same line with the legacy alias renamed inside its source declarations only. */
function rewriteAliasLine(line: string): string {
  const declared = SOURCES_LINE.exec(line);
  const head = declared
    ? `${declared[1]}${(declared[2] ?? "").replace(LEGACY_WORD, HUB_ALIAS)}`
    : line;
  return head.replace(
    TASK_MARK,
    (_match, open: string, list: string, close: string) =>
      `${open}${list.replace(LEGACY_WORD, HUB_ALIAS)}${close}`,
  );
}

/** What an open plan needs, or `null` when it is closed or already says `hub`. */
export function planAliasRewrite(path: string, text: string): PlanAliasRewrite | null {
  if (parsePlanStatus(text).declared !== "open") return null;
  const lines = text.split("\n");
  const changed: AliasLine[] = [];
  lines.forEach((before, index) => {
    const after = rewriteAliasLine(before);
    if (after === before) return;
    changed.push({ line: index + 1, before, after });
    lines[index] = after;
  });
  return changed.length === 0 ? null : { path, lines: changed, text: lines.join("\n") };
}

/** Every open plan of the hub whose source declarations still name `workspace`. */
export async function planAliasRewrites(
  fs: FileSystemPort,
  paths: PathsService,
  hub: string,
): Promise<PlanAliasRewrite[]> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) throw new Error(canon.error);
  const dir = join(hub, canon.canon.plan);
  if (!(await fs.exists(dir))) return [];
  const rewrites: PlanAliasRewrite[] = [];
  for (const entry of await fs.list(dir)) {
    if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
    const rewrite = planAliasRewrite(entry.path, await fs.readText(entry.path));
    if (rewrite !== null) rewrites.push(rewrite);
  }
  return rewrites;
}

/**
 * Every open run whose scope still names `workspace`, resealed with `hub`.
 *
 * A run whose state does not parse is left alone: rewriting it would hide the
 * tampering its seal exists to expose, and `aw flow recover` reports it as is.
 */
export async function runScopeRewrites(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<RunScopeRewrite[]> {
  const rewrites: RunScopeRewrite[] = [];
  for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const path = join(folder.path, ".flow-run.json");
    if ((await fs.exists(join(folder.path, CLOSED_MARKER))) || !(await fs.exists(path))) continue;
    const read = parseRunState(await fs.readText(path), folder.name);
    const scope = read.ok ? read.state.scope : null;
    if (!read.ok || scope === null || !scope.sources.includes(LEGACY_ALIAS)) continue;
    const { digest: _seal, ...state } = read.state;
    const sources = scope.sources.map((alias) => (alias === LEGACY_ALIAS ? HUB_ALIAS : alias));
    const text = serializeRunState(sealRunState({ ...state, scope: { ...scope, sources } }));
    rewrites.push({ path, session: folder.name, text });
  }
  return rewrites;
}

/** `file:line` of each rewritten declaration, relative to the hub, for the preview. */
export function aliasLocations(hub: string, rewrites: readonly PlanAliasRewrite[]): string[] {
  return rewrites.flatMap((rewrite) =>
    rewrite.lines.map((line) => `${relative(hub, rewrite.path)}:${line.line}`),
  );
}
