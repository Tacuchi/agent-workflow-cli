import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  formatCorrelative,
  leadingCorrelative,
  maxCorrelative,
  nextCorrelative,
  sameCorrelative,
} from "../domain/correlative.js";
import { HARNESSES, type Harness, type HarnessId, harnessById } from "../domain/harnesses.js";
import { reservationMarker } from "../domain/reservation.js";
import {
  type HostExecutionCapability,
  type ResourcePlan,
  decideResources,
} from "../domain/resource-policy.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  type ClaimEvent,
  appendClaimEvent,
  eligibleCorrelatives,
  isRevoked,
  readClaimEvents,
} from "./claims-ledger.js";
import { withCwdLock } from "./lock-service.js";
import { parseMdSection, parseMdValue } from "./markdown.js";
import type { PathsService } from "./paths-service.js";

// ─── harness ────────────────────────────────────────────────────────────────

export interface HarnessOutput {
  /** @deprecated Use agent_host. Kept for callers of the previous JSON shape. */
  harness: Harness;
  /** The agent runtime that owns model/tool execution. */
  agent_host: Harness;
  /** The terminal that carries the agent, when it can be observed separately. */
  terminal_host: Harness;
  /** Native dispatch primitive; the CLI's resource policy still controls use. */
  execution: HostExecutionCapability;
  /** The two no-guess defaults the CLI applies before any model work. */
  resource_policy: {
    deterministic: ResourcePlan;
    semantic_default: ResourcePlan;
  };
  supports_plan_subagent: boolean;
  detected_via: string;
  terminal_detected_via: string;
  known_harnesses: string[];
  /**
   * Set when `harness` is `unknown`. Env markers are the only signal this
   * function has, and several hosts export none to their subprocesses — so
   * `unknown` means "no marker in this environment", NEVER "no host here".
   * Which hosts exist on the machine is `aw self detect-hosts`' question, and it
   * answers it from binaries and config dirs instead.
   */
  note?: string;
}

const UNKNOWN_NOTE =
  "No env marker matched. Some hosts export none to their subprocesses, so this is not evidence that no host is present — run 'agent-workflow self detect-hosts' for the machine's real host states.";

/**
 * Which harness are we running INSIDE? Env markers only — that is the single
 * signal a process has about its own parent. A host that exports none (Kimi
 * Code) legitimately answers `unknown`; see `note`.
 */
export function isHarnessId(value: string): value is HarnessId {
  return harnessById(value as HarnessId) !== null;
}

/**
 * Resolves the execution host independently from the terminal. An installed
 * wrapper may bind its target explicitly; the live agent markers are the
 * fallback. This prevents `TERM_PROGRAM=WarpTerminal` from masking Codex (or
 * any other agent) that happens to run inside Warp.
 */
export function runHarness(
  envGet: (k: string) => string | undefined,
  boundHost?: HarnessId,
): HarnessOutput {
  const knownHarnesses = [...HARNESSES.map((h) => h.id), "unknown"];
  const terminal = detectTerminalHarness(envGet);

  if (boundHost !== undefined) {
    const spec = harnessById(boundHost);
    // `boundHost` is typed, but keep this fail-closed guard for JS/API callers.
    if (spec !== null) {
      return outputFor(spec.id, `binding:${spec.id}`, terminal, knownHarnesses);
    }
  }

  // First-match over HARNESSES registry (oz before warp for overlap handling)
  for (const spec of HARNESSES) {
    for (const marker of spec.envMarkers) {
      if (envGet(marker)) {
        return outputFor(spec.id, `env:${marker}`, terminal, knownHarnesses);
      }
    }
    // A terminal-only marker is a fallback agent signal, never precedence over
    // an actual agent marker from an earlier catalog entry.
    if (spec.id === "warp" && terminal.host === "warp") {
      return outputFor("warp", terminal.via, terminal, knownHarnesses);
    }
  }

  // There used to be a filesystem fallback here: `~/.codex/` present → answer
  // "codex". It conflated two different facts — "Codex is INSTALLED on this
  // machine" and "we are RUNNING INSIDE Codex" — and the second is the only one
  // this function is asked about. The consequence was concrete: `aw mcp setup`
  // with no `--host`, run from any unrecognized host, resolved to codex and
  // would have written that host's config.toml, purely because the directory
  // existed. Which hosts are installed is `aw self detect-hosts`' question, and
  // it answers it from binaries and config dirs, as separate states.
  return {
    harness: "unknown",
    agent_host: "unknown",
    terminal_host: terminal.host,
    execution: { subagents: "none", max_subagents: 0, mechanism: null },
    resource_policy: resourcePolicyFor({ subagents: "none", max_subagents: 0, mechanism: null }),
    supports_plan_subagent: false,
    detected_via: "unknown",
    terminal_detected_via: terminal.via,
    known_harnesses: knownHarnesses,
    note: UNKNOWN_NOTE,
  };
}

function outputFor(
  agentHost: HarnessId,
  detectedVia: string,
  terminal: { host: Harness; via: string },
  knownHarnesses: string[],
): HarnessOutput {
  const execution = harnessById(agentHost)?.execution;
  return {
    harness: agentHost,
    agent_host: agentHost,
    terminal_host: terminal.host,
    execution: execution ?? { subagents: "none", max_subagents: 0, mechanism: null },
    resource_policy: resourcePolicyFor(
      execution ?? { subagents: "none", max_subagents: 0, mechanism: null },
    ),
    supports_plan_subagent: execution?.subagents === "parallel",
    detected_via: detectedVia,
    terminal_detected_via: terminal.via,
    known_harnesses: knownHarnesses,
  };
}

function resourcePolicyFor(host: HostExecutionCapability): HarnessOutput["resource_policy"] {
  return {
    deterministic: decideResources({ boundary: "deterministic", host }),
    semantic_default: decideResources({ boundary: "semantic", host }),
  };
}

function detectTerminalHarness(envGet: (k: string) => string | undefined): {
  host: Harness;
  via: string;
} {
  const warp = harnessById("warp");
  if (warp !== null) {
    for (const marker of warp.envMarkers) {
      if (envGet(marker)) return { host: "warp", via: `env:${marker}` };
    }
    if (warp.termProgramMatch && envGet("TERM_PROGRAM") === warp.termProgramMatch) {
      return { host: "warp", via: `env:TERM_PROGRAM=${warp.termProgramMatch}` };
    }
  }
  return { host: "unknown", via: "unknown" };
}

// ─── profiles ───────────────────────────────────────────────────────────────

export interface ProfilesOutput {
  validation_mode: "ask" | "auto" | "manual";
  teaching_mode: "off" | "on";
  delegate_to_subagent: boolean;
  source: "default" | "user-config";
  legacy_section_detected: boolean;
}

export async function runProfiles(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<ProfilesOutput> {
  const result: ProfilesOutput = {
    validation_mode: "ask",
    teaching_mode: "off",
    delegate_to_subagent: false,
    source: "default",
    legacy_section_detected: false,
  };

  const sharedCfg = paths.userConfigMd();
  const legacyCfg = join(homedir(), ".developer-workflow", "user-config.md");
  const userCfg = (await fs.exists(sharedCfg))
    ? sharedCfg
    : (await fs.exists(legacyCfg))
      ? legacyCfg
      : null;
  if (userCfg === null) return result;

  const text = await fs.readText(userCfg);
  let prefsText = parseMdSection(text, "Preferences");
  if (prefsText === undefined) {
    const legacyText = parseMdSection(text, "Workflow profile");
    if (legacyText !== undefined) {
      result.legacy_section_detected = true;
      prefsText = legacyText;
    }
  }
  if (prefsText === undefined) return result;

  const val = parseMdValue(prefsText, "Validation mode")?.toLowerCase();
  if (val === "ask" || val === "auto" || val === "manual") {
    result.validation_mode = val;
    result.source = "user-config";
  }
  const teach = parseMdValue(prefsText, "Teaching mode")?.toLowerCase();
  if (teach === "off" || teach === "on") {
    result.teaching_mode = teach;
    result.source = "user-config";
  }
  const delegate = parseMdValue(prefsText, "Delegate to subagent")?.toLowerCase();
  if (delegate === "true" || delegate === "false") {
    result.delegate_to_subagent = delegate === "true";
    result.source = "user-config";
  }
  return result;
}

// ─── logs ───────────────────────────────────────────────────────────────────

export interface LogsInput {
  tail?: number;
  clear?: boolean;
}

export interface LogsClearedOutput {
  cleared: true;
  path: string;
}

export interface LogsListOutput {
  path: string;
  total_lines?: number;
  showing?: number;
  lines: string[];
  message?: string;
}

export type LogsOutput = LogsClearedOutput | LogsListOutput;

export async function runLogs(
  env: EnvPort,
  paths: PathsService,
  input: LogsInput,
): Promise<LogsOutput> {
  // Unified to the GLOBAL, user-level daily log (~/.${ns}/logs/agent-workflow-*.log):
  // the same source the [Status] tab lists. The old per-workspace path is obsolete.
  void env;
  const logsDir = paths.userLogsDir();
  const path = paths.userDailyLogFile(new Date());

  if (input.clear === true) {
    // Clear every daily log, not just today's.
    if (existsSync(logsDir)) {
      for (const name of readdirSync(logsDir)) {
        if (/^agent-workflow-.*\.log$/.test(name)) unlinkSync(join(logsDir, name));
      }
    }
    return { cleared: true, path: logsDir };
  }

  if (!existsSync(path)) {
    return { lines: [], path, message: "No log file found" };
  }
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  // Mirror Python str.splitlines() — drops trailing empty string.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const tail = input.tail ?? 20;
  const tailLines = tail < total ? lines.slice(total - tail) : lines;
  return {
    path,
    total_lines: total,
    showing: tailLines.length,
    lines: tailLines,
  };
}

// ─── next-number ────────────────────────────────────────────────────────────

export interface NextNumberOutput {
  directory: string;
  /** Pre-call state: whether the directory already existed. */
  exists: boolean;
  /** True when this call created the directory (never with dryRun). */
  created: boolean;
  current_max: number;
  next: string;
  files: string[];
  /**
   * The file this call CLAIMED, materialized on disk — `null` for the pure
   * query. A consulted number is a guess about a directory nobody is holding;
   * a claimed one is a possession, and the difference is the whole point.
   */
  claimed_path: string | null;
  /**
   * The session the reservation belongs to — `null` for an anonymous claim.
   *
   * An owned reservation is the half that makes completing it a different act
   * from overwriting a document: whoever holds the slot can fill it, and nobody
   * else can. `spec-new` runs outside any session and legitimately claims
   * anonymously; its write does not travel through a sealed proposal.
   */
  claimed_owner: string | null;
  /**
   * The document this call PUBLISHED in one pass — `null` for a query and for a
   * claim.
   *
   * A publication is the other half of the reservation story: the caller that
   * has no session to own a slot does not get one, it gets the finished
   * document. Reporting it in its own field is what keeps "I hold a number" and
   * "I wrote a document" two different answers instead of one ambiguous path.
   */
  published_path: string | null;
  /**
   * True when this call handed back a reservation it already held.
   *
   * The claim is a WRITE, so a resumed run asking again would otherwise mint a
   * second number and abandon the first — which is the orphan this field exists
   * to make visible rather than merely absent.
   */
  claim_reused: boolean;
}

export interface NextNumberInput {
  directory: string;
  /** Pure query: never creates the directory (plan/dry-run mode). */
  dryRun?: boolean;
  /**
   * Claim the correlative by materializing `<NNN>-<name>` inside the directory,
   * for the session that will own it.
   *
   * The scan and the creation happen inside ONE workspace-lock boundary, so no
   * other flow can read the same maximum; the exclusive creation then makes the
   * name itself unshareable even if the lock ever expires underneath.
   *
   * **The owner travels inside the claim, and that is the point.** A durable
   * reservation nobody can attribute used to be reachable simply by omitting an
   * optional field, and the empty file it left behind had no re-entry, no close
   * and no recovery. Pairing the two in one object makes the anonymous claim
   * unrepresentable rather than merely discouraged.
   */
  claim?: { name: string; owner: string };
  /**
   * Publish `<NNN>-<name>` with its FINAL bytes in one operation.
   *
   * This is the answer for a single-pass creation that has no session to own a
   * reservation. Assigning the number and writing the document are the same
   * locked, atomic, exclusive act, so there is no reserved state in between for
   * an interruption to strand: either the document is there whole, or the
   * correlative was never consumed.
   */
  publish?: { name: string; content: string };
}

/**
 * How long a mint waits for another flow's lock before giving up.
 *
 * A claim cannot fail fast the way `HISTORY.md` does: whoever asked is about to
 * write a document, and telling them "busy, retry" hands the number to nobody
 * while both flows are still running. The scan+create it protects takes
 * milliseconds, so a bounded wait absorbs real contention without hiding a
 * genuinely stuck holder — that one still surfaces as busy.
 */
const CLAIM_LOCK_WAIT_MS = 10_000;

/** Upper bound on numbers skipped because a concurrent flow already took them. */
const MAX_CLAIM_PROBES = 50;

/** What this call is going to write, or `null` for a pure query. */
type Mint =
  | { kind: "claim"; name: string; bytes: string; owner: string }
  | { kind: "publish"; name: string; bytes: string };

/**
 * Resolve the call into the single write it will attempt.
 *
 * A claim always carries its owner here because the input type cannot express
 * one without it — the anonymous durable reservation is not a call this function
 * refuses, it is a call nobody can construct.
 */
function mintOf(
  claim: NextNumberInput["claim"],
  publish: NextNumberInput["publish"],
  dryRun: boolean,
): Mint | null {
  if (dryRun) return null;
  if (publish !== undefined) {
    return { kind: "publish", name: publish.name, bytes: publish.content };
  }
  if (claim !== undefined && claim.name.length > 0) {
    return {
      kind: "claim",
      name: claim.name,
      bytes: reservationMarker(claim.owner),
      owner: claim.owner,
    };
  }
  return null;
}

/**
 * The mint itself, already inside the workspace lock.
 *
 * Extracted so `runNextNumber` reads as what it is — resolve the mode, guard the
 * name, take the lock, report — instead of nesting the whole critical section
 * inside its own argument list.
 */
async function mintUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  target: string,
  mint: Mint,
): Promise<NextNumberOutput> {
  const state = await scan(fs, target, false);
  // Re-entry, before minting anything: a run that already holds this exact slot
  // gets it back. Handing it a second number instead would abandon the first
  // one, and an abandoned reservation is the empty document nobody is coming
  // back for. A publication has no slot to re-enter — it never left one open.
  if (mint.kind === "claim") {
    const held = await heldReservation(fs, target, state.files, mint.name, mint.bytes);
    if (held !== null) {
      return {
        ...state,
        next: held.nnn,
        claimed_path: normalize(held.path),
        claimed_owner: mint.owner,
        claim_reused: true,
      };
    }
  }
  // Correlatives the ledger says came back, lowest first, BEFORE `max + 1`.
  //
  // The old mint computed `max + 1` and probed forward only, so a number released
  // in the middle of the range was gone for good — this workspace still carries a
  // permanent hole from exactly that. The disk cannot tell a number that was given
  // back from one that never existed; only the record can, which is why the
  // eligible set is read here and not derived from the directory listing.
  const ledger = await readClaimEvents(fs, paths);
  const reusable = eligibleCorrelatives(ledger.events, basename(target));
  // Each reusable correlative gets ONE attempt — it is a specific number, not a
  // starting point — and then `max + 1` gets the forward probe it always had.
  for (const candidate of [...reusable, null]) {
    let nnn = candidate ?? state.next;
    const probes = candidate === null ? MAX_CLAIM_PROBES : 1;
    for (let probe = 0; probe < probes; probe++, nnn = nextCorrelative(nnn)) {
      const taken = await attemptAt(fs, paths, target, mint, state, nnn, ledger.events);
      if (taken !== null) return taken;
    }
  }
  throw new Error(
    `no se pudo ${mint.kind === "publish" ? "publicar" : "reclamar"} un correlativo en ${target}: ${MAX_CLAIM_PROBES} números consecutivos ya estaban tomados`,
  );
}

/**
 * Take exactly this correlative, or answer `null` so the caller tries the next.
 *
 * Everything here happens under the mint's lock. The record is written in the
 * same breath as the slot for the same reason the release is: a reservation
 * without its line is a claim nobody can account for once the marker is gone.
 */
async function attemptAt(
  fs: FileSystemPort,
  paths: PathsService,
  target: string,
  mint: Mint,
  state: NextNumberOutput,
  nnn: string,
  events: readonly ClaimEvent[],
): Promise<NextNumberOutput | null> {
  // Taken by NUMBER: another document already holds this correlative under a
  // different slug, so the name is free while the number is not. A released
  // correlative can also have been taken again since, which is why the record
  // answers "was it given back" and the disk answers "is it free now".
  if (state.files.some((name) => hasCorrelative(name, nnn))) return null;
  // Never hand out a claim key that is already FENCED.
  //
  // A revocation is permanent and keyed by category/correlative/name/owner, so a
  // recovery followed by the same owner re-claiming the same document name used to
  // mint the identical key — and the publication point then refused it forever.
  // The run walked away holding a slot it could never complete, and the refusal's
  // advice ("ask for a new one") looped straight back to the same key through the
  // idempotent re-entry. Skipping it here is what keeps the eligible set from
  // handing back a number that is only nominally free.
  if (
    mint.kind === "claim" &&
    isRevoked(events, {
      category: basename(target),
      correlative: nnn,
      name: mint.name,
      owner: mint.owner,
    })
  ) {
    return null;
  }
  const path = join(target, `${nnn}-${mint.name}`);
  // Atomic AND exclusive. The marker goes through the same primitive as a
  // document on purpose: a half-written marker IS the anonymous zero-byte
  // placeholder this mechanism exists to retire, and there is no reason to keep a
  // way of producing one.
  const { created } = await fs.publishTextExclusive(path, mint.bytes);
  if (!created) return null;
  if (mint.kind === "publish") {
    // A publication leaves no reservation, so it has no lifecycle to record: the
    // document on disk IS the whole story, and `scan` already reads its
    // correlative as spent straight from the file.
    return { ...state, next: nnn, published_path: normalize(path) };
  }
  await appendClaimEvent(fs, paths, {
    at: new Date().toISOString(),
    event: "claimed",
    claim: {
      category: basename(target),
      correlative: nnn,
      name: mint.name,
      owner: mint.owner,
    },
    cause: "aw next-number --claim",
  });
  return {
    ...state,
    next: nnn,
    claimed_path: normalize(path),
    claimed_owner: mint.owner,
    claim_reused: false,
  };
}

export async function runNextNumber(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: NextNumberInput,
): Promise<NextNumberOutput> {
  const cwd = env.cwd();
  const { directory, dryRun = false, claim, publish } = input;
  const target = isAbsolute(directory) ? directory : join(cwd, directory);
  if (claim !== undefined && publish !== undefined) {
    throw new Error(
      "reclamar y publicar se excluyen: un reclamo reserva el número para escribirlo después, una publicación lo asigna y escribe el documento en el mismo acto",
    );
  }

  const mint = mintOf(claim, publish, dryRun);
  if (mint === null) return scan(fs, target, dryRun);
  // The mint becomes a real filesystem write, so it is a name and never a path:
  // a separator would let `../…` land outside the directory the caller named —
  // and every caller of this is a command-line argument.
  if (/[\\/]/.test(mint.name)) {
    throw new Error(
      `el nombre '${mint.name}' no puede contener separadores de ruta: es el resto del nombre del archivo, no una ruta`,
    );
  }

  const minted = await withCwdLock(fs, paths, () => mintUnderLock(fs, paths, target, mint), {
    waitMs: CLAIM_LOCK_WAIT_MS,
  });

  if ("error" in minted) {
    throw new Error(`no se pudo tomar el correlativo: ${minted.error}`);
  }
  return minted;
}

/**
 * The slot this owner already holds under this exact name, if any.
 *
 * Matched by name AND by bytes: a file called `007-plan-x.md` that holds a
 * document, an empty legacy claim or another session's marker is not this run's
 * reservation, and returning it would be exactly the silent overwrite the whole
 * mechanism exists to refuse.
 */
async function heldReservation(
  fs: FileSystemPort,
  target: string,
  files: readonly string[],
  claim: string,
  marker: string,
): Promise<{ nnn: string; path: string } | null> {
  for (const name of files) {
    const nnn = leadingCorrelative(name);
    if (nnn === null || name.slice(nnn.length) !== `-${claim}`) continue;
    const path = join(target, name);
    try {
      if ((await fs.readText(path)) === marker) return { nnn, path };
    } catch {
      // Unreadable is not "mine": it stays taken by number and the mint moves on.
    }
  }
  return null;
}

async function scan(
  fs: FileSystemPort,
  target: string,
  dryRun: boolean,
): Promise<NextNumberOutput> {
  const exists = await fs.exists(target);
  let created = false;
  if (!exists && !dryRun) {
    // On-demand creation: the CLI owns docs/<category> dirs — workspace-init no
    // longer scaffolds them upfront, they are born at the first numbered write.
    await fs.mkdirp(target);
    created = true;
  }
  const files: string[] = [];
  const correlatives: string[] = [];
  if (exists) {
    const entries = await fs.list(target);
    const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sortedEntries) {
      files.push(entry.name);
      const correlative = leadingCorrelative(entry.name);
      if (correlative !== null) correlatives.push(correlative);
    }
  }
  const maximum = maxCorrelative(correlatives);
  // `current_max` is a legacy JSON number kept for callers that display it.
  // All minting itself uses `next`, which remains lossless for any digit width.
  const currentMax = maximum === null ? 0 : Number.parseInt(maximum, 10);
  return {
    directory: normalize(target),
    exists,
    created,
    current_max: currentMax,
    next: maximum === null ? formatCorrelative(1) : nextCorrelative(maximum),
    files,
    claimed_path: null,
    claimed_owner: null,
    published_path: null,
    claim_reused: false,
  };
}

function hasCorrelative(name: string, wanted: string): boolean {
  const found = leadingCorrelative(name);
  return found !== null && sameCorrelative(found, wanted);
}

function normalize(path: string): string {
  return path.split("\\").join("/");
}
