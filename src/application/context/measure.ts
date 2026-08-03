import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readPackageVersion } from "../../runtime/version.js";
import { splitCommandDoc } from "../self/install-skill.js";
import { contextEntryFor } from "./manifest.js";
import type { ContextManifest } from "./manifest.js";

/**
 * The three tramos of context cost (spec 009 § Requirement).
 *
 * Everything here is deterministic and offline: bytes of UTF-8 content read
 * from a tree on disk, nothing sampled, nothing asked of a host. That is what
 * lets a gate compare two revisions and get an answer that means something.
 *
 * Bytes — not tokens — is the gate metric on purpose: no host in the harness
 * matrix exposes real token accounting to the agent, and inventing a bytes↔
 * tokens equivalence would make the budget unfalsifiable (spec 009, scenario
 * "metricas de tokens no disponibles").
 */

/** The file the discovery surface always includes besides the commands. */
const ORIENTATION_DOC = "SKILL.md";
const COMMANDS_DIR = "commands";
/** Not a command: the commands folder's own index. */
const COMMANDS_INDEX = "README.md";

export interface FileCost {
  path: string;
  bytes: number;
  /** The manifest names it but the tree does not carry it. */
  missing: boolean;
}

export interface DiscoveryEntry {
  /** Bundle-relative path whose frontmatter description the host shows. */
  path: string;
  bytes: number;
}

export interface DiscoveryMeasure {
  bytes: number;
  entries: readonly DiscoveryEntry[];
}

export interface ActivationEntry {
  command: string;
  bytes: number;
}

export interface ActivationMeasure {
  median: number;
  entries: readonly ActivationEntry[];
}

export interface JourneyCost {
  id: string;
  label: string;
  command: string;
  signals: readonly string[];
  bytes: number;
  files: readonly FileCost[];
  /**
   * The journey's SAFE profile: core plus **every** module, which is what the
   * fallback loads. It is the true upper bound of the flow, and the only figure
   * that budgets the modules themselves — a representative journey carries no
   * signal, so without this the modules/ tree would sit outside every budget
   * line and could grow without limit.
   */
  safe_bytes: number;
  /** A module the manifest declares but the tree lacks forced the full profile. */
  degraded: boolean;
}

export interface ExecutionMeasure {
  median: number;
  journeys: readonly JourneyCost[];
}

export interface ModulesMeasure {
  /** Distinct modules the manifest declares, across every command. */
  count: number;
  /** Their total bytes, counted once each. */
  bytes: number;
}

export interface GuaranteedEntry {
  command: string;
  /** Bytes of the core read-set: what this command loads before any signal. */
  bytes: number;
  files: readonly string[];
}

export interface TreeIdentity {
  /** Version of the CLI that produced the measurement. */
  cli_version: string;
  /** SHA-256 over the measured paths and their sizes: identifies the exact tree. */
  content_digest: string;
  /** Every bundle file that fed the digest. */
  file_count: number;
}

export interface ContextMeasurement {
  root: string;
  root_origin: string;
  revision: TreeIdentity;
  discovery: DiscoveryMeasure;
  activation: ActivationMeasure;
  execution: ExecutionMeasure;
  /**
   * Guaranteed load per COMMAND — core only, no signal observed.
   *
   * The ceiling this replaces covered six flows. Sixteen commands exist, and
   * the ten that carry no loop were never budgeted at all; this is where they
   * enter. It is the same quantity for a flow (`quick` = command + loop +
   * chassis + policies) and for a direct surface (`status` = its own body).
   */
  guaranteed: readonly GuaranteedEntry[];
  /**
   * The conditional tree, as one figure.
   *
   * A representative journey carries no signal, so no journey line ever prices
   * a module: without this the whole modules/ surface would sit outside every
   * budget and could grow unwatched. Budgeting it directly is the honest
   * instrument — capping a journey's FALLBACK against its pre-split normal path
   * compares a superset against something that never contained it.
   */
  modules: ModulesMeasure;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Median of a byte series, floored.
 *
 * Floored, and on the mean of the two central values for an even count, because
 * a budget derived from it has to be reproducible to the byte across machines —
 * a rounding rule chosen per call site is how two "same" measurements start
 * disagreeing.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.floor(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * Discovery: the metadata a host renders BEFORE the command is invoked — the
 * orientation skill's description plus one per command. Derived from the tree
 * rather than declared in the manifest: a command that ships without paying
 * discovery is precisely the drift the aggregate budget exists to catch.
 */
export async function measureDiscovery(
  fs: FileSystemPort,
  root: string,
): Promise<DiscoveryMeasure> {
  const paths = [ORIENTATION_DOC, ...(await listCommandDocs(fs, root))];
  const entries: DiscoveryEntry[] = [];
  for (const path of paths) {
    entries.push({ path, bytes: byteLength(await readDescription(fs, join(root, path))) });
  }
  return { bytes: entries.reduce((sum, e) => sum + e.bytes, 0), entries };
}

/** Activation: the command body itself — what the host loads the moment it is invoked. */
export async function measureActivation(
  fs: FileSystemPort,
  root: string,
): Promise<ActivationMeasure> {
  const entries: ActivationEntry[] = [];
  for (const path of await listCommandDocs(fs, root)) {
    const command = path.slice(`${COMMANDS_DIR}/`.length, -".md".length);
    entries.push({ command, bytes: await fileBytes(fs, join(root, path)) });
  }
  entries.sort((a, b) => a.command.localeCompare(b.command));
  return { median: median(entries.map((e) => e.bytes)), entries };
}

/** Execution: the whole read-set of a journey, core plus the modules its signals activate. */
export async function measureExecution(
  fs: FileSystemPort,
  root: string,
  manifest: ContextManifest,
): Promise<ExecutionMeasure> {
  const journeys: JourneyCost[] = [];
  for (const journey of manifest.journeys) {
    const readSet = resolveReadSet(manifest, journey.command, journey.signals);
    const files: FileCost[] = [];
    for (const path of readSet.paths) {
      const full = join(root, path);
      const exists = await fs.exists(full);
      files.push({
        path,
        bytes: exists ? await fileBytes(fs, full) : 0,
        missing: !exists,
      });
    }
    const entry = manifest.commands[journey.command];
    const everyPath = [...(entry?.core ?? []), ...(entry?.modules ?? []).map((m) => m.path)];
    let safeBytes = 0;
    for (const path of everyPath) {
      const full = join(root, path);
      if (await fs.exists(full)) safeBytes += await fileBytes(fs, full);
    }
    journeys.push({
      id: journey.id,
      label: journey.label,
      command: journey.command,
      signals: journey.signals,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      files,
      safe_bytes: safeBytes,
      degraded: readSet.degraded || files.some((f) => f.missing),
    });
  }
  return { median: median(journeys.map((j) => j.bytes)), journeys };
}

export interface ReadSet {
  paths: readonly string[];
  /** The manifest could not be honored as written; the full profile was returned. */
  degraded: boolean;
  /** Why it degraded, empty when it did not. */
  reasons: readonly string[];
}

/**
 * From (command, observed signals) to the ordered list of documents to read.
 *
 * Order is core-then-modules, and it is the order the agent reads in: the core
 * carries the hard floor, so it can never end up behind a conditional module.
 *
 * An unknown SIGNAL does not fail: a caller that knows a signal this bundle
 * does not is a half-finished update, which is a normal state, and the safe
 * answer there is MORE context — every module, marked degraded.
 *
 * An unknown COMMAND is different and returns an EMPTY set: there is no core to
 * fall back to, so nothing can be resolved. `runContextPlan` turns that into a
 * hard error naming the commands that do exist.
 */
export function resolveReadSet(
  manifest: ContextManifest,
  command: string,
  signals: readonly string[],
): ReadSet {
  // A capability answers here too: the question "what does this invocation have
  // to load" is the same one, and only the BUDGET keeps them apart.
  const entry = contextEntryFor(manifest, command);
  if (entry === undefined) {
    return {
      paths: [],
      degraded: true,
      reasons: [`'${command}' no está declarado en el manifiesto`],
    };
  }
  const reasons: string[] = [];
  const unknownSignals = signals.filter((s) => !(s in manifest.signals));
  if (unknownSignals.length > 0) {
    reasons.push(`señales no declaradas: ${unknownSignals.join(", ")}`);
  }
  const observed = new Set(signals);
  // An unknown signal means the caller knows something this bundle does not;
  // the safe reading of that is every module, not the ones we happened to match.
  const takeAll = unknownSignals.length > 0;
  const modules = entry.modules.filter((m) => takeAll || observed.has(m.signal));

  const paths: string[] = [];
  for (const path of [...entry.core, ...modules.map((m) => m.path)]) {
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths, degraded: reasons.length > 0, reasons };
}

export async function measureTree(fs: FileSystemPort, root: string): Promise<TreeIdentity> {
  const files = await listAllFiles(fs, root, "");
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(`${rel}:${await fileBytes(fs, join(root, rel))}\n`);
  }
  return {
    cli_version: readPackageVersion(),
    content_digest: hash.digest("hex").slice(0, 16),
    file_count: files.length,
  };
}

/** Core read-set cost of every command the manifest declares, no signal observed. */
export async function measureGuaranteed(
  fs: FileSystemPort,
  root: string,
  manifest: ContextManifest,
): Promise<GuaranteedEntry[]> {
  const out: GuaranteedEntry[] = [];
  for (const command of Object.keys(manifest.commands).sort()) {
    const files = resolveReadSet(manifest, command, []).paths;
    let bytes = 0;
    for (const rel of files) {
      const full = join(root, rel);
      if (await fs.exists(full)) bytes += await fileBytes(fs, full);
    }
    out.push({ command, bytes, files });
  }
  return out;
}

/** Every distinct module the manifest declares, counted once. */
export async function measureModules(
  fs: FileSystemPort,
  root: string,
  manifest: ContextManifest,
): Promise<ModulesMeasure> {
  const seen = new Set<string>();
  for (const entry of Object.values(manifest.commands)) {
    for (const module of entry.modules) seen.add(module.path);
  }
  let bytes = 0;
  for (const rel of seen) {
    const full = join(root, rel);
    if (await fs.exists(full)) bytes += await fileBytes(fs, full);
  }
  return { count: seen.size, bytes };
}

export async function measureBundle(
  fs: FileSystemPort,
  root: string,
  rootOrigin: string,
  manifest: ContextManifest,
): Promise<ContextMeasurement> {
  return {
    root,
    root_origin: rootOrigin,
    revision: await measureTree(fs, root),
    discovery: await measureDiscovery(fs, root),
    activation: await measureActivation(fs, root),
    execution: await measureExecution(fs, root, manifest),
    guaranteed: await measureGuaranteed(fs, root, manifest),
    modules: await measureModules(fs, root, manifest),
  };
}

async function listCommandDocs(fs: FileSystemPort, root: string): Promise<string[]> {
  const dir = join(root, COMMANDS_DIR);
  const entries = await fs.list(dir);
  return entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== COMMANDS_INDEX)
    .map((e) => `${COMMANDS_DIR}/${e.name}`)
    .sort();
}

/**
 * The description as the INSTALLER extracts it — `splitCommandDoc`, the single
 * parser every host wrapper already depends on. Measuring discovery with a
 * second parser of its own would budget a string no host ever renders.
 */
async function readDescription(fs: FileSystemPort, path: string): Promise<string> {
  return splitCommandDoc(await fs.readText(path)).description ?? "";
}

async function fileBytes(fs: FileSystemPort, path: string): Promise<number> {
  return byteLength(await fs.readText(path));
}

async function listAllFiles(fs: FileSystemPort, root: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.list(join(root, prefix))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.type === "dir") out.push(...(await listAllFiles(fs, root, rel)));
    else if (entry.type === "file") out.push(rel);
  }
  return out;
}
