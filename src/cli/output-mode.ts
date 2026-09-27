import type { ParsedArgs } from "./parser.js";

/**
 * How the runtime projects a `CommandResult` onto stdout.
 *
 * There is ONE canonical result; `human` and `json` are two projections of it,
 * never two domains. The human view may filter what it shows — it never adds a
 * state, a candidate or an error the machine-readable model lacks.
 *
 * Resolution order, highest first:
 *
 * 1. `--format human|json` — the explicit declaration always wins.
 * 2. `--json` — shorthand for `--format json`; contradicting both is an error,
 *    not a silent precedence rule.
 * 3. `--detail` with no format — asking for the wide view IS asking for the
 *    human projection (the JSON model is already complete).
 * 4. TTY autodetect — a terminal reads human, a pipe keeps the JSON that
 *    current automation already parses.
 *
 * `--ascii` (or `AW_ASCII=1`) marks the human projection as ASCII-only. It never
 * picks the format and never touches JSON: an explicit `--json` with `--ascii`
 * is a contradiction and fails like `--detail`, while under the automatic JSON of
 * a pipe the mark simply does not apply. The variable is never refused — it is
 * set once per machine, not per invocation.
 *
 * Step 4 is why the default is not simply "human": every installed wrapper and
 * hook invokes the CLI through a pipe, and flipping those to prose would break
 * every consumer at once.
 */
export type OutputFormat = "human" | "json";

export interface OutputMode {
  format: OutputFormat;
  /** Widens the human projection only. Never reaches the JSON model. */
  detail: boolean;
  /** Human text (and help, and hook notices) in ASCII only. Never reaches the JSON model. */
  ascii: boolean;
}

export type OutputModeResolution = { ok: true; mode: OutputMode } | { ok: false; message: string };

const OUTPUT_FORMATS: readonly string[] = ["human", "json"];

/** The environment variable that turns the ASCII mark on for every invocation. */
export const ASCII_ENV = "AW_ASCII";

export function resolveOutputMode(
  args: ParsedArgs,
  isTTY: boolean,
  asciiEnv?: string,
): OutputModeResolution {
  const declared = readDeclaredFormat(args);
  if (!declared.ok) return declared;

  const detail = args.flags.has("--detail");
  if (detail && declared.format === "json") {
    return {
      ok: false,
      message: "--detail solo aplica a la salida humana: el modelo JSON ya es completo",
    };
  }

  const asciiFlag = args.flags.has("--ascii");
  if (asciiFlag && declared.format === "json") {
    return {
      ok: false,
      message: "--ascii solo aplica a la salida humana: el modelo JSON no se translitera",
    };
  }

  const format = declared.format ?? (detail || isTTY ? "human" : "json");
  return { ok: true, mode: { format, detail, ascii: asciiFlag || asciiEnv === "1" } };
}

type DeclaredFormat = { ok: true; format?: OutputFormat } | { ok: false; message: string };

/**
 * The format the invocation *declares*, or none. Contradictions fail here
 * rather than resolving by precedence: a caller who wrote both `--json` and
 * `--format human` has a bug, and silently honoring one hides it.
 */
function readDeclaredFormat(args: ParsedArgs): DeclaredFormat {
  const json = args.flags.has("--json");
  const raw = args.values.get("format");

  if (raw === undefined) {
    if (args.flags.has("--format")) {
      return { ok: false, message: "--format requiere un valor: human | json" };
    }
    return json ? { ok: true, format: "json" } : { ok: true };
  }

  if (!isOutputFormat(raw)) {
    return { ok: false, message: `--format debe ser human o json (got '${raw}')` };
  }
  if (json && raw !== "json") {
    return { ok: false, message: `--json contradice --format ${raw}: declará uno solo` };
  }
  return { ok: true, format: raw };
}

function isOutputFormat(value: string): value is OutputFormat {
  return OUTPUT_FORMATS.includes(value);
}
