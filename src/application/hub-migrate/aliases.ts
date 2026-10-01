/**
 * The reserved source alias 29.0.0 renamed (`workspace` → `hub`), rewritten
 * only where it still runs: open plans and open runs.
 *
 * A closed plan or a closed run is history and stays byte for byte as it was.
 * An open plan that kept `workspace` would stop passing `aw plan lint`, and an
 * open run would lose the source its scope names.
 */

import { join, relative } from "node:path";
import {
  type FlowRunState,
  type PlanExecBatch,
  parseRunState,
  sealRunState,
  serializeRunState,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import { parsePlanStatus } from "../parsers/plan-status.js";
import type { PathsService } from "../paths-service.js";
import { CLOSED_MARKER, listSessionFolders } from "../session-resolver.js";
import { sourceDeclarationLines } from "../source-boundary-policy.js";

const LEGACY_ALIAS = "workspace";
const HUB_ALIAS = "hub";
const LEGACY_WORD = /(?<![\w-])workspace(?![\w-])/g;
// Same tolerance as the reader (source-boundary-policy): case, spacing around `:`.
const SOURCES_LINE = /^(\s*>\s*Fuentes\s*:)(.*)$/i;
const TASK_MARK = /(_\(\s*fuentes\s*:)([^)]*)(\)_)/gi;

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
function rewriteAliasLine(raw: string): string {
  // A CRLF plan keeps its `\r`: `.` never matches it, so it is set aside first.
  const eol = raw.endsWith("\r") ? "\r" : "";
  const line = eol ? raw.slice(0, -1) : raw;
  const declared = SOURCES_LINE.exec(line);
  const head = declared
    ? `${declared[1]}${(declared[2] ?? "").replace(LEGACY_WORD, HUB_ALIAS)}`
    : line;
  const rewritten = head.replace(
    TASK_MARK,
    (_match, open: string, list: string, close: string) =>
      `${open}${list.replace(LEGACY_WORD, HUB_ALIAS)}${close}`,
  );
  return `${rewritten}${eol}`;
}

/** What an open plan needs, or `null` when it is closed or already says `hub`. */
export function planAliasRewrite(path: string, text: string): PlanAliasRewrite | null {
  if (parsePlanStatus(text).declared !== "open") return null;
  const lines = text.split("\n");
  const changed: AliasLine[] = [];
  for (const index of sourceDeclarationLines(text)) {
    const before = lines[index] ?? "";
    const after = rewriteAliasLine(before);
    if (after === before) continue;
    changed.push({ line: index + 1, before, after });
    lines[index] = after;
  }
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

/** A run that still names the legacy alias, and why it is left as it is. */
export interface RunScopeConflict {
  path: string;
  session: string;
  detail: string;
}

/**
 * Every open run that still names `workspace`, resealed with `hub` — in its
 * scope and in every record keyed by source alias, so a batch in flight keeps
 * its base, credit and snapshot under the alias its scope now names.
 *
 * A run whose state does not parse is left alone: rewriting it would hide the
 * tampering its seal exists to expose, and `aw flow recover` reports it as is.
 * A run holding a batch commit not yet landed is left alone too: its proposal is
 * sealed by digest over the alias, and renaming it would void the approval.
 */
export async function runScopeRewrites(
  fs: FileSystemPort,
  paths: PathsService,
  /** When given, only these sessions — the ones whose lock the caller holds — are rewritten. */
  locked?: ReadonlySet<string>,
): Promise<{ rewrites: RunScopeRewrite[]; conflicts: RunScopeConflict[] }> {
  const rewrites: RunScopeRewrite[] = [];
  const conflicts: RunScopeConflict[] = [];
  for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const path = join(folder.path, ".flow-run.json");
    if ((await fs.exists(join(folder.path, CLOSED_MARKER))) || !(await fs.exists(path))) continue;
    if (locked !== undefined && !locked.has(folder.name)) continue;
    const outcome = runAliasRewrite(await fs.readText(path), folder.name);
    if (outcome.kind === "rewrite")
      rewrites.push({ path, session: folder.name, text: outcome.text });
    if (outcome.kind === "conflict")
      conflicts.push({ path, session: folder.name, detail: outcome.detail });
  }
  return { rewrites, conflicts };
}

export type RunAliasOutcome =
  | { kind: "rewrite"; text: string }
  | { kind: "conflict"; detail: string }
  | { kind: "nothing" };

/** What one run's state needs. Pure: the caller re-runs it under the run's lock. */
export function runAliasRewrite(raw: string, session: string): RunAliasOutcome {
  const read = parseRunState(raw, session);
  if (!read.ok) return { kind: "nothing" };
  // Before source-scope fixes the scope, the entry still carries the plan's aliases.
  const named = [
    ...(read.state.scope?.sources ?? []),
    ...(read.state.plan_exec_entry?.sources ?? []),
  ];
  if (!named.includes(LEGACY_ALIAS)) return { kind: "nothing" };
  if ((read.state.batches ?? []).some(commitInFlight)) {
    return {
      kind: "conflict",
      detail:
        "tiene un commit de lote propuesto que todavía no aterrizó; terminá ese commit y reintentá",
    };
  }
  const { digest: _seal, ...state } = withHubAlias(read.state);
  return { kind: "rewrite", text: serializeRunState(sealRunState(state)) };
}

function commitInFlight(batch: PlanExecBatch): boolean {
  // Every commit may have landed and the batch still not have advanced past it:
  // the retry re-derives the proposal digest, so it is still sealed over the alias.
  if (batch.stage === "batch-committing") return true;
  const proposal = batch.commit_proposal;
  if (proposal === undefined) return false;
  return proposal.sources.some((source) => batch.commit_result?.[source.alias] === undefined);
}

function hubAlias(alias: string): string {
  return alias === LEGACY_ALIAS ? HUB_ALIAS : alias;
}

function hubKeys<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([alias, value]) => [hubAlias(alias), value]),
  );
}

function withHubAlias(state: FlowRunState): FlowRunState {
  const scope = state.scope;
  return {
    ...state,
    ...(scope === null
      ? {}
      : {
          scope: {
            ...scope,
            sources: scope.sources.map(hubAlias),
            ...(scope.final_validation === undefined
              ? {}
              : {
                  final_validation: scope.final_validation.map((entry) => ({
                    ...entry,
                    alias: hubAlias(entry.alias),
                  })),
                }),
          },
        }),
    ...(state.plan_exec_entry?.sources === undefined
      ? {}
      : {
          plan_exec_entry: {
            ...state.plan_exec_entry,
            sources: state.plan_exec_entry.sources.map(hubAlias),
          },
        }),
    ...(state.batches === undefined ? {} : { batches: state.batches.map(batchWithHubAlias) }),
    ...(state.inherited_bases === undefined
      ? {}
      : {
          inherited_bases: state.inherited_bases.map((inherited) => ({
            ...inherited,
            base: hubKeys(inherited.base) ?? {},
          })),
        }),
  };
}

function batchWithHubAlias(batch: PlanExecBatch): PlanExecBatch {
  const keyed = {
    base: hubKeys(batch.base),
    credit: hubKeys(batch.credit),
    snapshot: hubKeys(batch.snapshot),
    commit_result: hubKeys(batch.commit_result),
  };
  return {
    ...batch,
    ...Object.fromEntries(Object.entries(keyed).filter(([, value]) => value !== undefined)),
    ...(batch.commit_proposal === undefined
      ? {}
      : {
          commit_proposal: {
            ...batch.commit_proposal,
            sources: batch.commit_proposal.sources.map((source) => ({
              ...source,
              alias: hubAlias(source.alias),
            })),
          },
        }),
  };
}

/** `file:line` of each rewritten declaration, relative to the hub, for the preview. */
export function aliasLocations(hub: string, rewrites: readonly PlanAliasRewrite[]): string[] {
  return rewrites.flatMap((rewrite) =>
    rewrite.lines.map((line) => `${relative(hub, rewrite.path)}:${line.line}`),
  );
}
