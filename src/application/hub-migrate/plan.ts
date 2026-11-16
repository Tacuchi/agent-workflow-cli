/**
 * What a hub with a legacy session series needs before it can be operated with
 * the same commands as a new one — derived without writing a byte.
 *
 * Three things are broken in such a hub, and none of them announces itself:
 * the hub block wears markers of an older namespace and the CLI silently
 * reads a second, empty one it appended itself; the sessions the record calls
 * closed have no `.closed` sentinel on disk, so they show up as active forever;
 * and the numbers of the legacy series live only in folder names, so they
 * vanish from the record the day somebody archives the folders.
 *
 * This is a PUNCTUAL, explicit operation and not a reconciliation some other
 * command performs on the side: it decides what to do by comparing two sources
 * that may disagree, and a disagreement is answered by refusing to touch that
 * session — never by picking the more convenient of the two.
 */

import { join } from "node:path";
import { normalizeCorrelative } from "../../domain/correlative.js";
import type { SessionState } from "../../domain/types.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type HistoryRow, readHistoryRows } from "../history-table.js";
import { readHubLocalConfig } from "../hub-local-config.js";
import type { HubBlockMarkers } from "../parsers/hub-block.js";
import { BLOCK_FILE, LEGACY_BLOCK_FILE } from "../parsers/hub-block.js";
import type { PathsService } from "../paths-service.js";
import { resolveHubRootFrom } from "../paths-service.js";
import {
  CLOSED_MARKER,
  buildSessionEntry,
  listSessionFolders,
  nextSessionCorrelative,
  parseSessionFolder,
  sessionNumericCode,
  sessionsSharingNumber,
} from "../session-resolver.js";
import {
  type PlanAliasRewrite,
  type RunScopeRewrite,
  planAliasRewrites,
  runScopeRewrites,
} from "./aliases.js";
import {
  type BlockFileDivergence,
  type BlockFileMigration,
  type BlockFileOutcome,
  KEEP_CHOICE_TEXT,
  type KeepChoice,
  planBlockFile,
} from "./block-file.js";
import {
  type HubMarkerRefusal,
  type HubMarkerRewrite,
  planHubMarkers,
  readHubFiles,
} from "./markers.js";

/** A session the record calls closed, whose folder never got the sentinel. */
export interface SentinelSeed {
  folder: string;
  /** Absolute path of the session folder the sentinel lands in. */
  path: string;
  /** The day the RECORD says it closed. Never the folder's mtime. */
  date: string;
}

/** A legacy session whose number exists only as a folder name. */
export interface RowSeed {
  folder: string;
  code: string;
  name: string;
  state: SessionState;
  /** The declared date, or `—` when the legacy session never declared one. */
  date: string;
}

export type ConflictReason =
  | "numero_compartido"
  | "estado_divergente"
  | "estado_ilegible"
  | "commit_de_lote_pendiente"
  | "bloques_divergentes"
  | "bloque_duplicado"
  | "claude_md_enlazado"
  | HubMarkerRefusal["reason"];

/** Something the migration deliberately left exactly as it found it. */
export interface MigrationConflict {
  /** The session folder or the hub file that stays untouched. */
  subject: string;
  reason: ConflictReason;
  detail: string;
}

export interface HubMigrationPlan {
  hub: string;
  markers: HubMarkerRewrite[];
  /** Open plans whose source declarations still name the pre-29 alias. */
  aliases: PlanAliasRewrite[];
  /** Open runs whose scope still names the pre-29 alias. */
  runs: RunScopeRewrite[];
  sentinels: SentinelSeed[];
  rows: RowSeed[];
  /** The legacy CLAUDE.md mirror of the block, retired or stripped into AGENTS.md. */
  block_file: BlockFileMigration | null;
  /** Both mirrors declare different blocks: nothing is written until `--keep` names one. */
  block_divergence: BlockFileDivergence | null;
  conflicts: MigrationConflict[];
  /** Every legacy folder the hub holds, whether or not it needs anything. */
  legacy: string[];
  /** The number the next session will take, from the ONE derivation F3 left. */
  next_correlative: string;
}

export interface RenumberMove {
  from: string;
  to: string;
  reason: "legacy" | "registro-remoto" | "carpetas";
}

/** How many writes the plan holds. Zero means the hub is already current. */
export function pendingChanges(plan: HubMigrationPlan): number {
  return (
    plan.markers.length +
    plan.aliases.length +
    plan.runs.length +
    plan.sentinels.length +
    plan.rows.length +
    (plan.block_file === null ? 0 : 1) +
    // Not a write until `--keep` names a side, but a hub with two blocks is not current either.
    (plan.block_divergence === null ? 0 : 1)
  );
}

export async function planHubMigration(
  fs: FileSystemPort,
  paths: PathsService,
  /** The sessions whose run lock `--apply` holds; only those runs are rewritten. */
  lockedRuns?: ReadonlySet<string>,
  /** The person's choice for a divergent CLAUDE.md / AGENTS.md pair. */
  keep?: KeepChoice,
): Promise<HubMigrationPlan> {
  const hub = await resolveHubRootFrom(fs, paths);
  const local = await readHubLocalConfig(fs, join(hub, `.${paths.namespace}`, "local.json"));
  const files = await readHubFiles(fs, hub);
  const markers = planMarkers(files, paths.blockMarkers(), local.config?.sources ?? {});
  const blockFile = await planLegacyMirror(fs, paths, hub, files, markers, keep);
  const recorded = await readRecord(fs, paths);

  const sentinels: SentinelSeed[] = [];
  const rows: RowSeed[] = [];
  const conflicts: MigrationConflict[] = [...markers.conflicts];
  conflicts.push(...blockFileConflicts(hub, blockFile));
  const legacy: string[] = [];

  for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const number = legacyNumber(folder.name);
    if (number === null) continue; // current-model folder: nothing legacy about it
    legacy.push(folder.name);
    const outcome = await planSession(
      fs,
      paths,
      folder,
      number,
      recorded.get(normalizeCorrelative(number) ?? number),
    );
    if (outcome.kind === "sentinel") sentinels.push(outcome.seed);
    if (outcome.kind === "row") rows.push(outcome.seed);
    if (outcome.kind === "conflict") conflicts.push(outcome.conflict);
  }

  const aliases = await planAliasRewrites(fs, paths, hub);
  const runs = await runScopeRewrites(fs, paths, lockedRuns, aliases);
  for (const conflict of runs.conflicts) {
    conflicts.push({
      subject: conflict.path,
      reason: "commit_de_lote_pendiente",
      detail: `${conflict.session} ${conflict.detail}`,
    });
  }

  return {
    hub,
    markers: markers.rewrites,
    aliases,
    runs: runs.rewrites,
    sentinels,
    rows,
    block_file: blockFile.kind === "migrate" ? blockFile.migration : null,
    block_divergence: blockFile.kind === "divergent" ? blockFile.divergence : null,
    conflicts,
    legacy,
    next_correlative: await nextSessionCorrelative(fs, paths),
  };
}

/** The mirror as the marker rename leaves it, so both steps of the migration agree on the bytes. */
async function planLegacyMirror(
  fs: FileSystemPort,
  paths: PathsService,
  hub: string,
  files: readonly { path: string; text: string }[],
  markers: { rewrites: HubMarkerRewrite[]; conflicts: MigrationConflict[] },
  keep: KeepChoice | undefined,
): Promise<BlockFileOutcome> {
  // A file the marker rename refused to touch is not touched by the mirror step either.
  const refused = new Set(markers.conflicts.map((conflict) => conflict.subject));
  if ([BLOCK_FILE, LEGACY_BLOCK_FILE].some((name) => refused.has(join(hub, name))))
    return { kind: "nothing" };
  const rewrites = markers.rewrites;
  const textOf = (name: string): string | null => {
    const path = join(hub, name);
    return (
      rewrites.find((rewrite) => rewrite.path === path)?.text ??
      files.find((file) => file.path === path)?.text ??
      null
    );
  };
  const agents = textOf(BLOCK_FILE);
  const claude = textOf(LEGACY_BLOCK_FILE);
  const link = await fs.lstat(join(hub, LEGACY_BLOCK_FILE));
  if (link?.isSymlink === true && claude?.includes(paths.blockMarkers().start) === true) {
    // A CLAUDE.md linked to AGENTS.md already reads it once; any other link is not ours to replace.
    if (claude === agents) return { kind: "nothing" };
    return {
      kind: "refused",
      path: join(hub, LEGACY_BLOCK_FILE),
      reason: "claude_md_enlazado",
      detail:
        "CLAUDE.md es un enlace simbólico a otro archivo: reemplazalo a mano por un CLAUDE.md con @AGENTS.md",
    };
  }
  const history = `.${paths.namespace}/HISTORY.md`;
  return planBlockFile(
    hub,
    { agents, claude },
    {
      markers: paths.blockMarkers(),
      ...((await fs.exists(join(hub, history))) ? { historicoPath: history } : {}),
    },
    keep,
  );
}

function blockFileConflicts(hub: string, outcome: BlockFileOutcome): MigrationConflict[] {
  if (outcome.kind === "divergent") return [divergenceConflict(hub, outcome.divergence)];
  if (outcome.kind === "refused")
    return [{ subject: outcome.path, reason: outcome.reason, detail: outcome.detail }];
  return [];
}

function divergenceConflict(hub: string, divergence: BlockFileDivergence): MigrationConflict {
  const side = (lines: string[]) => (lines.length === 0 ? "(nada)" : lines.join(" · "));
  const what = {
    order: "CLAUDE.md y AGENTS.md declaran las mismas líneas en otro orden.",
    "blank-lines": "CLAUDE.md y AGENTS.md difieren solo en líneas en blanco.",
    lines: `CLAUDE.md y AGENTS.md declaran bloques distintos. Solo en CLAUDE.md: ${side(divergence.only_claude)}. Solo en AGENTS.md: ${side(divergence.only_agents)}.`,
  }[divergence.difference];
  return {
    subject: join(hub, LEGACY_BLOCK_FILE),
    reason: "bloques_divergentes",
    detail: `${what} Elegí el que vale con ${KEEP_CHOICE_TEXT}`,
  };
}

function planMarkers(
  hubs: readonly { path: string; text: string }[],
  current: HubBlockMarkers,
  localSources: Readonly<Record<string, string>>,
): { rewrites: HubMarkerRewrite[]; conflicts: MigrationConflict[] } {
  const rewrites: HubMarkerRewrite[] = [];
  const conflicts: MigrationConflict[] = [];
  for (const hub of hubs) {
    const outcome = planHubMarkers(hub.path, hub.text, current, localSources);
    if (outcome.kind === "rewrite") rewrites.push(outcome.rewrite);
    if (outcome.kind === "refused") {
      conflicts.push({
        subject: hub.path,
        reason: outcome.refusal.reason,
        detail: outcome.refusal.detail,
      });
    }
  }
  return { rewrites, conflicts };
}

type SessionOutcome =
  | { kind: "sentinel"; seed: SentinelSeed }
  | { kind: "row"; seed: RowSeed }
  | { kind: "conflict"; conflict: MigrationConflict }
  | { kind: "coherente" };

/**
 * What one legacy session needs, given what the record says about its number.
 *
 * The rule that makes seeding a sentinel safe is the LAYOUT: a `sessionNNN-`
 * folder predates the sentinel model entirely, so the file's absence there is
 * the absence of the model and not a statement about the session. In a
 * current-model folder that same absence MEANS active — `session-load
 * --reopen` produces exactly it, on purpose — and writing the sentinel back
 * would re-close a session somebody had just reopened. That is why this walks
 * the legacy series and nothing else.
 */
async function planSession(
  fs: FileSystemPort,
  paths: PathsService,
  folder: { name: string; path: string },
  number: string,
  row: HistoryRow | undefined,
): Promise<SessionOutcome> {
  // The record is indexed by number, so a number two folders answer to has ONE
  // row for TWO sessions: whichever we wrote, we would be writing about the
  // other one too.
  const sharing = await sessionsSharingNumber(fs, paths, folder.name);
  if (sharing.length > 1) {
    const folders = sharing.map((candidate) => candidate.folder).join(", ");
    return conflictOf(
      folder.name,
      "numero_compartido",
      `el número ${number} lo comparten ${sharing.length} carpetas (${folders}) y el registro se indexa por número: renombrá la legacy al modelo actual (\`NNN-<slug>\`) y reintentá`,
    );
  }

  const entry = await buildSessionEntry(fs, folder.path, folder.name);
  if (row === undefined) {
    return {
      kind: "row",
      seed: {
        folder: folder.name,
        code: entry.code ?? folder.name,
        name: entry.name,
        state: entry.state,
        // A migration cannot infer when an older session happened. Persist an
        // explicit unknown instead of making the migration date look historic.
        date: entry.date ?? "—",
      },
    };
  }

  const recorded = recordedState(row.state);
  if (recorded === null) {
    return conflictOf(
      folder.name,
      "estado_ilegible",
      `la fila del histórico dice '${row.state}', que no es ni 'active' ni 'closed': corregila a mano y reintentá`,
    );
  }
  if (recorded === entry.state) return { kind: "coherente" };
  if (recorded === "active") {
    return conflictOf(
      folder.name,
      "estado_divergente",
      "el histórico la da por activa y la carpeta ya tiene su centinela `.closed`: cuál de las dos quedó atrás no se adivina",
    );
  }
  return {
    kind: "sentinel",
    seed: { folder: folder.name, path: folder.path, date: row.date },
  };
}

function conflictOf(subject: string, reason: ConflictReason, detail: string): SessionOutcome {
  return { kind: "conflict", conflict: { subject, reason, detail } };
}

/** Where the sentinel of a session goes. */
export function sentinelPath(seed: SentinelSeed): string {
  return join(seed.path, CLOSED_MARKER);
}

/**
 * The record, indexed by NUMBER — the key it is actually written with.
 *
 * Compared as numbers and not as strings for the same reason the upsert does
 * it: `47` and `047` are one session, and `100` is not `1000`.
 */
async function readRecord(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<Map<string, HistoryRow>> {
  const path = paths.cwdHistoryFile();
  const byNumber = new Map<string, HistoryRow>();
  if (!(await fs.exists(path))) return byNumber;
  for (const row of readHistoryRows(await fs.readText(path))) {
    // The SAME reading of "what number does this carry" the resolver and the
    // correlative use: `session047-x`, `047-x` and a bare `047` are one session.
    const digits = sessionNumericCode(row.key);
    const number = digits === null ? null : normalizeCorrelative(digits);
    if (number !== null) byNumber.set(number, row);
  }
  return byNumber;
}

/**
 * The number a LEGACY folder carries, or `null` when the folder is not one.
 *
 * `parseSessionFolder` is the canonical reading of a folder's identity and it
 * answers this without another regex: for the current model it hands back the
 * WHOLE folder name as the code, and only the `sessionNNN-<slug>` layout splits
 * a number off.
 */
function legacyNumber(folder: string): string | null {
  const { code } = parseSessionFolder(folder);
  if (code === null || code === folder) return null;
  return normalizeCorrelative(code);
}

function recordedState(cell: string): SessionState | null {
  const value = cell.trim().toLowerCase();
  if (value === "closed") return "closed";
  if (value === "active") return "active";
  return null;
}
