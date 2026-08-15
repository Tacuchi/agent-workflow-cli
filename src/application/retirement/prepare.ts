/**
 * `prepare`: everything a retirement would do, sealed, having changed nothing.
 *
 * It writes no session, no journal, no file and no ref. That is not an
 * optimization — it is what makes the preview safe to run on the wrong target,
 * which is exactly what somebody about to delete work needs to be able to do.
 *
 * The whole answer comes out of ONE object. The preview a person reads, the digest
 * they approve and the effects `apply` performs are three views of the same record,
 * so "what I was shown" and "what will happen" cannot drift apart into two
 * descriptions that disagree.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClosureEntry,
  type ReadSetEntry,
  type RetirementCustodyScope,
  type RetirementDelete,
  type RetirementEvent,
  type RetirementMode,
  type RetirementProposal,
  type RetirementPublication,
  type RetirementRestore,
  type RetirementUnit,
  sealRetirementProposal,
} from "../../domain/retirement/proposal.js";
import { parseTargetSelector, selectorText } from "../../domain/retirement/selector.js";
import { baselineDigest } from "../../domain/session/custody.js";
import { formatNodeId } from "../../domain/workline-node.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { readBindingRegistry } from "../session-binding-service.js";
import { type AttributionBlock, attributeGitEffects } from "./attribution.js";
import { type GraphNode, type RetirementGraph, buildRetirementGraph } from "./graph.js";
import {
  type ResolvedClosure,
  type RetirementRejection,
  resolveDiscardClosure,
  resolveResetClosure,
  resolveResetSession,
  resolveTarget,
} from "./resolve.js";

export interface PrepareDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  paths: PathsService;
}

export interface PrepareInput {
  mode: RetirementMode;
  target: string;
}

export type PrepareOutcome =
  | { ok: true; proposal: RetirementProposal }
  | { ok: false; rejection: RetirementRejection; blocks?: AttributionBlock[] };

export async function prepareRetirement(
  deps: PrepareDeps,
  input: PrepareInput,
): Promise<PrepareOutcome> {
  const parsed = parseTargetSelector(input.target);
  if (!parsed.ok) {
    return {
      ok: false,
      rejection: {
        code: "TARGET_NOT_FOUND",
        message: parsed.problem.message,
        candidates: [],
        action: parsed.problem.action,
      },
    };
  }

  const { graph } = await buildRetirementGraph(deps);
  const found = resolveTarget(graph, parsed.selector);
  if (!found.ok) return { ok: false, rejection: found.rejection };

  const closure =
    input.mode === "discard"
      ? resolveDiscardClosure(graph, found.node)
      : await resetClosure(graph, found.node);
  if (!closure.ok) return { ok: false, rejection: closure.rejection };

  return buildProposal(deps, closure.closure, selectorText(parsed.selector));
}

function resetClosure(
  graph: RetirementGraph,
  target: GraphNode,
): ReturnType<typeof resolveResetClosure> | Promise<ReturnType<typeof resolveResetClosure>> {
  const session = resolveResetSession(graph, target);
  if (!session.ok) return { ok: false, rejection: session.rejection };
  return resolveResetClosure(graph, session.node);
}

async function buildProposal(
  deps: PrepareDeps,
  closure: ResolvedClosure,
  targetText: string,
): Promise<PrepareOutcome> {
  const readSet: ReadSetEntry[] = [];
  const deletes: RetirementDelete[] = [];
  const restores: RetirementRestore[] = [];
  const custody: RetirementCustodyScope[] = [];
  const units: RetirementUnit[] = [];
  const blocks: AttributionBlock[] = [];
  const dirty: RetirementProposal["dirty"] = [];
  const reverts: RetirementProposal["reverts"] = [];
  const publications: RetirementPublication[] = [];

  const restored = new Set<string>();
  for (const entry of closure.entries) {
    if (entry.node.kind === "session") {
      await collectSession(deps, entry.node, {
        mode: closure.mode,
        deletes,
        restores,
        restored,
        custody,
        units,
        dirty,
        reverts,
        publications,
        blocks,
        readSet,
      });
      continue;
    }
    // A document in the closure disappears whole. Its digest travels so `apply`
    // can tell "the file I was shown" from "a file somebody edited since" — read
    // ONCE, because two readings of the same file could disagree and then the
    // delete and the compare-and-swap would be checking different things.
    const digest = await digestOf(deps.fs, entry.node.absolute_path);
    deletes.push({ path: entry.node.path, kind: "file", digest });
    readSet.push({ id: `doc:${entry.node.path}`, digest: digest ?? "absent" });
  }

  if (blocks.length > 0) {
    return {
      ok: false,
      rejection: {
        code: "SHARED_CONSUMER",
        message: blocks.map((b) => b.reason).join("; "),
        candidates: blocks.flatMap((b) => b.contested),
        action: blocks[0]?.action ?? "resolvé la atribución compartida y reintentá",
      },
      blocks,
    };
  }

  // A restore and a delete over the same path would be two instructions for one
  // file. The restore wins: it is the one that knows what should be there.
  const finalDeletes = deletes.filter((d) => !restored.has(d.path));

  const bindings = await bindingsOf(deps, closure, readSet);
  return {
    ok: true,
    proposal: sealRetirementProposal({
      mode: closure.mode,
      target: closure.target.id,
      closure: closure.entries.map(
        (e): ClosureEntry => ({ node: e.node.id, path: e.node.path, reason: e.reason }),
      ),
      deletes: finalDeletes,
      restores,
      custody,
      bindings,
      units,
      dirty,
      reverts,
      // More than one would mean two commit points; the attribution refuses that
      // shape upstream, so reaching here with two is impossible by construction.
      publication: publications[0] ?? null,
      event: eventOf(closure, targetText, finalDeletes, restores),
      read_set: readSet,
    }),
  };
}

interface SessionCollector {
  mode: RetirementMode;
  deletes: RetirementDelete[];
  restores: RetirementRestore[];
  restored: Set<string>;
  custody: RetirementCustodyScope[];
  units: RetirementUnit[];
  dirty: RetirementProposal["dirty"];
  reverts: RetirementProposal["reverts"];
  publications: RetirementPublication[];
  blocks: AttributionBlock[];
  readSet: ReadSetEntry[];
}

/**
 * What one session in the closure contributes.
 *
 * The mode decides only ONE thing here — whether the session's declared inputs go
 * back to their previous bytes — and everything else is identical. A discard that
 * restored inputs would undo work the user asked to keep; a reset that did not
 * would leave the document half-executed. Both modes remove the session folder,
 * its units and its attributable git effects, because those are the session's own
 * either way.
 */
async function collectSession(
  deps: PrepareDeps,
  node: GraphNode,
  collector: SessionCollector,
): Promise<void> {
  const facts = node.session;
  if (facts === null) return;
  collector.deletes.push({ path: node.path, kind: "directory", digest: null });

  const custody = facts.custody;
  for (const unit of facts.units) {
    collector.units.push({
      alias: unit.alias,
      session: facts.folder,
      path: unit.path,
      branch: unit.branch,
      // From the custody's own record of that source; empty when a legacy session
      // has a unit but no custody, and then the unit is reported rather than touched.
      repo: custody?.sources.find((s) => s.alias === unit.alias)?.path ?? "",
    });
  }

  if (custody === null) return;
  collector.readSet.push({ id: `custody:${facts.folder}`, digest: custody.digest });

  // Counted before the loop that consumes it, so what the proposal declares is
  // the custody's own number and not a by-product of what this mode happened to
  // act on. `declared: 0` is the state the whole notice exists for.
  const restoresBefore = collector.restores.length;

  for (const artifact of custody.artifacts) {
    if (artifact.role === "output") {
      // Born inside the session: it goes, in both modes.
      const absolute = join(deps.paths.workspaceDir(), artifact.path);
      collector.deletes.push({
        path: artifact.path,
        kind: "file",
        digest: await digestOf(deps.fs, absolute),
      });
      continue;
    }
    if (collector.mode !== "reset") continue;
    const absolute = join(deps.paths.workspaceDir(), artifact.path);
    collector.restores.push({
      path: artifact.path,
      existed: artifact.before.existed,
      content: artifact.before.content,
      digest: artifact.before.digest,
      current_digest: await digestOf(deps.fs, absolute),
    });
    collector.restored.add(artifact.path);
  }

  collector.custody.push({
    session: facts.folder,
    declared: custody.artifacts.length,
    restored: collector.restores.length - restoresBefore,
  });

  const attribution = await attributeGitEffects(deps.git, custody, {
    scratchDir: tmpdir(),
    opId: facts.folder,
  });
  collector.dirty.push(...attribution.dirty);
  collector.reverts.push(...attribution.reverts);
  collector.blocks.push(...attribution.blocks);
  if (attribution.publication !== null) collector.publications.push(attribution.publication);
  for (const source of custody.sources) {
    const tree = source.unit_path ?? source.path;
    collector.readSet.push({
      id: `git:${source.alias}/HEAD`,
      digest: (await headOf(deps.git, tree)) ?? "unborn",
    });
  }
}

/** Conversation associations that stop resolving once the closure is gone. */
async function bindingsOf(
  deps: PrepareDeps,
  closure: ResolvedClosure,
  readSet: ReadSetEntry[],
): Promise<string[]> {
  const read = await readBindingRegistry(deps.fs, deps.paths);
  if (!read.ok) return [];
  readSet.push({ id: "bindings", digest: semanticDigest(read.registry.bindings) });
  const folders = new Set(
    closure.entries
      .filter((e) => e.node.kind === "session")
      .map((e) => e.node.session?.folder ?? e.node.id.key),
  );
  return Object.entries(read.registry.bindings)
    .filter(([, folder]) => folders.has(folder))
    .map(([contextHash]) => contextHash)
    .sort();
}

function eventOf(
  closure: ResolvedClosure,
  targetText: string,
  deletes: readonly RetirementDelete[],
  restores: readonly RetirementRestore[],
): RetirementEvent {
  const target = formatNodeId(closure.target.id);
  // The row is the only durable trace, so a reset that put nothing back says so
  // in it. "restaurado 0 artefacto(s)" reads as a count somebody may skim past;
  // naming the absence is what keeps HISTORY from implying a rollback that the
  // operation never performed.
  const summary =
    closure.mode === "discard"
      ? `retirado ${targetText}: ${closure.entries.length} nodos, ${deletes.length} rutas`
      : restores.length === 0
        ? `retirada ${target} sin restaurar ningún artefacto`
        : `restaurado ${restores.length} artefacto(s) y retirada ${target}`;
  return { command: closure.mode, key: target, summary };
}

/** `null` when the path is not there — an absence is a fact, not a failure. */
async function digestOf(fs: FileSystemPort, absolute: string): Promise<string | null> {
  if (!(await fs.exists(absolute))) return null;
  try {
    return baselineDigest(await fs.readText(absolute));
  } catch {
    return null;
  }
}

async function headOf(git: GitPort, tree: string): Promise<string | null> {
  try {
    return await git.head(tree);
  } catch {
    return null;
  }
}
