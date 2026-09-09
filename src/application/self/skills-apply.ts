// Applying an approved proposal (Spec 043 · AC-10, AC-12), and surviving a
// failure halfway through.
//
// The five rules this file exists to keep:
//   1. ONE writer at a time — the lock sits next to the shared registry, not
//      in a workspace: two projects install into the same HOME.
//   2. Nothing is removed before its replacement is staged. Every payload and
//      every replica is ready first; only then does the first swap happen.
//   3. Every destination keeps a BACKUP until the whole set is verified, and
//      the backups live outside every host discovery root — a `.hidden` name
//      inside one is still a skill the host would load.
//   4. A journal records the operation, its approved digest and the state of
//      each destination. An exception compensates in reverse order; an
//      interruption leaves the journal for the next run to find. A pending
//      journal is never applied over blindly.
//   5. `applied` and `verified` are different words. Verification checks the
//      bytes this manager wrote — never that a host reloaded anything.

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import { acquireLock } from "../lock-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { copyDir } from "./install-plugin-skills.js";
import type {
  SkillChangeOperation,
  SkillChangeProposal,
  SkillDestination,
} from "./skills-change.js";
import {
  REPLICA_MARKER_FILENAME,
  canonicalSkillsRoot,
  claudeReplicaRoot,
  geminiReplicaRoot,
  inspectSkillOwnership,
} from "./skills-manager.js";
import {
  type SkillRegistryEntry,
  type SkillReplicaMode,
  type SkillsRegistry,
  readSkillsRegistry,
  skillsRegistryPath,
} from "./skills-registry.js";

/** Sibling of the registry, OUTSIDE `<host>/skills`: what a host scans is the
 *  skills root, so staging and backups live one level up from it. */
const WORK_DIRNAME = ".workline-skills";
const JOURNAL_FILE = "journal.json";
const MANIFEST = "SKILL.md";
const LOCK_FILE = ".skills-registry.lock";
/** A second writer waits this long before reporting the holder. */
const LOCK_WAIT_MS = 10_000;

export type DestinationStatus = "applied" | "pending" | "failed" | "unchanged" | "restored";

export interface JournalDestination {
  location: string;
  host: SkillDestination["host"];
  action: SkillDestination["action"];
  status: DestinationStatus;
  /** Where the previous bytes were moved, when there were any. */
  backup: string | null;
  detail?: string;
}

export interface SkillJournal {
  id: string;
  operation: SkillChangeOperation;
  /** The digest the person approved — a retry with other bytes is not this. */
  approvedDigest: string;
  owner: { pid: number; ts: string };
  destinations: JournalDestination[];
  /** The registry as it was before the first write, for the rollback. */
  registryBefore: SkillsRegistry;
  registryWritten: boolean;
}

export interface DestinationResult {
  location: string;
  host: SkillDestination["host"];
  status: DestinationStatus;
  /** What was CHECKED, separately from what was applied. `null` = not checked. */
  verification: { checked: string; passed: boolean } | null;
  detail?: string;
}

export interface ApplyResult {
  operation: SkillChangeOperation;
  digest: string;
  destinations: DestinationResult[];
  /** Present when something failed: what was restored and what is still owed. */
  recovery: { restored: string[]; pending: string[]; action: string } | null;
  /** Backups that could not be removed. Verified bytes stay verified. */
  cleanup: { pending: string[] } | null;
  summary: string;
}

export interface ApplyRefusal {
  code: string;
  message: string;
  action?: string;
}

export type ApplyOutcome =
  | { status: "applied"; result: ApplyResult }
  | { status: "refused"; refusal: ApplyRefusal };

export function skillsWorkRoot(home: string): string {
  return join(home, ".agents", WORK_DIRNAME);
}

export function skillsJournalPath(home: string): string {
  return join(skillsWorkRoot(home), JOURNAL_FILE);
}

/** Staging and backups for one destination root, on ITS filesystem and
 *  outside its discovery root. */
function workRootFor(destinationRoot: string, id: string): string {
  return join(dirname(destinationRoot), WORK_DIRNAME, id);
}

/** The pending operation a previous run left behind, if any. */
export async function readSkillJournal(ctx: CliContext): Promise<SkillJournal | null> {
  const path = skillsJournalPath(ctx.env.homeDir());
  if (!(await ctx.fs.exists(path))) return null;
  try {
    const parsed = JSON.parse(await ctx.fs.readText(path)) as SkillJournal;
    return typeof parsed?.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJournal(ctx: CliContext, journal: SkillJournal): Promise<void> {
  const path = skillsJournalPath(ctx.env.homeDir());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

/** Registry write that cannot be seen half-done, preserving every entry the
 *  operation does not touch. */
async function writeRegistryAtomically(home: string, registry: SkillsRegistry): Promise<void> {
  const path = skillsRegistryPath(home);
  const temp = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/** Digest of a skill's manifest — the cheap check that bytes arrived. */
async function manifestDigest(dir: string): Promise<string | null> {
  const content = await readFile(join(dir, MANIFEST), "utf8").catch(() => null);
  return content === null ? null : semanticDigest(content);
}

interface Preconditions {
  registry: SkillsRegistry;
}

/**
 * What must still be true under the lock.
 *
 * The proposal was sealed outside it, so between the preview and here another
 * writer may have installed, removed or replaced any of these names. Applying
 * over that would honour an approval nobody gave for this state.
 */
async function checkPreconditions(
  ctx: CliContext,
  proposal: SkillChangeProposal,
): Promise<Preconditions | ApplyRefusal> {
  const read = await readSkillsRegistry(ctx);
  if (read.warning) {
    return {
      code: "REGISTRY_UNREADABLE",
      message: `${read.warning} Corregí (o borrá) el archivo antes de aplicar.`,
    };
  }
  for (const [name, before] of Object.entries(proposal.previousRegistry)) {
    const current = read.registry.skills[name] ?? null;
    if (semanticDigest(current) !== semanticDigest(before)) {
      return {
        code: "PROPOSAL_STALE",
        message: `'${name}' cambió en el registro desde la vista previa`,
        action: "volvé a preparar el cambio: la aprobación anterior no cubre este estado",
      };
    }
    // Not "is anything foreign?" — a withdrawal's proposal DECLARED the foreign
    // location it would preserve, and refusing that would refuse the very case
    // the preview described. What must not have changed is the picture the
    // approval was given over.
    const ownership = await inspectSkillOwnership(ctx, name, current ?? undefined);
    const declared = new Map(
      proposal.destinations
        .filter((destination) => basename(destination.location) === name)
        .map((destination) => [destination.location, destination.ownership]),
    );
    const live: [string, string][] = [
      [ownership.canonical.path, ownership.canonical.state],
      ...ownership.replicas.map<[string, string]>((replica) => [replica.path, replica.state]),
    ];
    for (const [location, state] of live) {
      const assumed = declared.get(location);
      if (assumed !== undefined && assumed !== state) {
        return {
          code: "OWNERSHIP_CHANGED",
          message: `${location} pasó de '${assumed}' a '${state}' desde la vista previa`,
          action: "volvé a preparar el cambio: la aprobación no cubre este estado",
        };
      }
    }
  }
  for (const skill of proposal.additions) {
    const staged = await manifestDigest(skill.stagedAt);
    if (staged === null) {
      return {
        code: "PAYLOAD_GONE",
        message: `el payload preparado de '${skill.name}' ya no está disponible`,
        action: "volvé a preparar el cambio: el temporal de la preparación se liberó",
      };
    }
  }
  return { registry: read.registry };
}

interface StagedDestination {
  destination: SkillDestination;
  /** Ready bytes for a create/replace, or `null` for a delete. */
  staged: string | null;
  /** Materialize as a link to the canonical instead of a copy. */
  link: string | null;
  name: string;
}

/**
 * Every payload and every replica, ready BEFORE the first removal.
 *
 * This is the order AC-10 asks for: a replacement that fails while being
 * fetched or copied must leave the previous installation untouched, and the
 * only way to promise that is to have the new bytes complete first.
 */
async function stageDestinations(
  ctx: CliContext,
  proposal: SkillChangeProposal,
  id: string,
): Promise<StagedDestination[]> {
  const home = ctx.env.homeDir();
  const canonicalRoot = canonicalSkillsRoot(home);
  const staged: StagedDestination[] = [];
  const payloads = new Map(proposal.additions.map((skill) => [skill.name, skill]));

  for (const destination of proposal.destinations) {
    const name = basename(destination.location);
    if (destination.host === "registry" || destination.action === "unchanged") {
      staged.push({ destination, staged: null, link: null, name });
      continue;
    }
    if (destination.action === "delete") {
      staged.push({ destination, staged: null, link: null, name });
      continue;
    }
    const payload = payloads.get(name);
    const work = join(workRootFor(dirname(destination.location), id), "staging");
    await mkdir(work, { recursive: true });
    const target = join(work, name);
    if (destination.host === "agents") {
      if (payload === undefined) {
        staged.push({ destination, staged: null, link: null, name });
        continue;
      }
      await copyDir(payload.stagedAt, target);
      staged.push({ destination, staged: target, link: null, name });
      continue;
    }
    // A replica of the claude host prefers a link to the canonical; the gemini
    // one is always a copy (its walker does not follow directory links).
    const canonical = join(canonicalRoot, name);
    if (destination.host === "claude") {
      staged.push({ destination, staged: null, link: canonical, name });
      continue;
    }
    await copyDir(payload === undefined ? canonical : payload.stagedAt, target);
    await writeFile(join(target, REPLICA_MARKER_FILENAME), `${canonical}\n`, "utf8");
    staged.push({ destination, staged: target, link: null, name });
  }
  return staged;
}

/** Moves whatever is at `location` into the backup area, or `null` if empty.
 *  `lstat`, not `exists`: a replica may BE a symlink, and it has to be moved
 *  as the link it is rather than followed. */
async function backup(location: string, id: string): Promise<string | null> {
  if ((await lstat(location).catch(() => null)) === null) return null;
  const dir = join(workRootFor(dirname(location), id), "backup");
  await mkdir(dir, { recursive: true });
  const destination = join(dir, basename(location));
  await rename(location, destination);
  return destination;
}

/** Publishes one staged destination, keeping its previous bytes aside. */
async function publish(entry: StagedDestination, id: string): Promise<JournalDestination> {
  const { destination } = entry;
  const record: JournalDestination = {
    location: destination.location,
    host: destination.host,
    action: destination.action,
    status: "pending",
    backup: null,
  };
  if (destination.action === "unchanged") {
    return {
      ...record,
      status: "unchanged",
      detail: "se conservó: no lo materializó este manager",
    };
  }
  record.backup = await backup(destination.location, id);
  if (destination.action === "delete") {
    return { ...record, status: "applied" };
  }
  await mkdir(dirname(destination.location), { recursive: true });
  if (entry.link !== null) {
    try {
      await symlink(entry.link, destination.location);
      return { ...record, status: "applied", detail: "symlink" };
    } catch {
      // No symlinks (Windows without Developer Mode): a real copy, marked.
      await copyDir(entry.link, destination.location);
      await writeFile(
        join(destination.location, REPLICA_MARKER_FILENAME),
        `${entry.link}\n`,
        "utf8",
      );
      return { ...record, status: "applied", detail: "copy" };
    }
  }
  if (entry.staged === null) {
    return { ...record, status: "failed", detail: "no había bytes preparados para este destino" };
  }
  await rename(entry.staged, destination.location);
  return { ...record, status: "applied" };
}

/** Puts back what a failed run had already moved, newest first. */
async function compensate(
  applied: readonly JournalDestination[],
): Promise<{ restored: string[]; pending: string[] }> {
  const restored: string[] = [];
  const pending: string[] = [];
  for (const record of [...applied].reverse()) {
    if (record.status !== "applied") continue;
    try {
      await rm(record.location, { recursive: true, force: true });
      if (record.backup !== null) await rename(record.backup, record.location);
      restored.push(record.location);
    } catch {
      // A location changed outside the operation, or the restore itself
      // failed: the backup STAYS and the state is declared mixed.
      pending.push(record.location);
    }
  }
  return { restored, pending };
}

/**
 * The independent check, per destination: the bytes this manager wrote are
 * there. Four things are checkable and all four are checked — the link's
 * target, the copied content, the registry entries and the payload's manifest.
 * Nothing here claims a host loaded anything.
 */
async function verify(
  record: JournalDestination,
  home: string,
  expected: Map<string, string>,
  proposed: Record<string, SkillRegistryEntry | null>,
): Promise<DestinationResult["verification"]> {
  if (record.status === "unchanged") return null;
  const name = basename(record.location);
  if (record.host === "registry") {
    const read = await readSkillsRegistryAt(record.location);
    const mismatch = Object.entries(proposed).find(([entry, value]) =>
      value === null ? read.has(entry) : !read.has(entry),
    );
    return {
      checked: `entradas del registro en ${record.location}`,
      passed: read.readable && mismatch === undefined,
    };
  }
  if (record.action === "delete") {
    const gone = (await lstat(record.location).catch(() => null)) === null;
    return { checked: "la ubicación ya no existe", passed: gone };
  }
  const digest = await manifestDigest(
    record.host === "claude" && record.detail === "symlink"
      ? join(canonicalSkillsRoot(home), name)
      : record.location,
  );
  const want = expected.get(name);
  return {
    checked: `SKILL.md de ${record.location}`,
    passed: digest !== null && (want === undefined || digest === want),
  };
}

/** The registry as it stands on disk, for the verification to read back. */
async function readSkillsRegistryAt(
  path: string,
): Promise<{ readable: boolean; has: (name: string) => boolean }> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return { readable: false, has: () => false };
  try {
    const parsed = JSON.parse(raw) as { skills?: Record<string, unknown> };
    const skills = parsed.skills ?? {};
    return { readable: true, has: (name) => Object.hasOwn(skills, name) };
  } catch {
    return { readable: false, has: () => false };
  }
}

/** Removes the backups of a finished, verified operation, then its work dirs. */
async function cleanup(
  records: readonly JournalDestination[],
  home: string,
  id: string,
): Promise<string[]> {
  const pending: string[] = [];
  for (const record of records) {
    if (record.backup === null) continue;
    try {
      await rm(record.backup, { recursive: true, force: true });
    } catch {
      pending.push(record.backup);
    }
  }
  // Best effort: the per-destination removal above is the one that matters, and
  // a leftover empty work dir is declared as pending cleanup, never as failure.
  for (const root of managedWorkRoots(home)) {
    await rm(join(root, id), { recursive: true, force: true }).catch(() =>
      pending.push(join(root, id)),
    );
  }
  return pending;
}

/** The work roots of the three managed hosts — outside every skills root. */
function managedWorkRoots(home: string): string[] {
  return [canonicalSkillsRoot(home), claudeReplicaRoot(home), geminiReplicaRoot(home)].map((root) =>
    join(dirname(root), WORK_DIRNAME),
  );
}

/**
 * The registry the application writes: the approved entries plus the two facts
 * only the application knows — WHEN it materialized and whether the primary
 * replica ended up a link or a copy. Entries the operation does not name are
 * carried over untouched.
 */
function registryAfter(
  before: SkillsRegistry,
  proposal: SkillChangeProposal,
  records: readonly JournalDestination[],
): SkillsRegistry {
  const skills: Record<string, SkillRegistryEntry> = { ...before.skills };
  const installedAt = new Date().toISOString();
  const materialized = new Set(proposal.additions.map((skill) => skill.name));
  for (const [name, entry] of Object.entries(proposal.proposedRegistry)) {
    if (entry === null) {
      delete skills[name];
      continue;
    }
    if (!proposal.installs || !materialized.has(name)) {
      skills[name] = entry;
      continue;
    }
    const claude = records.find(
      (record) => record.host === "claude" && basename(record.location) === name,
    );
    const mode: SkillReplicaMode | null =
      claude?.detail === "symlink" ? "symlink" : claude?.detail === "copy" ? "copy" : null;
    skills[name] = {
      ...entry,
      ...(mode !== null ? { mode } : {}),
      installedAt,
    };
  }
  return { skills };
}

/**
 * Applies exactly the approved proposal, or refuses.
 *
 * The approval is the proposal's own digest: a retry whose set, bytes,
 * destinations or effects differ produces another digest and has to be
 * approved again. That is what makes "only what was approved is applied" a
 * property of the data.
 */
export async function applySkillChange(
  ctx: CliContext,
  proposal: SkillChangeProposal,
  approval: string,
): Promise<ApplyOutcome> {
  if (approval !== proposal.digest) {
    return {
      status: "refused",
      refusal: {
        code: "APPROVAL_MISMATCH",
        message: "la aprobación no corresponde a esta propuesta",
        action: "volvé a preparar el cambio y aprobá la vista previa que devuelve",
      },
    };
  }
  const home = ctx.env.homeDir();
  const lock = await acquireLock(join(home, ".agents", LOCK_FILE), ctx.fs, {
    waitMs: LOCK_WAIT_MS,
  });
  try {
    const pending = await readSkillJournal(ctx);
    if (pending !== null) {
      return {
        status: "refused",
        refusal: {
          code: "JOURNAL_PENDING",
          message: `quedó una operación '${pending.operation}' sin concluir (${pending.id})`,
          action:
            "resolvé esa operación primero: restaurá el estado anterior o preparala de nuevo; aplicar encima repetiría efectos a ciegas",
        },
      };
    }
    const preconditions = await checkPreconditions(ctx, proposal);
    if ("code" in preconditions) return { status: "refused", refusal: preconditions };
    return await run(ctx, proposal, preconditions.registry);
  } finally {
    await lock.release();
  }
}

/**
 * Puts back what this run had already published, and says so.
 *
 * A compensation that succeeds leaves nothing behind — no journal, no mixed
 * state. One that cannot finish KEEPS the backups and names the locations,
 * because a rollback reported as complete over a half-restored tree is the one
 * lie this whole mechanism exists to avoid.
 */
async function rollback(
  ctx: CliContext,
  journal: SkillJournal,
  proposal: SkillChangeProposal,
  before: SkillsRegistry,
  err: unknown,
): Promise<ApplyResult> {
  const home = ctx.env.homeDir();
  const recovery = await compensate(journal.destinations);
  if (journal.registryWritten) {
    await writeRegistryAtomically(home, before).catch(() => recovery.pending.push("registry"));
  }
  journal.destinations = journal.destinations.map((record) => ({
    ...record,
    status: recovery.pending.includes(record.location) ? "failed" : "restored",
  }));
  if (recovery.pending.length === 0) {
    await rm(skillsJournalPath(home), { force: true }).catch(() => {});
  } else {
    await writeJournal(ctx, journal);
  }
  return {
    operation: proposal.operation,
    digest: proposal.digest,
    destinations: journal.destinations.map((record) => ({
      location: record.location,
      host: record.host,
      status: record.status,
      verification: null,
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    })),
    recovery: {
      restored: recovery.restored,
      pending: recovery.pending,
      action:
        recovery.pending.length === 0
          ? "se restauró el estado anterior; nada quedó a medias"
          : `estado mixto: los respaldos de ${recovery.pending.join(", ")} se conservan. Resolvé cada ubicación y volvé a preparar el cambio`,
    },
    cleanup: null,
    summary: `Falló '${proposal.operation}': ${(err as Error).message}`,
  };
}

async function run(
  ctx: CliContext,
  proposal: SkillChangeProposal,
  before: SkillsRegistry,
): Promise<ApplyOutcome> {
  const home = ctx.env.homeDir();
  const id = randomUUID();
  const journal: SkillJournal = {
    id,
    operation: proposal.operation,
    approvedDigest: proposal.digest,
    owner: { pid: process.pid, ts: new Date().toISOString() },
    destinations: [],
    registryBefore: before,
    registryWritten: false,
  };
  const expected = new Map(
    await Promise.all(
      proposal.additions.map(
        async (skill) => [skill.name, (await manifestDigest(skill.stagedAt)) ?? ""] as const,
      ),
    ),
  );

  let stagedSet: StagedDestination[];
  try {
    stagedSet = await stageDestinations(ctx, proposal, id);
  } catch (err) {
    // Nothing was removed yet: the previous installation is intact. Every
    // host's staging goes, not just the anchor's — each one lives next to its
    // own root and would otherwise be left behind in the user's home.
    for (const root of managedWorkRoots(home)) {
      await rm(join(root, id), { recursive: true, force: true }).catch(() => {});
    }
    return {
      status: "refused",
      refusal: {
        code: "STAGING_FAILED",
        message: `no se pudo preparar el reemplazo: ${(err as Error).message}`,
        action: "la instalación anterior quedó intacta; volvé a preparar el cambio",
      },
    };
  }

  await writeJournal(ctx, journal);
  try {
    for (const entry of stagedSet.filter((item) => item.destination.host !== "registry")) {
      journal.destinations.push(await publish(entry, id));
      await writeJournal(ctx, journal);
    }
    const registryDestination = stagedSet.find(
      (item) => item.destination.host === "registry",
    )?.destination;
    if (registryDestination !== undefined) {
      await writeRegistryAtomically(home, registryAfter(before, proposal, journal.destinations));
      journal.registryWritten = true;
      journal.destinations.push({
        location: registryDestination.location,
        host: "registry",
        action: registryDestination.action,
        status: "applied",
        backup: null,
      });
      await writeJournal(ctx, journal);
    }
  } catch (err) {
    return { status: "applied", result: await rollback(ctx, journal, proposal, before, err) };
  }

  const destinations: DestinationResult[] = [];
  for (const record of journal.destinations) {
    destinations.push({
      location: record.location,
      host: record.host,
      status: record.status,
      verification: await verify(record, home, expected, proposal.proposedRegistry),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    });
  }
  const failedCheck = destinations.filter(
    (result) => result.verification !== null && !result.verification.passed,
  );
  // A receipt is terminal only when every check passed; the backups go only
  // then, and a cleanup failure never un-verifies bytes already checked.
  const cleanupPending =
    failedCheck.length === 0 ? await cleanup(journal.destinations, home, id) : [];
  if (failedCheck.length === 0) {
    await rm(skillsJournalPath(home), { force: true }).catch(() => {});
  } else {
    journal.destinations = journal.destinations.map((record) => ({
      ...record,
      status: failedCheck.some((result) => result.location === record.location)
        ? "failed"
        : record.status,
    }));
    await writeJournal(ctx, journal);
  }

  return {
    status: "applied",
    result: {
      operation: proposal.operation,
      digest: proposal.digest,
      destinations,
      recovery:
        failedCheck.length === 0
          ? null
          : {
              restored: [],
              pending: failedCheck.map((result) => result.location),
              action:
                "los respaldos se conservan: comprobá esas ubicaciones y volvé a preparar el cambio",
            },
      cleanup: cleanupPending.length > 0 ? { pending: cleanupPending } : null,
      summary:
        failedCheck.length === 0
          ? `'${proposal.operation}' aplicada y comprobada en ${destinations.length} ubicaciones.`
          : `'${proposal.operation}' aplicada con ${failedCheck.length} comprobación(es) fallida(s).`,
    },
  };
}

/** What a pending journal offers on reopen: put it back, or start over. */
export type JournalRecovery = "restore" | "discard";

/**
 * Resolves the operation a previous run left pending.
 *
 * `restore` puts every applied destination back from its backup; `discard`
 * accepts the current state and drops the journal. Neither repeats an effect:
 * a new attempt needs a new proposal, because the bytes and the destinations
 * are what an approval covers.
 */
export async function recoverSkillJournal(
  ctx: CliContext,
  choice: JournalRecovery,
): Promise<ApplyOutcome> {
  const home = ctx.env.homeDir();
  const journal = await readSkillJournal(ctx);
  if (journal === null) {
    return {
      status: "refused",
      refusal: { code: "NO_JOURNAL", message: "no hay ninguna operación pendiente" },
    };
  }
  const lock = await acquireLock(join(home, ".agents", LOCK_FILE), ctx.fs, {
    waitMs: LOCK_WAIT_MS,
  });
  try {
    if (choice === "discard") {
      const pending = await cleanup(journal.destinations, home, journal.id);
      await rm(skillsJournalPath(home), { force: true }).catch(() => {});
      return {
        status: "applied",
        result: {
          operation: journal.operation,
          digest: journal.approvedDigest,
          destinations: journal.destinations.map((record) => ({
            location: record.location,
            host: record.host,
            status: record.status,
            verification: null,
          })),
          recovery: null,
          cleanup: pending.length > 0 ? { pending } : null,
          summary: `Se aceptó el estado actual de '${journal.operation}' y se descartó su journal.`,
        },
      };
    }
    const recovery = await compensate(journal.destinations);
    if (journal.registryWritten) {
      await writeRegistryAtomically(home, journal.registryBefore).catch(() =>
        recovery.pending.push("registry"),
      );
    }
    if (recovery.pending.length === 0) {
      await rm(skillsJournalPath(home), { force: true }).catch(() => {});
    }
    return {
      status: "applied",
      result: {
        operation: journal.operation,
        digest: journal.approvedDigest,
        destinations: journal.destinations.map((record) => ({
          location: record.location,
          host: record.host,
          status: recovery.pending.includes(record.location) ? "failed" : "restored",
          verification: null,
        })),
        recovery: {
          restored: recovery.restored,
          pending: recovery.pending,
          action:
            recovery.pending.length === 0
              ? "se restauró el estado anterior de la operación pendiente"
              : `estado mixto: los respaldos de ${recovery.pending.join(", ")} se conservan`,
        },
        cleanup: null,
        summary:
          recovery.pending.length === 0
            ? `Se restauró el estado previo a '${journal.operation}'.`
            : `Restauración parcial de '${journal.operation}': quedan ubicaciones por resolver.`,
      },
    };
  } finally {
    await lock.release();
  }
}
