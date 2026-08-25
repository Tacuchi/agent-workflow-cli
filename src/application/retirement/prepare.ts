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
import { reservationOwnerOf } from "../../domain/reservation.js";
import {
  type ClosureEntry,
  type ReadSetEntry,
  type RetirementCustodyScope,
  type RetirementDelete,
  type RetirementEvent,
  type RetirementMode,
  type RetirementProposal,
  type RetirementPublication,
  type RetirementReservation,
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
import { claimOfDocsPath } from "../claims-ledger.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { readBindingRegistry } from "../session-binding-service.js";
import type { IndexedReservation } from "../workline-index-service.js";
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
  const canon = await resolveCoreDocsCanon(deps.fs, deps.paths);
  if (!canon.ok) {
    return {
      ok: false,
      rejection: {
        code: "DOCS_CANON_INVALID",
        message: canon.error,
        candidates: [],
        action: "corregí [docs] para conservar el layout canónico antes de preparar un retiro",
      },
    };
  }
  const parsed = parseTargetSelector(input.target, canon.canon);
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

  const { graph, index } = await buildRetirementGraph(deps, canon.canon);
  // A partial slot scan cannot seal a scope. The proposal would enumerate only
  // the reservations the walk managed to see, and the preview would present that
  // truncated list as the whole of what this retirement gives back — the exact
  // conflation of "unreadable" with "there were none" that every other reader of
  // `docs/` in this codebase refuses to make.
  if (index.reservations_error !== undefined) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        message: `no se puede determinar qué correlativos sostiene este alcance: ${index.reservations_error}`,
        candidates: [],
        action: "arreglá el archivo de docs/ que no se puede leer y volvé a preparar el retiro",
      },
    };
  }
  const found = resolveTarget(graph, parsed.selector);
  if (!found.ok) return { ok: false, rejection: found.rejection };

  const closure =
    input.mode === "discard"
      ? resolveDiscardClosure(graph, found.node)
      : await resetClosure(graph, found.node);
  if (!closure.ok) return { ok: false, rejection: closure.rejection };

  return buildProposal(deps, closure.closure, selectorText(parsed.selector), index.reservations);
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
  slots: readonly IndexedReservation[],
): Promise<PrepareOutcome> {
  const readSet: ReadSetEntry[] = [];
  const deletes: RetirementDelete[] = [];
  const restores: RetirementRestore[] = [];
  const custody: RetirementCustodyScope[] = [];
  const units: RetirementUnit[] = [];
  const reservations: RetirementReservation[] = [];
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
        reservations,
        slots,
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
      reservations,
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
  reservations: RetirementReservation[];
  /** Every held correlative in the workspace, as the index projects them. */
  slots: readonly IndexedReservation[];
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

  collectReservations(collector, facts.folder);

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

  collectRestoredMarkers(collector, facts.folder, restoresBefore);

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

/**
 * The correlatives this session is still holding.
 *
 * Collected BEFORE the custody check, on purpose: a reservation is not a
 * custody artifact — nothing records it there — so a legacy session with no
 * readable custody holds its numbers exactly like any other, and returning early
 * would strand precisely the sessions least able to account for themselves.
 *
 * Owner-scoped by the marker the index already read, which is what keeps a
 * retirement from ever naming somebody else's slot: the whole list is filtered by
 * this folder, and a slot whose owner is another session simply is not in it.
 */
function collectReservations(collector: SessionCollector, folder: string): void {
  for (const slot of collector.slots) {
    if (slot.owner !== folder) continue;
    const claim = claimOfDocsPath(slot.file, slot.owner);
    // Not a `docs/<category>/<NNN>-<name>` path: nothing here can name it as a
    // claim, so nothing here may release it either.
    if (claim === null) continue;
    collector.reservations.push({ path: slot.file, claim, intact: slot.intact });
  }
}

/**
 * The slots a `reset` is about to RE-CREATE by restoring its own marker.
 *
 * A session that completed its own reservation has that destination sealed in
 * custody as an `input` whose baseline is the marker — because the bytes that
 * were there before the publication ARE the marker. So restoring it writes the
 * reservation back, and the session that owned it is removed in the same
 * operation.
 *
 * Reproduced before this existed, and the result was worse than the stranded
 * number this whole change is about: the ledger has already recorded that claim
 * as `published`, which is terminal, so `slotOf` refuses to read the path as a
 * slot at all. The board therefore counted a file whose entire content is
 * `<!-- aw:reserva … -->` as a published spec, and no surface could resolve it —
 * not `aw claims recover`, which only sees slots, and not the retirement, which
 * had already finished.
 *
 * Enumerated here rather than discovered while applying, so it travels in the
 * sealed list and is visible in the preview like every other correlative that
 * comes back. `intact` is true by construction: the bytes about to be written
 * are the marker, and `apply` re-reads them anyway before removing anything.
 */
function collectRestoredMarkers(collector: SessionCollector, folder: string, from: number): void {
  for (const restore of collector.restores.slice(from)) {
    if (!restore.existed || restore.content === null) continue;
    // Only its OWN marker. Another session's reservation is not this
    // retirement's to give back, in this path exactly as in every other.
    if (reservationOwnerOf(restore.content) !== folder) continue;
    const claim = claimOfDocsPath(restore.path, folder);
    if (claim === null) continue;
    if (collector.reservations.some((held) => held.path === restore.path)) continue;
    collector.reservations.push({ path: restore.path, claim, intact: true });
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
