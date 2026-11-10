import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { approvalDigest } from "../doc-flow/doc-digest.js";
import { withPlanState } from "../doc-flow/doc-flow-service.js";
import { scanMarkdown } from "../markdown.js";
import { parsePhases } from "../parsers/phases.js";
import { type PlanStateValue, isPlanStateValue, parsePlanStatus } from "../parsers/plan-status.js";
import { parseTasks } from "../parsers/tasks.js";
import type { PathsService } from "../paths-service.js";
import { type CommitProposal, commitApproved, proposeCommit } from "../plan-run/commit-proposal.js";

/** What the session model left in a hub; the migration removes all of it (spec 066, D10). */
export function sessionModelResidue(paths: PathsService): string[] {
  const ns = `.${paths.namespace}`;
  return [`${ns}/sessions`, `${ns}/HISTORY.md`, `${ns}/claims.jsonl`, `${ns}/compactions`];
}

/** `true` while the hub still holds any record of the session model. */
export async function hubNeedsSessionMigration(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<boolean> {
  for (const rel of sessionModelResidue(paths).slice(0, 3)) {
    if (await fs.exists(join(paths.hubDir(), rel))) return true;
  }
  return false;
}

export type PlanMappingKind = "unchanged" | "deduced" | "needs-answer";

export interface PlanMapping {
  file: string;
  /** The `> Estado:` value as written, or `absent`. */
  from: string;
  /** The state it becomes; `null` while a person has to choose. */
  to: PlanStateValue | null;
  kind: PlanMappingKind;
  reason: string;
  /** The states a person may choose when `kind` is `needs-answer`. */
  choices: PlanStateValue[];
}

export interface SessionMigrationPreview {
  action: "sessions-preview";
  plans: PlanMapping[];
  /** Folders of `.<ns>/sessions/` without `.closed`: each needs the person's word. */
  active_sessions: string[];
  /** Hub-relative paths the migration deletes. */
  residue: string[];
  /** What the person approves together with their answers. */
  digest: string;
  next: string;
}

export interface SessionMigrationAnswers {
  plans?: Record<string, PlanStateValue>;
  /** Each active session acknowledged as abandoned (its changes stay in git status). */
  sessions?: Record<string, "abandon">;
}

export interface SessionMigrationFailure {
  code: string;
  message: string;
  action: string;
}

export type SessionMigrationResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: SessionMigrationFailure };

/**
 * The correspondence of ID01, deduced from each plan alone: `open` with no box
 * ticked is `ready`, `open` with some ticked is `in-progress`; `done` (with or
 * without its legacy suffix) stays `done` only when its boxes agree. Everything
 * else — `open` with every box ticked, `done` with open boxes, an unreadable
 * value — is a question for the person (AC-18): the migration never invents a
 * state.
 */
export function mapPlanState(file: string, text: string): PlanMapping {
  const status = parsePlanStatus(text);
  const from = status.declared === "absent" ? "absent" : status.declared;
  const base = { file, from, choices: [] as PlanStateValue[] };
  if (status.unmigrated === null && isPlanStateValue(status.declared)) {
    return { ...base, to: status.declared, kind: "unchanged", reason: "ya usa el contrato nuevo" };
  }
  const answer = legacyMapping(status.declared, parseTasks(text), parsePhases(text));
  return answer.to !== null
    ? { ...base, to: answer.to, kind: "deduced", reason: answer.reason }
    : { ...base, to: null, kind: "needs-answer", reason: answer.reason, choices: answer.choices };
}

/** ID01's correspondence for a session-model value; `to: null` asks the person. */
function legacyMapping(
  declared: string,
  tasks: { total: number; closed: number },
  phases: { total: number; validated: number },
): { to: PlanStateValue | null; reason: string; choices: PlanStateValue[] } {
  const all = tasks.total > 0 && tasks.closed === tasks.total;
  const deduced = (to: PlanStateValue, reason: string) => ({ to, reason, choices: [] });
  const ask = (reason: string, choices: PlanStateValue[]) => ({ to: null, reason, choices });
  if (declared === "done") {
    const validated = phases.total === 0 || phases.validated === phases.total;
    return all && validated
      ? deduced("done", "done con todas sus casillas y fases")
      : ask("declara done pero quedan casillas o fases sin cerrar", ["done", "in-progress"]);
  }
  if (declared !== "open" && declared !== "absent") {
    return ask("el estado declarado no se puede leer", [
      "draft",
      "ready",
      "in-progress",
      "done",
      "abandoned",
    ]);
  }
  if (tasks.total === 0) return ask("no tiene tareas que digan su avance", ["draft", "ready"]);
  if (tasks.closed === 0) return deduced("ready", "open sin avance");
  if (!all) return deduced("in-progress", "open con avance");
  return ask("declara open pero tiene todas sus casillas marcadas", ["done", "in-progress"]);
}

async function readPlans(
  fs: FileSystemPort,
  root: string,
): Promise<{ file: string; text: string }[]> {
  const dir = join(root, "docs", "plans");
  if (!(await fs.exists(dir))) return [];
  const out: { file: string; text: string }[] = [];
  for (const entry of await fs.list(dir)) {
    if (entry.type !== "file" || !/^\d{3,}-plan-.+\.md$/.test(entry.name)) continue;
    out.push({ file: `docs/plans/${entry.name}`, text: await fs.readText(entry.path) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

async function activeSessions(fs: FileSystemPort, paths: PathsService): Promise<string[]> {
  const dir = join(paths.hubDir(), `.${paths.namespace}`, "sessions");
  if (!(await fs.exists(dir))) return [];
  const out: string[] = [];
  for (const entry of await fs.list(dir)) {
    if (entry.type !== "dir" || entry.name.startsWith(".")) continue;
    if (!(await fs.exists(join(entry.path, ".closed")))) out.push(entry.name);
  }
  return out.sort();
}

/** The preview: every plan's correspondence, the active sessions and the residue. Writes nothing. */
export async function previewSessionMigration(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<SessionMigrationPreview> {
  const root = paths.hubDir();
  const plans = (await readPlans(fs, root)).map(({ file, text }) => mapPlanState(file, text));
  const active = await activeSessions(fs, paths);
  const residue: string[] = [];
  for (const rel of sessionModelResidue(paths)) {
    if (await fs.exists(join(root, rel))) residue.push(rel);
  }
  const digest = approvalDigest({
    plans: plans.map((plan) => `${plan.file}:${plan.from}:${plan.to ?? "?"}`).join("\n"),
    sessions: active.join("\n"),
    residue: residue.join("\n"),
  });
  return {
    action: "sessions-preview",
    plans,
    active_sessions: active,
    residue,
    digest,
    next: `aw hub-migrate --documents --apply --approval ${digest} < respuestas.json`,
  };
}

/**
 * Applies the migration with the person's answers: every doubtful plan and
 * every active session must be answered, and the approval must be the one the
 * preview showed — otherwise nothing is written (AC-18). It normalizes the plans,
 * deletes the residue, marks the hub and proposes ONE commit (AC-17).
 */
export async function applySessionMigration(
  fs: FileSystemPort,
  git: GitPort | undefined,
  paths: PathsService,
  input: { approval: string; answers: SessionMigrationAnswers },
): Promise<
  SessionMigrationResult<{
    action: "sessions-apply";
    plans: { file: string; to: PlanStateValue }[];
    removed: string[];
    commit: CommitProposal | null;
    next: string | null;
  }>
> {
  const preview = await previewSessionMigration(fs, paths);
  if (preview.digest !== input.approval) {
    return refuse(
      "HUB_MIGRATION_STALE",
      "el hub cambió desde la vista previa: la aprobación ya no vale",
      "corré 'aw hub-migrate --documents' otra vez y aprobá su digest",
    );
  }
  const missing = preview.plans.filter(
    (plan) =>
      plan.kind === "needs-answer" &&
      !plan.choices.includes(input.answers.plans?.[plan.file] as PlanStateValue),
  );
  const unanswered = preview.active_sessions.filter(
    (folder) => input.answers.sessions?.[folder] !== "abandon",
  );
  if (missing.length > 0 || unanswered.length > 0) {
    return refuse(
      "HUB_MIGRATION_ANSWER_REQUIRED",
      [
        ...missing.map(
          (plan) => `${plan.file}: elegí ${plan.choices.join(" | ")} (${plan.reason})`,
        ),
        ...unanswered.map(
          (folder) => `sesión activa ${folder}: cerrala con 30.1.0 antes, o respondé "abandon"`,
        ),
      ].join(" · "),
      'respondé cada caso por stdin: {"plans": {"<plan>": "<estado>"}, "sessions": {"<carpeta>": "abandon"}}',
    );
  }
  const root = paths.hubDir();
  const written: { file: string; to: PlanStateValue }[] = [];
  for (const plan of preview.plans) {
    if (plan.kind === "unchanged") continue;
    const to = plan.to ?? (input.answers.plans?.[plan.file] as PlanStateValue);
    const absolute = join(root, plan.file);
    await fs.writeText(absolute, normalizePlan(await fs.readText(absolute), to));
    written.push({ file: plan.file, to });
  }
  for (const rel of preview.residue) await fs.remove(join(root, rel));
  await markMigrated(fs, paths);
  const paths_ =
    git === undefined ? [] : await changedUnder(git, root, written, preview.residue, paths);
  const commit =
    git === undefined || paths_.length === 0
      ? null
      : await proposeCommit(git, {
          repo: root,
          message: "chore: migra el hub al modelo sin sesiones (Workline 31.0.0)",
          paths: paths_,
        });
  const proposal = commit?.ok ? commit.value : null;
  return {
    ok: true,
    value: {
      action: "sessions-apply",
      plans: written,
      removed: preview.residue,
      commit: proposal,
      next:
        proposal === null
          ? null
          : `aw hub-migrate --documents --commit --approval ${proposal.approval}`,
    },
  };
}

/** Commits exactly the migration's proposal, while its approval still describes the tree. */
export async function commitSessionMigration(
  git: GitPort,
  paths: PathsService,
  input: { approval: string },
): Promise<SessionMigrationResult<{ action: "sessions-commit"; hash: string }>> {
  const root = paths.hubDir();
  const changed = (await git.dirtyPaths(root)).map((entry) => entry.path);
  const proposal = await proposeCommit(git, {
    repo: root,
    message: "chore: migra el hub al modelo sin sesiones (Workline 31.0.0)",
    paths: changed.filter((path) => isMigrationPath(path, paths)),
  });
  if (!proposal.ok || proposal.value.approval !== input.approval) {
    return refuse(
      "COMMIT_PROPOSAL_STALE",
      "los archivos cambiaron desde la propuesta de la migración",
      "corré 'aw hub-migrate --documents' de nuevo para ver el estado",
    );
  }
  const done = await commitApproved(git, {
    repo: root,
    message: proposal.value.message,
    paths: proposal.value.paths.map((entry) => entry.path),
    approval: input.approval,
  });
  return done.ok
    ? { ok: true, value: { action: "sessions-commit", hash: done.value.hash } }
    : { ok: false, failure: done.failure };
}

function isMigrationPath(path: string, paths: PathsService): boolean {
  const ns = `.${paths.namespace}/`;
  return (
    /^docs\/plans\/\d{3,}-plan-.+\.md$/.test(path) ||
    path === `${ns}workline.json` ||
    sessionModelResidue(paths).some((rel) => path === rel || path.startsWith(`${rel}/`))
  );
}

async function changedUnder(
  git: GitPort,
  root: string,
  written: readonly { file: string }[],
  residue: readonly string[],
  paths: PathsService,
): Promise<string[]> {
  const wanted = new Set(written.map((plan) => plan.file));
  return (await git.dirtyPaths(root))
    .map((entry) => entry.path)
    .filter(
      (path) =>
        wanted.has(path) ||
        path === `.${paths.namespace}/workline.json` ||
        residue.some((rel) => path === rel || path.startsWith(`${rel}/`)),
    );
}

/** The single state value; a legacy suffix's date survives as `> Cierre:`. */
function normalizePlan(text: string, to: PlanStateValue): string {
  const status = parsePlanStatus(text);
  let out = withPlanState(text, to);
  const date = status.closure?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (to === "done" && date !== undefined && !/^>\s*Cierre\s*:/m.test(out)) {
    out = out.replace(/^(>\s*Estado\s*:\s*done)$/m, `$1\n> Cierre: ${date}`);
  }
  if (to === "in-progress" && parsePlanStatus(out).next_step === null) {
    const next = firstOpenTask(out);
    out = out.replace(/^(>\s*Estado\s*:\s*in-progress)$/m, `$1\n> Próximo paso: ${next}`);
  }
  return out;
}

function firstOpenTask(text: string): string {
  const { lines, fenced } = scanMarkdown(text);
  for (const [index, line] of lines.entries()) {
    if (fenced[index]) continue;
    const match = /^\s*[-*]\s*\[ \]\s+(.+)$/.exec(line);
    if (match?.[1]) return match[1].replace(/\s*_\([^)]*\)_\s*$/, "").trim();
  }
  return "validación final y cierre del plan";
}

async function markMigrated(fs: FileSystemPort, paths: PathsService): Promise<void> {
  const marker = paths.cwdMarkerFile();
  let data: Record<string, unknown> = { workline: 1, namespace: paths.namespace };
  try {
    data = JSON.parse(await fs.readText(marker)) as Record<string, unknown>;
  } catch {
    // An unreadable marker is rewritten whole.
  }
  data.model = "documents";
  await fs.writeText(marker, `${JSON.stringify(data, null, 2)}\n`);
}

function refuse<T>(code: string, message: string, action: string): SessionMigrationResult<T> {
  return { ok: false, failure: { code, message, action } };
}
