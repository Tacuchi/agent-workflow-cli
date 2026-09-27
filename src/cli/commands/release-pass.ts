import {
  declarePass,
  derivePasses,
  linkArtifact,
  readReleasePasses,
  recordApplication,
  recordArrival,
  recordReversion,
  releasePassLedgerPath,
} from "../../application/release-pass-ledger.js";
import { ReleasePassError, isArrivalKind } from "../../domain/release-pass.js";
import type { CommandResult } from "../../domain/types.js";
import { type WorklineNodeId, nodeFromDocPath } from "../../domain/workline-node.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const USAGE = [
  "uso: release-pass [list] [--version <v>]",
  "     release-pass declare --version <v> --sources <alias,…> [--plans <NNN,…>] [--cause <texto>]",
  "     release-pass arrived --version <v> --source <alias> --kind <published-version|deployment|production-branch> --detail <hecho> [--date <ISO>]",
  "     release-pass applied --version <v> --environment <ambiente> --detail <hecho> [--date <ISO>]",
  "     release-pass revert --version <v> [--cause <texto>]",
  "     release-pass link --version <v> --artifact <ruta-relativa>",
].join("\n");

/**
 * The passes to production: declared, arrived at per source, reverted, and read
 * back.
 *
 * Its own surface because a pass is its own object, not a property of a plan. The
 * axis it carries — is this in production? — is independent of the closure axis
 * the board already had, and folding it into `status` would have buried the one
 * distinction the whole record exists to draw: closed is not released.
 *
 * Nothing here checks the world. Registering an arrival is DECLARING a fact
 * somebody already knows; querying a package registry or a live host would make
 * the record depend on network reachability to say it.
 */
export const releasePassCommand: CliCommand = {
  name: "release-pass",
  flags: {
    known: ["version"],
    actions: {
      declare: { known: ["sources", "plans", "cause"] },
      arrived: { known: ["source", "kind", "detail", "date"] },
      applied: { known: ["environment", "detail", "date"] },
      revert: { known: ["cause"] },
      link: { known: ["artifact"] },
    },
  },
  describe:
    "Passes to production as first-class objects: which plans travelled together, over which sources, and whether each source actually arrived. 'release-pass declare --version <v> --sources <a,b>' opens one — the version NAMES it and is not any source's arrival fact, and the order between passes is the book's sequence, never a comparison of names. 'release-pass arrived --source <alias> --kind <…> --detail <hecho>' registers one source's arrival; with a second source still missing the pass reads partially released, naming both, and the missing source's work never reads as released. 'release-pass applied --environment <ambiente> --detail <hecho>' registers that the SQL this pass carries RAN there — its own axis, never a fourth arrival kind, so the release axis does not move and a pass with no such record reads as NO RECORD rather than as nothing applied. 'release-pass revert' adds a reversion that never erases the arrivals it follows. 'release-pass link --artifact <ruta>' attaches a document by workspace-relative path, checking only that it exists — never opening, moving, renumbering or executing it. The book is append-only under the workspace namespace. Usage: aw release-pass [list] | declare | arrived | applied | revert | link.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verb = args.rest[0] ?? "list";
    try {
      if (verb === "list") return await list(args, ctx);
      if (verb === "declare") return await declare(args, ctx);
      if (verb === "arrived") return await arrived(args, ctx);
      if (verb === "applied") return await applied(args, ctx);
      if (verb === "revert") return await revert(args, ctx);
      if (verb === "link") return await link(args, ctx);
    } catch (error) {
      if (error instanceof ReleasePassError) {
        return fail(error.code, error.message, { error: error.message });
      }
      throw error;
    }
    return fail("INVALID_INPUT", USAGE, { error: USAGE });
  },
};

async function list(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const read = await readReleasePasses(ctx.fs, ctx.paths);
  const passes = derivePasses(read.events);
  const wanted = flagValue(args, "version");
  const shown = wanted === undefined ? passes : passes.filter((p) => p.pass.version === wanted);
  if (wanted !== undefined && shown.length === 0) {
    return fail("RELEASE_PASS_UNKNOWN", `no hay ningún pase declarado con la versión '${wanted}'`, {
      error: `no hay ningún pase declarado con la versión '${wanted}'`,
    });
  }
  return {
    ok: true,
    data: {
      path: releasePassLedgerPath(ctx.paths),
      passes: shown,
      records: read.events.length,
      unreadable: read.unreadable,
    },
    exitCode: 0,
  };
}

async function declare(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const version = flagValue(args, "version");
  const sourcesRaw = flagValue(args, "sources");
  if (version === undefined || sourcesRaw === undefined) {
    return fail("INVALID_INPUT", USAGE, { error: USAGE });
  }
  const sources = splitList(sourcesRaw);
  const plans = planList(flagValue(args, "plans") ?? "");
  if (plans === null) {
    return fail("INVALID_INPUT", "--plans toma correlativos o rutas de plan separados por coma", {
      error: USAGE,
    });
  }
  const at = new Date().toISOString();
  const cause = flagValue(args, "cause");
  await declarePass(ctx.fs, ctx.paths, {
    at,
    pass: { version, plans, sources },
    ...(cause !== undefined ? { cause } : {}),
  });
  return await standingOf(ctx, version, { declared: true, at });
}

async function arrived(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const version = flagValue(args, "version");
  const source = flagValue(args, "source");
  const kind = flagValue(args, "kind");
  const detail = flagValue(args, "detail");
  if (version === undefined || source === undefined || detail === undefined) {
    return fail("INVALID_INPUT", USAGE, { error: USAGE });
  }
  if (!isArrivalKind(kind)) {
    const message =
      "--kind toma el hecho que constituye la llegada: published-version, deployment o production-branch";
    return fail("INVALID_INPUT", message, { error: message });
  }
  const known = await knownPass(ctx, version);
  if (known !== null) return known;
  const now = new Date().toISOString();
  // The arrival's own date is the fact's, and the record's is when it was
  // written. Defaulting the first to the second is honest; inferring it from
  // anything else would be inventing when something shipped.
  const at = flagValue(args, "date") ?? now;
  await recordArrival(ctx.fs, ctx.paths, {
    at: now,
    passVersion: version,
    arrival: { source, kind, detail, at },
  });
  return await standingOf(ctx, version, { arrived: source, at });
}

/**
 * Register that the SQL this pass carries RAN against an environment.
 *
 * Its own verb because it is its own axis: an environment is not one of the
 * pass's code sources, and reusing `arrived` for it would move the release axis
 * on a fact that says nothing about whether any source shipped.
 */
async function applied(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const version = flagValue(args, "version");
  const environment = flagValue(args, "environment");
  const detail = flagValue(args, "detail");
  if (version === undefined || environment === undefined || detail === undefined) {
    return fail("INVALID_INPUT", USAGE, { error: USAGE });
  }
  const named = environment.trim();
  if (named.length === 0) {
    const message =
      "--environment nombra el ambiente contra el que corrió el SQL: sin ambiente la constancia no dice dónde";
    return fail("INVALID_INPUT", message, { error: message });
  }
  const known = await knownPass(ctx, version);
  if (known !== null) return known;
  const now = new Date().toISOString();
  // Same split as an arrival: the application's own date is the fact's, and the
  // record's is when it was written.
  const at = flagValue(args, "date") ?? now;
  await recordApplication(ctx.fs, ctx.paths, {
    at: now,
    passVersion: version,
    application: { environment: named, detail, at },
  });
  return await standingOf(ctx, version, { applied: named, at });
}

async function revert(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const version = flagValue(args, "version");
  if (version === undefined) return fail("INVALID_INPUT", USAGE, { error: USAGE });
  const known = await knownPass(ctx, version);
  if (known !== null) return known;
  const at = new Date().toISOString();
  const cause = flagValue(args, "cause");
  await recordReversion(ctx.fs, ctx.paths, {
    at,
    passVersion: version,
    ...(cause !== undefined ? { cause } : {}),
  });
  return await standingOf(ctx, version, { reverted: true, at });
}

async function link(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const version = flagValue(args, "version");
  const artifact = flagValue(args, "artifact");
  if (version === undefined || artifact === undefined) {
    return fail("INVALID_INPUT", USAGE, { error: USAGE });
  }
  const known = await knownPass(ctx, version);
  if (known !== null) return known;
  const at = new Date().toISOString();
  const result = await linkArtifact(ctx.fs, ctx.paths, { at, passVersion: version, artifact });
  if (!result.linked)
    return fail("RELEASE_PASS_ARTIFACT_ABSENT", result.reason, { error: result.reason });
  return await standingOf(ctx, version, { linked: artifact, at });
}

/** Refuse before writing when the name is not a declared pass. `null` = it is. */
async function knownPass(ctx: CliContext, version: string): Promise<CommandResult | null> {
  const read = await readReleasePasses(ctx.fs, ctx.paths);
  const exists = derivePasses(read.events).some((p) => p.pass.version === version);
  if (exists) return null;
  const message = `no hay ningún pase declarado con la versión '${version}': declaralo antes de registrar nada contra él`;
  return fail("RELEASE_PASS_UNKNOWN", message, { error: message });
}

/** Every write answers with the pass's state derived again from its own facts. */
async function standingOf(
  ctx: CliContext,
  version: string,
  applied: Record<string, unknown>,
): Promise<CommandResult> {
  const read = await readReleasePasses(ctx.fs, ctx.paths);
  const derived = derivePasses(read.events).find((p) => p.pass.version === version);
  return {
    ok: true,
    data: { ...applied, version, pass: derived, path: releasePassLedgerPath(ctx.paths) },
    exitCode: 0,
  };
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function planList(raw: string): WorklineNodeId[] | null {
  const nodes: WorklineNodeId[] = [];
  for (const part of splitList(raw)) {
    if (/^\d{3,}$/.test(part)) {
      nodes.push({ kind: "plan", key: part });
      continue;
    }
    const node = nodeFromDocPath(part);
    if (node === null || node.kind !== "plan") return null;
    nodes.push(node);
  }
  return nodes;
}
