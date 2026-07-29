import type { FileSystemPort } from "../../ports/file-system.js";
import { type ResolvedBundleRoot, resolveBundleRoot } from "./bundle-root.js";
import { type ContextManifest, loadManifest } from "./manifest.js";
import { type ContextMeasurement, measureBundle } from "./measure.js";

/**
 * `aw context-budget` — the instrument the context gates read.
 *
 * The command MEASURES; it never stores a number. Absolute targets are derived
 * at call time from a frozen baseline times the manifest's policy ratios, so no
 * figure a gate compares against was ever typed by hand — which is the whole
 * difference between a budget and the ceiling-that-gets-raised it replaces.
 */

export interface BudgetLine {
  /** What is being budgeted: `discovery`, `activation.median`, `journey.quick`, … */
  metric: string;
  actual: number;
  /** Absent when no baseline was supplied: then the run only reports. */
  baseline?: number;
  target?: number;
  ok?: boolean;
}

export interface ContextBudgetOutput extends ContextMeasurement {
  /** Where the frozen baseline came from, `null` when the run only measured. */
  baseline_path: string | null;
  baseline_revision: ContextMeasurement["revision"] | null;
  /** Bytes is the gate metric; tokens are declared unavailable, never estimated. */
  tokens: { available: false; reason: string };
  budget: readonly BudgetLine[];
  offenders: readonly string[];
  verdict: "measured" | "ok" | "over-budget";
}

export interface ContextBudgetInput {
  root?: string;
  baselinePath?: string;
}

export class BaselineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BaselineError";
  }
}

/** Why the receipt reports no token figure. Single wording for every surface. */
export const TOKENS_UNAVAILABLE =
  "ningún host de la matriz expone al agente el consumo real de tokens; el gate usa bytes y no infiere equivalencia";

export async function runContextBudget(
  fs: FileSystemPort,
  input: ContextBudgetInput = {},
): Promise<ContextBudgetOutput> {
  const resolved: ResolvedBundleRoot = await resolveBundleRoot(fs, input.root);
  const manifest = await loadManifest(fs, resolved.root);
  const measurement = await measureBundle(fs, resolved.root, resolved.origin, manifest);

  const baseline = await readBaseline(fs, input.baselinePath);
  const budget =
    baseline === null
      ? reportOnly(measurement)
      : deriveBudget(measurement, baseline, manifest.budgetPolicy);
  const offenders = budget.filter((line) => line.ok === false).map(describeOffender);

  return {
    ...measurement,
    baseline_path: input.baselinePath ?? null,
    baseline_revision: baseline?.revision ?? null,
    tokens: { available: false, reason: TOKENS_UNAVAILABLE },
    budget,
    offenders,
    verdict: baseline === null ? "measured" : offenders.length === 0 ? "ok" : "over-budget",
  };
}

/** The frozen baseline is a prior `aw context-budget` output; only its measurement half is read. */
export async function readBaseline(
  fs: FileSystemPort,
  path?: string,
): Promise<ContextMeasurement | null> {
  if (path === undefined) return null;
  let raw: string;
  try {
    raw = await fs.readText(path);
  } catch {
    throw new BaselineError("CONTEXT_BASELINE_MISSING", `no se pudo leer el baseline '${path}'`);
  }
  let parsed: Partial<ContextMeasurement>;
  try {
    parsed = JSON.parse(raw) as Partial<ContextMeasurement>;
  } catch (err) {
    throw new BaselineError(
      "CONTEXT_BASELINE_INVALID",
      `'${path}' no es JSON válido: ${(err as Error).message}`,
    );
  }
  // Every field `deriveBudget` dereferences is checked here, so a truncated
  // baseline fails with its own code instead of a TypeError three frames down.
  const missing = (["discovery", "activation", "execution", "guaranteed"] as const).filter(
    (key) => parsed[key] === undefined,
  );
  if (missing.length > 0) {
    throw new BaselineError(
      "CONTEXT_BASELINE_INVALID",
      `'${path}' no parece un baseline de contexto: falta ${missing.join(", ")}`,
    );
  }
  return parsed as ContextMeasurement;
}

function reportOnly(measurement: ContextMeasurement): BudgetLine[] {
  const lines: BudgetLine[] = [
    { metric: "discovery", actual: measurement.discovery.bytes },
    { metric: "activation.median", actual: measurement.activation.median },
    { metric: "execution.median", actual: measurement.execution.median },
  ];
  for (const entry of measurement.activation.entries) {
    lines.push({ metric: `activation.${entry.command}`, actual: entry.bytes });
  }
  for (const journey of measurement.execution.journeys) {
    lines.push({ metric: `journey.${journey.id}`, actual: journey.bytes });
  }
  for (const entry of measurement.guaranteed) {
    lines.push({ metric: `guaranteed.${entry.command}`, actual: entry.bytes });
  }
  lines.push({ metric: "modules.total", actual: measurement.modules.bytes });
  return lines;
}

export function deriveBudget(
  measurement: ContextMeasurement,
  baseline: ContextMeasurement,
  policy: ContextManifest["budgetPolicy"],
): BudgetLine[] {
  const lines: BudgetLine[] = [
    line(
      "discovery",
      measurement.discovery.bytes,
      baseline.discovery.bytes,
      policy.discovery_max_ratio,
    ),
    line(
      "activation.median",
      measurement.activation.median,
      baseline.activation.median,
      policy.activation_median_max_ratio,
    ),
    line(
      "execution.median",
      measurement.execution.median,
      baseline.execution.median,
      policy.execution_median_max_ratio,
    ),
  ];

  const baseActivation = new Map(baseline.activation.entries.map((e) => [e.command, e.bytes]));
  for (const entry of measurement.activation.entries) {
    const base = baseActivation.get(entry.command);
    // A command with no baseline row is new since the freeze: it is reported,
    // not judged. Inventing a target for it would be judging it against itself.
    if (base === undefined) {
      lines.push({ metric: `activation.${entry.command}`, actual: entry.bytes });
      continue;
    }
    lines.push(
      line(`activation.${entry.command}`, entry.bytes, base, policy.activation_each_max_ratio),
    );
  }

  const baseJourney = new Map(baseline.execution.journeys.map((j) => [j.id, j.bytes]));
  for (const journey of measurement.execution.journeys) {
    const base = baseJourney.get(journey.id);
    if (base === undefined) {
      lines.push({ metric: `journey.${journey.id}`, actual: journey.bytes });
      continue;
    }
    lines.push(line(`journey.${journey.id}`, journey.bytes, base, policy.journey_max_ratio));
  }

  const baseGuaranteed = new Map((baseline.guaranteed ?? []).map((g) => [g.command, g.bytes]));
  for (const entry of measurement.guaranteed) {
    const base = baseGuaranteed.get(entry.command);
    if (base === undefined) {
      lines.push({ metric: `guaranteed.${entry.command}`, actual: entry.bytes });
      continue;
    }
    lines.push(line(`guaranteed.${entry.command}`, entry.bytes, base, policy.journey_max_ratio));
  }

  // The conditional tree, budgeted directly. `baseline.modules` is frozen at the
  // revision that introduced it — no pre-split analogue exists, since before the
  // split there were no modules — so this line caps GROWTH, which is the hole it
  // was added to close.
  if (baseline.modules !== undefined) {
    lines.push(
      line(
        "modules.total",
        measurement.modules.bytes,
        baseline.modules.bytes,
        policy.journey_max_ratio,
      ),
    );
  }
  return lines;
}

function line(metric: string, actual: number, baseline: number, ratio: number): BudgetLine {
  const target = Math.floor(baseline * ratio);
  return { metric, actual, baseline, target, ok: actual <= target };
}

function describeOffender(entry: BudgetLine): string {
  return `${entry.metric}: ${entry.actual} B > techo ${entry.target} B (baseline ${entry.baseline} B)`;
}
