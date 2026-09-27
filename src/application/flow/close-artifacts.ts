import { join } from "node:path";
import type { FlowRunState } from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import {
  type ProjectFuente,
  readWorkspaceBlock,
  requireSourcePath,
} from "../parsers/project-block.js";
import type { PathsService } from "../paths-service.js";
import type { IsolationReader } from "../session-close-service.js";

/** Preserve the run's unfinished work before the session marker makes it closed. */
export async function preserveBoundaryClose(
  fs: FileSystemPort,
  paths: PathsService,
  git: GitPort,
  state: FlowRunState,
  units: Extract<Awaited<ReturnType<IsolationReader>>, unknown[]>,
  unreadable: Array<{ alias: string; error: string; code?: string }> = [],
): Promise<string[]> {
  const boundary = state.reentries?.at(-1)?.transition ?? "chassis.finalize";
  const pending = [`Frontera pendiente: ${boundary}.`];
  if (state.handoff != null) {
    pending.push(
      `Escalación: seguí con ${state.handoff.command}; pedido y contexto conservados en el paquete de la corrida.`,
    );
  }
  const batch = state.flow === "plan-exec" ? state.batches?.at(-1) : undefined;
  const prefix = batch === undefined ? "" : `lote ${batch.iteration} (${batch.id}): `;
  const own = units.filter((unit) => unit.session === state.session);
  for (const unit of own) {
    const status =
      unit.dirty === true
        ? "sin commitear y sin integrar"
        : unit.dirty === false
          ? "sin integrar"
          : "sin integrar; no se pudo determinar si hay cambios sin commitear";
    pending.push(`${prefix}${unit.alias}: ${status} en ${unit.path} (${unit.branch}).`);
  }
  for (const source of unreadable.filter((item) => item.code === "SOURCE_PATH_MISSING")) {
    pending.push(`${prefix}${source.alias}: unidad no verificable; ${source.error}.`);
  }
  const unavailable = unreadable
    .filter((item) => item.code === "SOURCE_PATH_MISSING")
    .map((item) => item.alias);
  pending.push(
    ...(
      await uncommittedSources(fs, paths, git, state, [...own.map((u) => u.alias), ...unavailable])
    ).map((item) => `${prefix}${item}`),
  );
  if (state.proposal !== null) {
    pending.push(
      `Propuesta sin publicar conservada en la corrida: ${state.proposal.artifacts.map((a) => a.path).join(", ")}.`,
    );
  }
  const lines = [
    `Cierre solicitado en ${boundary}.`,
    ...pending.map((item) => `- ${item}`),
    `Reabrir: aw session-resume --code ${state.session} --reopen`,
  ];
  const folder = join(paths.cwdSessionsDir(), state.session);
  await writeCloseBlock(fs, join(folder, "CHECKPOINT.md"), "Pending / Next", lines);
  await writeCloseBlock(fs, join(folder, "BACKLOG.md"), "Deferred", lines);
  return pending;
}

async function uncommittedSources(
  fs: FileSystemPort,
  paths: PathsService,
  git: GitPort,
  state: FlowRunState,
  isolated: string[],
): Promise<string[]> {
  // Other sessions' units are not this run's work. Only its unisolated source
  // checkouts are observed here; git errors propagate rather than saying clean.
  const block = await readWorkspaceBlock(fs, paths.workspaceDir(), paths.blockMarkers());
  const sources: ProjectFuente[] = [
    { alias: "workspace", path: paths.workspaceDir(), main_branch: null },
    ...(block?.fuentes ?? []),
  ];
  const pending: string[] = [];
  for (const source of sources) {
    if (isolated.includes(source.alias)) continue;
    if (state.scope !== null && !state.scope.sources.includes(source.alias)) continue;
    let repo: string;
    try {
      repo = await requireSourcePath(fs, source);
    } catch (err) {
      pending.push(`${source.alias}: no verificable; ${(err as Error).message}.`);
      continue;
    }
    if (!(await git.isGitRepo(repo))) continue;
    if (state.flow === "plan-exec" && state.scope?.isolation === "in-place") {
      const declared = (state.batches ?? []).flatMap(
        (batch) =>
          batch.commit_proposal?.sources.find((item) => item.alias === source.alias)?.paths ?? [],
      );
      const own = (await git.dirtyPaths(repo))
        .filter((entry) => declared.includes(entry.path))
        .map((entry) => entry.path);
      if (own.length)
        pending.push(
          `${source.alias}: rutas de la corrida sin commitear en ${repo}: ${own.join(", ")}.`,
        );
      continue;
    }
    if (await git.isDirty(repo)) {
      pending.push(`${source.alias}: cambios sin commitear en ${repo}.`);
    }
  }
  return pending;
}

/** Replace only our block, preserving authored content and making retries idempotent. */
async function writeCloseBlock(
  fs: FileSystemPort,
  path: string,
  heading: string,
  lines: string[],
): Promise<void> {
  const start = "<!-- WORKLINE-CLOSE-START -->";
  const end = "<!-- WORKLINE-CLOSE-END -->";
  const block = `${start}\n${lines.join("\n")}\n${end}`;
  const previous = (await fs.exists(path)) ? await fs.readText(path) : "";
  const from = previous.indexOf(start);
  const to = previous.indexOf(end, from);
  if (from >= 0 && to >= from) {
    await fs.writeText(path, previous.slice(0, from) + block + previous.slice(to + end.length));
    return;
  }
  const section = `## ${heading}`;
  const sectionPattern = new RegExp(`^${section}\\s*$`, "m");
  const text =
    previous.trim().length > 0
      ? previous
      : `# ${heading === "Deferred" ? "BACKLOG" : "CHECKPOINT"}\n`;
  await fs.writeText(
    path,
    sectionPattern.test(text)
      ? text.replace(sectionPattern, () => `${section}\n\n${block}`)
      : `${text.trimEnd()}\n\n${section}\n\n${block}\n`,
  );
}
