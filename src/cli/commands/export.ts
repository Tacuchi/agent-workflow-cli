import { PostgresReadonlyTools } from "../../adapters/postgres-readonly-tools.js";
import { DatabaseToolCatalog } from "../../application/database-tool-catalog.js";
import type { CatalogLookup } from "../../application/export-catalog-check.js";
import {
  type EnvironmentFilter,
  type ExportApplied,
  type ExportBase,
  type ExportCategory,
  type ExportPrepared,
  type ExportScope,
  type ExportSelection,
  type ExportValidation,
  applyExport,
  conflictingScopeFlags,
  prepareExport,
  readExportScope,
  validateExportWithCatalog,
} from "../../application/export-service.js";
import { type HubCommitProposal, runHubCommit } from "../../application/hub-commit-service.js";
import type { SemanticFailure } from "../../application/semantic-operation/protocol.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import { usageLine } from "../help-groups.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand, CommandFlags, CommandHelp, HumanRenderContext } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type ExportData =
  | { stage: "prepare"; prepared: ExportPrepared }
  | ({ stage: "validate" } & ExportValidation)
  | ({
      stage: "apply";
      commit_proposal?: HubCommitProposal;
      commit_proposal_error?: string;
    } & ExportApplied);

const PURPOSES: Record<ExportCategory, string> = {
  diagrams:
    "Export a diagram dossier (README plus textual sources in any notation) to docs/diagrams.",
  manuals:
    "Export manuals to docs/manuals or [docs] manuals: an INDEX.md alone (complement), flat <slug>.md files or a numbered dossier.",
  reports: "Export one bounded report to docs/reports.",
  scripts:
    "Consolidate SQL into a docs/scripts bundle: five forward categories plus rollbacks under rollback/; it NEVER executes SQL.",
};

/**
 * The answer envelope, published where an executor can read it WITHOUT running
 * the operation.
 *
 * Same reason as `aw flow`'s: the contract is enforced in
 * `semantic-operation/protocol.ts` and, until now, was documented nowhere — so
 * the only way to learn that the field is `state` and not `status` was to send
 * an answer without it and read `estado desconocido: undefined`, which names
 * the value and not the field. A contract only a failed attempt can teach
 * charges every executor the same tuition.
 *
 * Kept beside the command rather than in the doctrine bundle because the
 * bundle's context budget is a frozen gate and this is reference material: it
 * is read while composing an answer, not on every run.
 */
const ENVELOPE_NOTES = [
  "Envelope: one JSON object on stdin, fields at the TOP level. Required: version (the request's version), operation ('export-<category>', copied from the request), input_digest (the request's input_digest, verbatim), state (proposed | ambiguous | unsupported).",
  "proposed: artifacts [{path, content}], each path inside the request's allowed_destinations. scope: the request's scope copied VERBATIM, including scope.seal per key; it is the prepared scope (catalog too when requested), so validate and apply read it instead of re-deriving it and the scope flags need not be repeated. An added, removed or different key is rejected by name.",
  "ambiguous / unsupported: reason, why it cannot be decided or does not apply. Nothing is written.",
] as const;

/** export-scripts only: the bundle manifest is the CLI's, never an artifact. */
const SCRIPTS_ENVELOPE_NOTE =
  "scripts: decisions {supersedes: [names], requires: [names]}. The CLI generates bundle.json from those names and every source file, and includes it in the preview and the approval; never send it in artifacts.";

/**
 * The four exports are the same command with a different policy: same stages,
 * same validation, same authorization. Only the category changes, which is why
 * they are built here instead of copied four times.
 */
/**
 * The scope flags travel on every stage (a later stage refuses one that
 * contradicts the envelope); the approval and the overwrite only mean something
 * where the publication happens.
 */
function exportFlags(category: ExportCategory): CommandFlags {
  const scope = ["sessions", "since", "source", "date"];
  return {
    known:
      category === "scripts"
        ? [...scope, "from", "exclude", "environment", "code", "catalog"]
        : scope,
    repeatable: category === "scripts" ? ["exclude"] : [],
    actions: {
      apply: {
        known: category === "manuals" ? ["approval", "overwrite"] : ["approval"],
        required: ["approval"],
      },
      prepare: { known: [] },
      validate: { known: [] },
    },
  };
}

function exportHelp(category: ExportCategory): CommandHelp {
  const envelope =
    category === "scripts" ? [...ENVELOPE_NOTES, SCRIPTS_ENVELOPE_NOTE] : ENVELOPE_NOTES;
  return {
    purpose: PURPOSES[category],
    flags: {
      sessions: { value: "<a,b>", effect: "Only the material of these sessions, comma separated." },
      since: { value: "<YYYY-MM-DD>", effect: "Only sessions from this date on." },
      source: { value: "<alias>", effect: "Only the material of this source." },
      date: {
        value: "<YYYY-MM-DD>",
        effect: "Day that names the published unit; defaults to today.",
      },
      ...(category === "scripts"
        ? {
            from: {
              value: "<sessions|bundles|hub>",
              effect:
                "Base of the material: session SQL (default), the bundles docs/scripts already published, or everything the hub holds.",
            },
            exclude: {
              value: "<name>",
              effect: "Leave this piece out of the material, by its inventory name.",
            },
            environment: {
              value: "<environment>",
              effect:
                "Destination environment: bundles the release book records as applied there drop out.",
            },
            code: {
              value: "<code>",
              effect: "Active session that owns the bundle number reservation.",
            },
            catalog: {
              value: "<connection>",
              effect: "Check tables and columns read-only against this database connection.",
            },
          }
        : {}),
    },
    notes: [
      "Stages: prepare returns the request; the agent answers it; validate checks the answer and returns the approval digest; apply publishes with that digest. Each stage rebuilds the request from the hub, so a session that moved meanwhile makes the answer stale. It writes ONLY to its own folder and never creates a session.",
    ],
    actions: {
      prepare: {
        purpose:
          "Build the export request: destination, material inventory, contract and input digest; writes nothing.",
        output:
          '{stage: "prepare", prepared {category, request (the semantic request: version, operation, input_digest, scope, allowed_destinations, inventory, read_set, contract, metrics), dir, scope, next, unit, ...}}.',
      },
      validate: {
        purpose:
          "Check the answer envelope from stdin and return its preview and approval digest; writes nothing.",
        output:
          '{stage: "validate", preview {category, destination, files[] ({path, bytes}), overwrites, replacements?, mode?, unverified?}, approval_digest}.',
        notes: envelope,
      },
      apply: {
        purpose:
          "Publish the validated answer from stdin, approved by the digest validate returned.",
        flags: {
          approval: {
            value: "<digest>",
            effect: "The approval_digest validate returned; a flag, never inside the envelope.",
          },
          ...(category === "manuals"
            ? { overwrite: { effect: "Allow replacing an existing manual file; never implicit." } }
            : {}),
        },
        output:
          '{stage: "apply", category, written[], commit_proposal? (the hub commit offer for the written paths), commit_proposal_error?}.',
        notes: ["The same envelope validate accepted goes on stdin again."],
      },
    },
  };
}

/** The error action of a malformed export invocation: its usage, generated from its contract. */
function usageAction(category: ExportCategory, stage?: string): { action: string } {
  const command = {
    name: `export-${category}`,
    flags: exportFlags(category),
    help: exportHelp(category),
  };
  return { action: `uso: \`${usageLine(command, stage)}\`` };
}

function exportCommand(category: ExportCategory): CliCommand<ExportData> {
  return {
    name: `export-${category}`,
    flags: exportFlags(category),
    help: exportHelp(category),

    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ExportData>> {
      const stage = args.rest[0];
      if (stage !== "prepare" && stage !== "validate" && stage !== "apply") {
        return failSemantic({
          code: "ARGS_INVALID",
          message: `uso: aw export-${category} prepare | validate | apply --approval <digest>`,
          ...usageAction(category),
        });
      }

      // stdin FIRST on the later stages: the answer carries the scope its
      // proposal was written against, and rebuilding the request without it is
      // what used to reject a perfectly current answer as stale.
      const raw = stage === "prepare" ? "" : await readRequiredStdin();
      const scope = resolveStageScope(stage, raw, args);
      if (!scope.ok) return failSemantic(scope.failure);
      const catalog = exportCatalog(category, scope.selection, ctx);

      // Each stage rebuilds the request from the hub: stateless, and the
      // corpus digest is what detects a session that moved meanwhile.
      const prepared = await prepareExport(
        ctx.fs,
        ctx.env,
        ctx.paths,
        category,
        scope.selection,
        undefined,
        catalog,
      );
      if (!prepared.ok) return failSemantic(prepared.failure);

      if (stage === "prepare") {
        return { ok: true, data: { stage: "prepare", prepared: prepared.value }, exitCode: 0 };
      }
      return stage === "validate"
        ? await runValidate(raw, prepared.value, catalog)
        : await runApply(args, ctx, raw, prepared.value, catalog);
    },

    renderHuman(result: CommandResult<ExportData>, context: HumanRenderContext): string {
      const data = result.data;
      if (data === undefined) return "";
      if (data.stage === "prepare") return renderPrepare(category, data.prepared, context);
      if (data.stage === "validate") {
        return renderValidatedExport(category, data);
      }
      const lines = [
        `export-${category} · publicados ${data.written.length} archivo(s):`,
        ...data.written.map((w) => `  ${w}`),
      ];
      if (data.commit_proposal) {
        lines.push(`  Commit propuesto: ${data.commit_proposal.message}`);
        for (const path of data.commit_proposal.paths) lines.push(`    ${path}`);
        lines.push(
          `  aw hub-commit apply --export ${data.written[0]?.split("/").slice(0, 3).join("/")} --approval ${data.commit_proposal.approval}`,
        );
      } else if (data.commit_proposal_error)
        lines.push(`  Commit no disponible: ${data.commit_proposal_error}`);
      return `${lines.join("\n")}\n`;
    },
  };
}

/**
 * What `prepare` resolved, for a person: where it publishes, what the material
 * came from, and what it left out.
 *
 * The exclusions are listed one by one with their reason, because an exclusion
 * somebody asked for and one the release book imposed look identical in the
 * resulting bundle and only the first is something the person can take back.
 * A name that subtracted nothing is printed too: it is the only place a typo in
 * `--exclude` becomes visible before the bundle carries the piece anyway.
 */
function renderPrepare(
  category: ExportCategory,
  prepared: ExportPrepared,
  context: HumanRenderContext,
): string {
  const request = prepared.request;
  const inventory = request.inventory as {
    origins?: string[];
    excluded?: Array<{ name: string; reason: string }>;
    exclude_unmatched?: string[];
    environment?: EnvironmentFilter | null;
    unbundled_sql?: Array<{ name: string }>;
    bundle_warnings?: Array<{ code: string; bundle: string; detail: string }>;
    available_bundles?: string[];
  };
  const lines = [
    `export-${category} · prepare (${request.metrics.request_bytes} B)`,
    `  Destino    ${prepared.unit}`,
    `  Origen     ${(inventory.origins ?? []).join(" + ")}`,
    `  Material   ${request.read_set.length} pieza(s)`,
    `  Digest     ${request.input_digest.slice(0, 12)}…`,
    ...(inventory.environment
      ? [`  Ambiente   ${describeEnvironment(inventory.environment)}`]
      : []),
    ...(inventory.excluded ?? []).map((piece) => `  Fuera      ${piece.name} (${piece.reason})`),
    ...(inventory.exclude_unmatched ?? []).map(
      (name) => `  Sin efecto ${name} (--exclude no encontró ninguna pieza con ese nombre)`,
    ),
    ...(inventory.bundle_warnings ?? []).map(
      (warning) => `  ${warning.code} ${warning.bundle}: ${warning.detail}`,
    ),
    ...(inventory.unbundled_sql ?? []).map(
      (file) =>
        `  SQL suelto ${file.name}: incluir con aw export-scripts prepare --from hub${(inventory.available_bundles ?? []).map((name) => ` --exclude ${name}`).join("")}`,
    ),
  ];
  if (context.detail) lines.push("", request.contract);
  return `${lines.join("\n")}\n`;
}

/**
 * What the environment filter did, said so it cannot be misread.
 *
 * "No record" and "nothing was applied" are different answers and only one of
 * them is a fact about the world, so the line says which one it is — and when
 * the material held no bundle to look at, it says that instead of letting an
 * empty exclusion list pass for a verdict.
 */
function describeEnvironment(filter: EnvironmentFilter): string {
  if (filter.axis === "no-record") {
    return `${filter.name} — el libro de pases no registra ninguna aplicación en este ambiente (no es lo mismo que nada aplicado)`;
  }
  if (filter.scanned === 0) {
    return `${filter.name} — no había bundles en el material: el SQL que todavía vive en una sesión nunca puede constar aplicado`;
  }
  return `${filter.name} — ${filter.excluded} de ${filter.scanned} bundle(s) quedan fuera por constar aplicados`;
}

type StageScope =
  | { ok: true; selection: ExportSelection }
  | { ok: false; failure: SemanticFailure };

/**
 * What this stage should prepare over: the scope the answer echoes when there
 * is one, the invocation's own flags otherwise.
 */
function resolveStageScope(stage: string, raw: string, args: ParsedArgs): StageScope {
  const flags = selection(args);
  if (stage === "prepare") return { ok: true, selection: flags };

  const echoed = readExportScope(raw);
  if (!echoed.ok) return echoed;
  if (echoed.value === null) return { ok: true, selection: flags };

  const conflicts = conflictingScopeFlags(echoed.value, flags);
  if (conflicts.length > 0) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_SCOPE_CONFLICT",
        message: `${conflicts.join(" y ")} contradice(n) el alcance con el que se preparó (${describeScope(echoed.value)})`,
        action: `quitá los flags de alcance en ${stage}: el sobre ya trae el alcance de la preparación`,
      },
    };
  }
  return { ok: true, selection: echoed.value };
}

function describeScope(scope: ExportScope): string {
  const parts = [
    ...(scope.sessions === undefined ? [] : [`--sessions ${scope.sessions.join(",")}`]),
    ...(scope.since === undefined ? [] : [`--since ${scope.since}`]),
    ...(scope.source === undefined ? [] : [`--source ${scope.source}`]),
    ...(scope.code === undefined ? [] : [`--code ${scope.code}`]),
    ...(scope.catalog === undefined ? [] : [`--catalog ${scope.catalog}`]),
    ...(scope.from === undefined ? [] : [`--from ${scope.from}`]),
    ...(scope.exclude ?? []).map((name) => `--exclude ${name}`),
    ...(scope.environment === undefined ? [] : [`--environment ${scope.environment}`]),
    `--date ${scope.date}`,
  ];
  return parts.join(" ");
}

async function runValidate(
  raw: string,
  prepared: ExportPrepared,
  catalog?: CatalogLookup,
): Promise<CommandResult<ExportData>> {
  const result = await validateExportWithCatalog(raw, prepared, catalog);
  if (!result.ok) return failSemantic(result.failure);
  return { ok: true, data: { stage: "validate", ...result.value }, exitCode: 0 };
}

async function runApply(
  args: ParsedArgs,
  ctx: CliContext,
  raw: string,
  prepared: ExportPrepared,
  catalog?: CatalogLookup,
): Promise<CommandResult<ExportData>> {
  const approval = args.values.get("approval");
  if (approval === undefined) {
    return failSemantic({
      code: "ARGS_INVALID",
      message: "apply exige --approval <digest>: el que devolvió validate",
      ...usageAction(prepared.category, "apply"),
    });
  }
  const result = await applyExport(
    ctx.fs,
    ctx.env,
    ctx.paths,
    {
      raw,
      prepared,
      approval,
      // Replacing the category's overwritable file is never implicit.
      allowOverwrite: args.flags.has("--overwrite"),
    },
    catalog,
  );
  if (!result.ok) return failSemantic(result.failure);
  const destination = result.value.written[0]?.split("/").slice(0, 3).join("/");
  const offer = destination
    ? await runHubCommit(ctx.fs, ctx.git, ctx.process, ctx.paths, {
        exportPath: destination,
      })
    : { error: "el export no informó sus rutas" };
  return {
    ok: true,
    data: {
      stage: "apply",
      ...result.value,
      ...("proposal" in offer
        ? { commit_proposal: offer.proposal }
        : { commit_proposal_error: offer.error }),
    },
    exitCode: 0,
  };
}

function selection(args: ParsedArgs): ExportSelection {
  const sessions = args.values.get("sessions");
  const since = args.values.get("since");
  // `source` is a MULTI_VALUE flag: `values.get` would silently miss it.
  const source = flagValue(args, "source");
  const date = args.values.get("date");
  const from = args.values.get("from");
  // `--exclude` is repeatable, so ALL its occurrences count: `flagValue` returns
  // the last one and would leave the rest inside the bundle.
  const exclude = (args.valuesMulti.get("exclude") ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const environment = args.values.get("environment");
  const code = args.values.get("code");
  const catalog = args.values.get("catalog");
  return {
    ...(sessions !== undefined
      ? {
          sessions: sessions
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      : {}),
    ...(since !== undefined ? { since } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(from !== undefined ? { from: from as ExportBase } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
  };
}

export const exportDiagramsCommand = exportCommand("diagrams");
export const exportManualsCommand = exportCommand("manuals");
export const exportReportsCommand = exportCommand("reports");
export const exportScriptsCommand = exportCommand("scripts");

function exportCatalog(
  category: ExportCategory,
  selection: ExportSelection,
  ctx: CliContext,
): CatalogLookup | undefined {
  const catalog: CatalogLookup | undefined =
    category === "scripts" && selection.catalog !== undefined
      ? new DatabaseToolCatalog({
          paths: ctx.paths,
          env: ctx.env,
          postgres: new PostgresReadonlyTools(),
        })
      : undefined;
  return catalog;
}

function renderValidatedExport(
  category: ExportCategory,
  data: Extract<ExportData, { stage: "validate" }>,
): string {
  const lines = [
    `export-${category} · propuesta validada — falta tu aprobación`,
    `  Destino    ${data.preview.destination}`,
  ];
  for (const file of data.preview.files) lines.push(`    ${file.path} (${file.bytes} B)`);
  for (const path of data.preview.replacements ??
    (data.preview.overwrites === null ? [] : [data.preview.overwrites])) {
    lines.push(`  REEMPLAZA  ${path} — exige --overwrite`);
  }
  for (const item of data.preview.unverified ?? []) lines.push(`  Sin verificar ${item}`);
  lines.push(`  Aprobación aw export-${category} apply --approval ${data.approval_digest}`, "");
  return lines.join("\n");
}
