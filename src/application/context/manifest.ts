import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";

/**
 * The context graph of the `w` bundle.
 *
 * It lives INSIDE the bundle (`skills/w/context/MANIFEST.json`), not in `src/`.
 * A receipt has to describe the tree the agent actually reads: shipping the
 * graph with the doctrine it describes is what makes a hand-installed or
 * half-updated bundle report itself honestly instead of being described by
 * whatever the CLI happens to believe. The cost of that choice is parsing and
 * validating at load time, which is what this module is.
 */

export interface ContextModule {
  /** Bundle-relative path of the module document. */
  path: string;
  /** Signal id that activates it; absent from the read-set until observed. */
  signal: string;
  /**
   * Host capability this module's behavior depends on, named as
   * `harness/HARNESS.md` names it. When the caller does not declare it, the
   * compact route cannot promise the same result, and the resolver widens.
   */
  requires?: string;
}

export interface ContextCommandEntry {
  /** Always loaded, in order. */
  core: readonly string[];
  /** Loaded only when their signal is observed. */
  modules: readonly ContextModule[];
}

export interface ContextJourney {
  id: string;
  label: string;
  command: string;
  signals: readonly string[];
}

export interface BudgetPolicy {
  discovery_max_ratio: number;
  activation_median_max_ratio: number;
  activation_each_max_ratio: number;
  execution_median_max_ratio: number;
  /** Ceiling on a journey's normal path, and on the conditional tree's growth. */
  journey_max_ratio: number;
}

export interface ContextManifest {
  version: number;
  signals: Readonly<Record<string, string>>;
  /**
   * Vocabulary the AGENT may declare at a flow boundary, id → what it means.
   *
   * It lives next to the context signals rather than in a catalog of its own for
   * one reason: two catalogs of "what the agent may say" drift, and the day they
   * do, a threshold rule starts counting a signal the doctrine no longer names.
   * Absent in an older bundle — a flow boundary then admits no signal at all,
   * which is the fail-closed answer, never a permissive one.
   */
  flowSignals: Readonly<Record<string, string>>;
  commands: Readonly<Record<string, ContextCommandEntry>>;
  /**
   * Conformant CAPABILITIES, declared next to the commands and never among
   * them.
   *
   * They carry the same shape — a core plus modules under signals — because the
   * question is the same: what does this invocation have to load. What they are
   * NOT is commands: there is no `commands/<name>.md`, they never enter the
   * activation median, and the guard that pairs every command doc with its
   * manifest entry keeps meaning exactly what it meant. Filing a capability
   * under `commands` would have reclassified it as the single-pass command the
   * contract says it is not.
   */
  capabilities: Readonly<Record<string, ContextCommandEntry>>;
  journeys: readonly ContextJourney[];
  budgetPolicy: BudgetPolicy;
}

/** The entry that answers for a name, whichever side of the manifest it is on. */
export function contextEntryFor(
  manifest: ContextManifest,
  name: string,
): ContextCommandEntry | undefined {
  return manifest.commands[name] ?? manifest.capabilities[name];
}

export const MANIFEST_REL_PATH = join("context", "MANIFEST.json");

/** Supported manifest schema. A newer bundle is a load error, never a guess. */
const SUPPORTED_VERSION = 1;

const POLICY_KEYS: readonly (keyof BudgetPolicy)[] = [
  "discovery_max_ratio",
  "activation_median_max_ratio",
  "activation_each_max_ratio",
  "execution_median_max_ratio",
  "journey_max_ratio",
];

export class ManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

export async function loadManifest(
  fs: FileSystemPort,
  bundleRoot: string,
): Promise<ContextManifest> {
  const path = join(bundleRoot, MANIFEST_REL_PATH);
  if (!(await fs.exists(path))) {
    throw new ManifestError(
      "CONTEXT_MANIFEST_MISSING",
      `El bundle en '${bundleRoot}' no trae ${MANIFEST_REL_PATH}: no describe su propio grafo de contexto`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readText(path));
  } catch (err) {
    throw new ManifestError(
      "CONTEXT_MANIFEST_INVALID",
      `${MANIFEST_REL_PATH} no es JSON válido: ${(err as Error).message}`,
    );
  }
  return parseManifest(raw);
}

/** Exported for tests: the same validation, over an in-memory object. */
export function parseManifest(raw: unknown): ContextManifest {
  const root = asRecord(raw, "raíz del manifiesto");
  const version = root.version;
  if (version !== SUPPORTED_VERSION) {
    throw new ManifestError(
      "CONTEXT_MANIFEST_VERSION",
      `versión de manifiesto no soportada: ${String(version)} (esta CLI lee ${SUPPORTED_VERSION})`,
    );
  }

  const signals = readSignals(root.signals, "signals");
  const flowSignals =
    root.flow_signals === undefined ? {} : readSignals(root.flow_signals, "flow_signals");
  const commands = readCommands(root.commands, signals);
  const capabilities =
    root.capabilities === undefined ? {} : readCommands(root.capabilities, signals);
  const journeys = readJourneys(root.journeys, commands, signals);
  const budgetPolicy = readPolicy(root.budget_policy);

  return { version, signals, flowSignals, commands, capabilities, journeys, budgetPolicy };
}

function readSignals(raw: unknown, where: string): Record<string, string> {
  const record = asRecord(raw, where);
  const out: Record<string, string> = {};
  for (const [id, description] of Object.entries(record)) {
    if (id.startsWith("$")) continue;
    if (typeof description !== "string" || description.length === 0) {
      throw new ManifestError("CONTEXT_MANIFEST_INVALID", `${where} '${id}' sin descripción`);
    }
    out[id] = description;
  }
  return out;
}

function readCommands(
  raw: unknown,
  signals: Record<string, string>,
): Record<string, ContextCommandEntry> {
  const record = asRecord(raw, "commands");
  const out: Record<string, ContextCommandEntry> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const entry = asRecord(value, `commands.${name}`);
    const core = asStringArray(entry.core, `commands.${name}.core`);
    if (core.length === 0) {
      throw new ManifestError(
        "CONTEXT_MANIFEST_INVALID",
        `commands.${name}.core vacío: todo comando carga al menos su propio cuerpo`,
      );
    }
    out[name] = { core, modules: readModules(entry.modules, name, signals) };
  }
  if (Object.keys(out).length === 0) {
    throw new ManifestError("CONTEXT_MANIFEST_INVALID", "commands vacío");
  }
  return out;
}

function readModules(
  raw: unknown,
  command: string,
  signals: Record<string, string>,
): ContextModule[] {
  if (!Array.isArray(raw)) {
    throw new ManifestError(
      "CONTEXT_MANIFEST_INVALID",
      `commands.${command}.modules debe ser una lista`,
    );
  }
  return raw.map((item, index) => {
    const module = asRecord(item, `commands.${command}.modules[${index}]`);
    const path = module.path;
    const signal = module.signal;
    if (typeof path !== "string" || path.length === 0) {
      throw new ManifestError(
        "CONTEXT_MANIFEST_INVALID",
        `commands.${command}.modules[${index}].path ausente`,
      );
    }
    if (typeof signal !== "string" || !(signal in signals)) {
      throw new ManifestError(
        "CONTEXT_MANIFEST_INVALID",
        `commands.${command}.modules[${index}].signal '${String(signal)}' no está declarada en signals`,
      );
    }
    const requires = module.requires;
    if (requires !== undefined && (typeof requires !== "string" || requires.length === 0)) {
      throw new ManifestError(
        "CONTEXT_MANIFEST_INVALID",
        `commands.${command}.modules[${index}].requires debe nombrar una capacidad`,
      );
    }
    return requires === undefined ? { path, signal } : { path, signal, requires };
  });
}

function readJourneys(
  raw: unknown,
  commands: Record<string, ContextCommandEntry>,
  signals: Record<string, string>,
): ContextJourney[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ManifestError("CONTEXT_MANIFEST_INVALID", "journeys debe ser una lista no vacía");
  }
  return raw.map((item, index) => {
    const journey = asRecord(item, `journeys[${index}]`);
    const id = asNonEmptyString(journey.id, `journeys[${index}].id`);
    const label = asNonEmptyString(journey.label, `journeys[${index}].label`);
    const command = asNonEmptyString(journey.command, `journeys[${index}].command`);
    if (!(command in commands)) {
      throw new ManifestError(
        "CONTEXT_MANIFEST_INVALID",
        `journeys[${index}].command '${command}' no existe en commands`,
      );
    }
    const journeySignals = asStringArray(journey.signals, `journeys[${index}].signals`);
    for (const signal of journeySignals) {
      if (!(signal in signals)) {
        throw new ManifestError(
          "CONTEXT_MANIFEST_INVALID",
          `journeys[${index}].signals contiene '${signal}', no declarada en signals`,
        );
      }
    }
    return { id, label, command, signals: journeySignals };
  });
}

function readPolicy(raw: unknown): BudgetPolicy {
  const record = asRecord(raw, "budget_policy");
  const out = {} as BudgetPolicy;
  for (const key of POLICY_KEYS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ManifestError(
        "CONTEXT_MANIFEST_INVALID",
        `budget_policy.${key} debe ser un número positivo`,
      );
    }
    out[key] = value;
  }
  return out;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError("CONTEXT_MANIFEST_INVALID", `${where} debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new ManifestError("CONTEXT_MANIFEST_INVALID", `${where} debe ser una lista`);
  }
  return value.map((item, index) => asNonEmptyString(item, `${where}[${index}]`));
}

function asNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError("CONTEXT_MANIFEST_INVALID", `${where} debe ser un string no vacío`);
  }
  return value;
}
