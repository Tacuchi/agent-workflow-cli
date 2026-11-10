import {
  type SessionMigrationAnswers,
  applySessionMigration,
  commitSessionMigration,
  previewSessionMigration,
} from "../../application/hub-migrate/sessions.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

export type SessionMigrationOutput =
  | Awaited<ReturnType<typeof previewSessionMigration>>
  | { action: "sessions-apply"; [key: string]: unknown }
  | { action: "sessions-commit"; hash: string };

/**
 * `aw hub-migrate --documents`: the session model → the documents model (spec
 * 066, F7). Preview by default; `--apply --approval <d>` with the answers on
 * stdin; `--commit --approval <d>` for the single migration commit.
 */
export async function sessionsMigrationVerb(
  args: ParsedArgs,
  ctx: CliContext,
  stdin: () => Promise<string> = () => readRequiredStdin(),
): Promise<CommandResult<SessionMigrationOutput>> {
  const approval = args.values.get("approval");
  if (args.flags.has("--commit")) {
    if (approval === undefined || ctx.git === undefined) {
      return fail(
        "APPROVAL_REQUIRED",
        "--commit exige --approval <digest> de la propuesta",
        "aplicá la migración y citá el digest de su commit",
      );
    }
    const done = await commitSessionMigration(ctx.git, ctx.paths, { approval });
    return done.ok
      ? { ok: true, data: done.value, exitCode: 0 }
      : fail(done.failure.code, done.failure.message, done.failure.action);
  }
  if (!args.flags.has("--apply")) {
    return { ok: true, data: await previewSessionMigration(ctx.fs, ctx.paths), exitCode: 0 };
  }
  if (approval === undefined) {
    return fail(
      "APPROVAL_REQUIRED",
      "--apply exige --approval <digest> de la vista previa",
      "corré 'aw hub-migrate --documents' y aprobá su digest",
    );
  }
  let answers: SessionMigrationAnswers = {};
  const raw = (await stdin()).trim();
  if (raw !== "") {
    try {
      answers = JSON.parse(raw) as SessionMigrationAnswers;
    } catch {
      return fail(
        "INVALID_INPUT",
        "las respuestas de stdin no son JSON",
        'mandá {"plans": {...}, "sessions": {...}}',
      );
    }
  }
  const applied = await applySessionMigration(ctx.fs, ctx.git, ctx.paths, { approval, answers });
  return applied.ok
    ? { ok: true, data: applied.value, exitCode: 0 }
    : fail(applied.failure.code, applied.failure.message, applied.failure.action);
}

function fail<T>(code: string, message: string, action: string): CommandResult<T> {
  return failSemantic<T>({ code, message, action });
}
