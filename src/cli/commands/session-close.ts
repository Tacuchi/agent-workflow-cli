import { preserveBoundaryClose } from "../../application/flow/close-artifacts.js";
import {
  type CloseIntent,
  markCloseAtBoundary,
  settleCloseAtBoundary,
  withdrawCloseAtBoundary,
} from "../../application/flow/close-at-boundary.js";
import {
  type FlowRunLocation,
  locateRun,
  readRun,
} from "../../application/flow/run-state-service.js";
import {
  type IsolationReader,
  type SessionCloseInput,
  type SessionCloseResult,
  runSessionClose,
} from "../../application/session-close-service.js";
import { resolveSessionTarget } from "../../application/session-resolver.js";
import { classifyListedUnits, runWorktree } from "../../application/worktree-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

// `--name` belongs to `session-create`, where it is mandatory; here it names
// nothing, and being ignored is how an invocation that meant something else
// came back as a clean close.
const FLAGS: CommandFlags = {
  known: ["code", "refs"],
  usage: "aw session-close --code <sesión> [--refs <csv>]",
};

export const sessionCloseCommand: CliCommand = {
  name: "session-close",
  flags: FLAGS,
  describe:
    "Close a session: write the .closed marker, release the conversation bindings pointing at it and upsert its HISTORY.md row. " +
    "A session whose flow run is still walking closes with the run finished at the boundary it stood on. " +
    "Usage: aw session-close --code <session> [--refs <csv>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCloseInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    const refs = args.values.get("refs");
    if (refs !== undefined) input.refs = refs;

    const location = await runLocation(ctx, code);
    const intent = location === null ? null : await markCloseAtBoundary(ctx.fs, location);
    if (intent?.kind === "failed") {
      // A run somebody else holds is a retry of THIS command, not of an advance.
      const action =
        intent.failure.code === "FLOW_RUN_LOCKED"
          ? `esperá a que termine y volvé a correr 'aw session-close --code ${code}'`
          : intent.failure.action;
      return fail(intent.failure.code, `la sesión no se cerró: ${intent.failure.message}`, {
        action,
      });
    }
    if (location === null || intent?.kind !== "marked") {
      // A repeated close still owns the proposal's bases, even after finalize
      // was settled and no new close intention is necessary.
      if (location !== null) {
        const read = await readRun(ctx.fs, location);
        if (!read.ok && read.failure.code !== "FLOW_RUN_ABSENT") {
          return fail(read.failure.code, read.failure.message);
        }
        input.preserveReservations = read.ok
          ? (read.state.proposal?.artifacts.filter((a) => a.reserved).map((a) => a.path) ?? [])
          : [];
      }
      return rendered(
        await runSessionClose(ctx.fs, ctx.paths, input, unitsOf(ctx), unitReleaser(ctx)),
      );
    }
    return closeAtBoundary(ctx, input, location, intent);
  },
};

/**
 * The close of a session whose run is still walking — steps 2 and 3, step 1
 * being the intention already recorded.
 *
 * The units are read BEFORE anything is written: the run's close conserves the
 * ones still held and says so, and an inventory nobody could read is exactly the
 * state that must not close in silence. A refusal takes back the intention this call recorded.
 */
async function closeAtBoundary(
  ctx: CliContext,
  input: SessionCloseInput,
  location: FlowRunLocation,
  intent: Extract<CloseIntent, { kind: "marked" }>,
): Promise<CommandResult> {
  const { boundary } = intent;
  const withdraw = (refusal: CommandResult) => withdrawn(ctx, location, intent, refusal);
  let inventory: Awaited<ReturnType<IsolationReader>>;
  try {
    inventory = await unitsOf(ctx)();
  } catch (error) {
    return withdraw(
      fail(
        "SESSION_UNITS_UNREADABLE",
        `la sesión no se cerró: no se pudieron leer sus unidades de aislamiento — ${error instanceof Error ? error.message : String(error)}`,
        {
          action: `revisá el estado de git con 'aw worktree list' y volvé a correr 'aw session-close --code ${location.session}'`,
        },
      ),
    );
  }
  const units = Array.isArray(inventory) ? inventory : inventory.units;
  const unreadable = Array.isArray(inventory) ? [] : inventory.unreadable;
  let data: SessionCloseResult;
  let pending: string[] = [];
  try {
    const read = await readRun(ctx.fs, location);
    if (!read.ok) return withdraw(fail(read.failure.code, read.failure.message));
    pending = await preserveBoundaryClose(
      ctx.fs,
      ctx.paths,
      ctx.git,
      read.state,
      units,
      unreadable,
    );
    data = await runSessionClose(
      ctx.fs,
      ctx.paths,
      {
        ...input,
        final: false,
        preserveReservations:
          read.state.proposal?.artifacts.filter((a) => a.reserved).map((a) => a.path) ?? [],
      },
      async () => inventory,
      unitReleaser(ctx),
    );
  } catch (error) {
    // The close's own error is the one worth reporting; a failed withdraw here
    // would only hide it, and re-running the close resumes either way.
    if (intent.wrote) await withdrawCloseAtBoundary(ctx.fs, location).catch(() => null);
    throw error;
  }
  if (!("sessionClose" in data)) return withdraw(rendered(data));
  data.sessionClose.pending_work = pending;
  data.sessionClose.reopen = `aw session-resume --code ${location.session} --reopen`;
  const settled = await settleCloseAtBoundary(ctx.fs, location, data.sessionClose);
  if (settled !== null) {
    return fail(
      settled.code,
      `la sesión cerró, pero la corrida no asentó su finalize en '${boundary}': ${settled.message}`,
      { ...data.sessionClose, action: retry(location) },
    );
  }
  return {
    ok: true,
    data: { ...data.sessionClose, run: { closed_at: boundary, finalize: "applied" } },
    exitCode: 0,
  };
}

function retry(location: FlowRunLocation): string {
  return `volvé a correr 'aw session-close --code ${location.session}': retoma el cierre donde quedó`;
}

/**
 * The refusal, once the intention is taken back — or, when even that failed, a
 * refusal that says the run still stands on the close's finalize, because
 * reporting only the first would leave an `advance` free to close the session
 * the person was just told stayed open.
 */
async function withdrawn(
  ctx: CliContext,
  location: FlowRunLocation,
  intent: Extract<CloseIntent, { kind: "marked" }>,
  refusal: CommandResult,
): Promise<CommandResult> {
  if (!intent.wrote) return refusal;
  const failure = await withdrawCloseAtBoundary(ctx.fs, location);
  if (failure === null || refusal.error === undefined) return refusal;
  return fail(
    refusal.error.code,
    `${refusal.error.message} — y la corrida quedó parada en el finalize del cierre`,
    {
      ...(typeof refusal.data === "object" && refusal.data !== null ? refusal.data : {}),
      run_withdraw_error: failure,
      action: retry(location),
    },
  );
}

/** The run of the session `code` names, or `null` when nothing resolves. */
async function runLocation(
  ctx: CliContext,
  code: string | undefined,
): Promise<FlowRunLocation | null> {
  if (code === undefined) return null;
  // The same resolution the close itself makes, so the two cannot name different
  // sessions and send a walking run down the path that ignores it.
  const resolution = await resolveSessionTarget(ctx.fs, ctx.paths, {
    code,
    allowClosed: true,
    intent: "write",
  });
  return resolution.outcome === "resolved" ? locateRun(ctx.paths, resolution.session.folder) : null;
}

/**
 * The workspace's live units. A close that stayed silent about the units the
 * session still holds would be the one way a flow's uncommitted-upstream work
 * disappears from view.
 */
function unitsOf(ctx: CliContext): IsolationReader {
  return async () => {
    const listed = await runWorktree(
      { fs: ctx.fs, env: ctx.env, git: ctx.git, paths: ctx.paths },
      { action: "list" },
    );
    // Never the reassuring half: an unreadable list comes back as the error the
    // receipt reports, not as "this session held nothing".
    if (!("units" in listed)) throw new Error(JSON.stringify(listed));
    return {
      units: await classifyListedUnits(
        { fs: ctx.fs, env: ctx.env, git: ctx.git, paths: ctx.paths },
        listed.units,
      ),
      unreadable: listed.unreadable ?? [],
    };
  };
}

function unitReleaser(ctx: CliContext) {
  return async (alias: string, folder: string) => {
    const result = await runWorktree(
      { fs: ctx.fs, env: ctx.env, git: ctx.git, paths: ctx.paths },
      { action: "release", alias, sessionCode: folder },
    );
    if ("error" in result || "released" in result) return result;
    return { error: "unit_unresolved", message: `no se pudo liberar ${alias} de ${folder}` };
  };
}

function rendered(data: SessionCloseResult): CommandResult {
  if ("sessionError" in data) return failSessionResolution(data.sessionError);
  if ("error" in data) return fail(data.code ?? "INVALID_INPUT", data.error, data);
  // Unreachable from here on purpose: this surface never asks for the refusal
  // (see `requireIntegrated`). It is handled rather than cast away so the day
  // somebody wires the flag through, the command answers with the remedy
  // instead of crashing on a shape it never expected.
  if ("sessionHeld" in data) {
    return fail("SESSION_UNITS_PENDING", data.sessionHeld.reason, data.sessionHeld);
  }
  return { ok: true, data: data.sessionClose, exitCode: 0 };
}
