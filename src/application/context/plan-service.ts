import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { TOKENS_UNAVAILABLE } from "./budget-service.js";
import { resolveBundleRoot } from "./bundle-root.js";
import { type ContextManifest, contextEntryFor, loadManifest } from "./manifest.js";
import { byteLength, resolveReadSet } from "./measure.js";

/**
 * `aw context-plan` — what to read for this invocation, and the receipt proving it.
 *
 * The chain does not get deeper, it gets FLATTER. Today a command points at a
 * loop which points at the chassis: two chained reads, and the evidence says the
 * second one is where weak models drop out. Here there is one call and N files
 * at the same level, each with an absolute path the agent can open directly.
 *
 * Division of labour, unchanged from plan 009: the AI supplies the semantics —
 * which signals this task carries — and the CLI owns the boundary: what gets
 * read, what it costs, what is recorded. That is also why the receipt is command
 * output rather than the agent's own account of what it loaded; under gate
 * integrity only the check's output counts.
 */

/** Compact = core plus the signalled modules. Safe = everything, no bet. */
export type ContextProfile = "compact" | "safe";

export interface ReadSetEntry {
  path: string;
  /** Absolute path: the whole point is that the agent opens it without re-deriving it. */
  absolute: string;
  bytes: number;
  /** Core is always loaded; a module is here because a signal asked for it. */
  kind: "core" | "module";
  /** Which signal pulled it in, `null` for core. */
  signal: string | null;
  missing: boolean;
}

export interface ContextReceipt {
  command: string;
  profile: ContextProfile;
  signals: readonly string[];
  /** Capabilities the caller declared, as `harness/HARNESS.md` names them. */
  capabilities: readonly string[];
  /** Bundle-relative paths, in read order. */
  loaded: readonly string[];
  /** Reads chained off the entry point. Flat read-sets keep this at 0. */
  reference_hops: number;
  bytes: number;
  tokens: { available: false; reason: string };
  /** The safe profile was used instead of the compact one, and why. */
  fallback: { used: boolean; reasons: readonly string[] };
  root: string;
  root_origin: string;
  /** Stated, not implied: nothing here leaves the machine. */
  telemetry: "local-only";
}

export interface ContextPlanOutput {
  command: string;
  profile: ContextProfile;
  signals: readonly string[];
  /**
   * Every signal this command accepts, with what observing it means.
   *
   * The CLI advertises them so no command file has to. A module nothing routes
   * to is a module nothing loads, and paying 16 command files to list their own
   * signals would cost more than the modules save — the boundary belongs here.
   */
  available_signals: readonly { signal: string; means: string; module: string }[];
  read_set: readonly ReadSetEntry[];
  bytes: number;
  degraded: boolean;
  /** One line the agent relays verbatim when the profile widened; `null` otherwise. */
  notice: string | null;
  receipt: ContextReceipt;
}

export interface ContextPlanInput {
  command: string;
  signals?: readonly string[];
  /**
   * Capabilities the caller declares, named as `harness/HARNESS.md` names them.
   * Never a host name: spec 010 inherits this surface, and a branch keyed on
   * who is running would be a condition it inherits wrong.
   */
  capabilities?: readonly string[];
  root?: string;
}

export class ContextPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextPlanError";
  }
}

export async function runContextPlan(
  fs: FileSystemPort,
  input: ContextPlanInput,
): Promise<ContextPlanOutput> {
  if (input.command.length === 0) {
    throw new ContextPlanError("CONTEXT_PLAN_NO_COMMAND", "--command es obligatorio");
  }
  const resolved = await resolveBundleRoot(fs, input.root);
  const manifest = await loadManifest(fs, resolved.root);
  const signals = [...new Set(input.signals ?? [])].sort();
  const capabilities = new Set(input.capabilities ?? []);

  const set = resolveReadSet(manifest, input.command, signals);
  if (set.paths.length === 0) {
    throw new ContextPlanError(
      "CONTEXT_PLAN_UNKNOWN_COMMAND",
      `'${input.command}' no está en el manifiesto de ${resolved.root}. Comandos: ${Object.keys(manifest.commands).sort().join(", ")}. Capacidades: ${Object.keys(manifest.capabilities).sort().join(", ") || "(ninguna)"}`,
    );
  }

  const compact = await describeReadSet(fs, resolved.root, manifest, input.command, set.paths);

  // Two kinds of trouble, and they do NOT deserve the same answer.
  //
  // UNTRUSTWORTHY SIGNALS — an unknown signal, or a module the tree lacks —
  // mean the signal set itself cannot be relied on, so betting on it is what
  // stopped being safe: widen to the full profile.
  //
  // AN UNMET CAPABILITY is different. It does not change WHICH documents to
  // read; it changes what the run will be able to do once it has read them, and
  // the module concerned already says how to degrade (the ideation gate
  // declares the web unavailable, the DB rule keeps reads read-only). Widening
  // the whole profile there would load every unrelated branch as a penalty for
  // a capability the host never had — and it would cancel this round's savings
  // on precisely the `db`, `web` and `compaction` journeys.
  const structural = [...set.reasons, ...missingDocuments(compact)];
  const unmet = unmetCapabilities(manifest, input.command, signals, capabilities);

  const profile = selectProfile(structural);
  const safePaths = everyPath(manifest, input.command);
  const readSet =
    profile === "safe" && !samePaths(set.paths, safePaths)
      ? await describeReadSet(fs, resolved.root, manifest, input.command, safePaths)
      : compact;
  const reasons = [...structural, ...unmet];
  // Degraded is the honest word for BOTH: the run is not getting what a fully
  // capable host on a complete tree would get, and it is told so either way.
  const degraded = reasons.length > 0;
  const bytes = readSet.reduce((sum, e) => sum + e.bytes, 0);

  return {
    command: input.command,
    profile,
    signals,
    available_signals: (contextEntryFor(manifest, input.command)?.modules ?? []).map((m) => ({
      signal: m.signal,
      means: manifest.signals[m.signal] ?? "",
      module: m.path,
    })),
    read_set: readSet,
    bytes,
    degraded,
    notice: degraded ? degradationNotice(profile, reasons) : null,
    receipt: {
      command: input.command,
      profile,
      signals,
      capabilities: [...capabilities].sort(),
      loaded: readSet.filter((e) => !e.missing).map((e) => e.path),
      // Every document comes back from ONE call, so nothing is chained off
      // anything else. This staying 0 is the measurable form of "flatter".
      reference_hops: 0,
      bytes,
      tokens: { available: false, reason: TOKENS_UNAVAILABLE },
      fallback: { used: degraded, reasons },
      root: resolved.root,
      root_origin: resolved.origin,
      telemetry: "local-only",
    },
  };
}

/**
 * Compact or safe, from the STRUCTURAL reasons alone.
 *
 * Deterministic by construction: same command, same signals and same tree give
 * the same profile, every time. Nothing here reads a clock, a random source or
 * prior state, which is what keeps a run from oscillating between invocations.
 *
 * An unmet capability is deliberately NOT a reason here — it is reported, not
 * paid for. See the two-kinds-of-trouble note at the call site.
 */
export function selectProfile(structuralReasons: readonly string[]): ContextProfile {
  return structuralReasons.length === 0 ? "compact" : "safe";
}

/**
 * Capabilities a module in this read-set depends on and the caller did not
 * declare. Named as `harness/HARNESS.md` names them — never a host.
 */
function unmetCapabilities(
  manifest: ContextManifest,
  command: string,
  signals: readonly string[],
  capabilities: ReadonlySet<string>,
): string[] {
  const observed = new Set(signals);
  const out: string[] = [];
  for (const module of contextEntryFor(manifest, command)?.modules ?? []) {
    if (module.requires === undefined) continue;
    if (!observed.has(module.signal)) continue;
    if (capabilities.has(module.requires)) continue;
    out.push(`'${module.path}' depende de la capacidad '${module.requires}', no declarada`);
  }
  return out;
}

function missingDocuments(readSet: readonly ReadSetEntry[]): string[] {
  const missing = readSet.filter((e) => e.missing).map((e) => e.path);
  return missing.length > 0 ? [`el árbol no trae: ${missing.join(", ")}`] : [];
}

/**
 * Whether widening would change anything.
 *
 * On the unknown-signal path the resolver already returned every module, so the
 * safe set is the identical list — re-describing it would be a second full pass
 * of `exists` + `readText` for the same answer, on exactly the path a
 * half-updated install takes most often.
 */
function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

function everyPath(manifest: ContextManifest, command: string): string[] {
  const entry = contextEntryFor(manifest, command);
  if (entry === undefined) return [];
  const out = [...entry.core];
  for (const module of entry.modules) if (!out.includes(module.path)) out.push(module.path);
  return out;
}

async function describeReadSet(
  fs: FileSystemPort,
  root: string,
  manifest: ContextManifest,
  command: string,
  paths: readonly string[],
): Promise<ReadSetEntry[]> {
  const origins = moduleOrigins(manifest, command);
  const out: ReadSetEntry[] = [];
  for (const path of paths) {
    const absolute = join(root, path);
    const exists = await fs.exists(absolute);
    const signal = origins.get(path) ?? null;
    out.push({
      path,
      absolute,
      bytes: exists ? byteLength(await fs.readText(absolute)) : 0,
      kind: signal === null ? "core" : "module",
      signal,
      missing: !exists,
    });
  }
  return out;
}

/**
 * The degradation notice: what changed and what it implies, once.
 *
 * It never asks for a profile. Widening is the loop's decision and the user's
 * information — spec 009 § Behavioral changes: an equivalent compact route does
 * not interrupt, a degraded one says so exactly once.
 */
function degradationNotice(profile: ContextProfile, reasons: readonly string[]): string {
  const cause = reasons.join("; ");
  return profile === "safe"
    ? `Contexto ampliado al perfil seguro (${cause}). Impacto: se carga la doctrina completa del comando, así que el recorrido cuesta más pero conserva el mismo resultado.`
    : `Contexto degradado sin ampliar (${cause}). Impacto: el read-set es el mismo, pero la capacidad ausente limita lo que el recorrido puede hacer con él; el módulo afectado declara cómo degradar.`;
}

function moduleOrigins(manifest: ContextManifest, command: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const module of contextEntryFor(manifest, command)?.modules ?? []) {
    out.set(module.path, module.signal);
  }
  return out;
}
