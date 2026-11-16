import { join } from "node:path";
import { computeNoteDigest, validateDecisionNote } from "../domain/decision-note.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { acquireLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";

import {
  RETIRED_HEADING,
  RETIRED_INDEX_SCHEMA,
  RETIRED_MARKER_FILE,
  RETIRED_MARKER_KEY,
  RETIRED_NOTE_SCHEMA,
} from "../domain/retired-name.js";

export async function retiredNameState(fs: FileSystemPort, paths: PathsService) {
  const oldPath = join(paths.cwdRoot(), RETIRED_MARKER_FILE);
  const old = (await fs.exists(oldPath)) ? JSON.parse(await fs.readText(oldPath)) : null;
  const current = (await fs.exists(paths.cwdMarkerFile()))
    ? JSON.parse(await fs.readText(paths.cwdMarkerFile()))
    : null;
  const agents = join(paths.hubDir(), "AGENTS.md");
  const heading = (await fs.exists(agents)) && hasRetiredHeading(await fs.readText(agents), paths);
  return {
    marker: old !== null,
    heading,
    conflict:
      old !== null &&
      current !== null &&
      JSON.stringify(normalizeMarker(old)) !== JSON.stringify(normalizeMarker(current)),
  };
}

function normalizeMarker(value: Record<string, unknown>): Record<string, unknown> {
  const { [RETIRED_MARKER_KEY]: retired, ...rest } = value;
  return Object.fromEntries(
    Object.entries({ ...rest, agent_workflow: rest.agent_workflow ?? retired }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
}

function hasRetiredHeading(text: string, paths: PathsService): boolean {
  const markers = paths.blockMarkers();
  const start = text.indexOf(markers.start);
  const end = text.indexOf(markers.end, start);
  return (
    start >= 0 &&
    end > start &&
    text
      .slice(start, end)
      .split(/\r?\n/)
      .some((line) => line === `## ${RETIRED_HEADING}`)
  );
}

/** Validate every sealed note before the first migration write; publish the marker last. */
export async function migrateRetiredNames(fs: FileSystemPort, paths: PathsService): Promise<void> {
  const pending = await retiredNameState(fs, paths);
  if (!pending.marker && !pending.heading) return;
  const lock = await acquireLock(join(paths.cwdRoot(), ".retired-name.lock"), fs, {
    removeOnRelease: true,
    waitMs: 1000,
    waitStepMs: 5,
  });
  try {
    await migrateLocked(fs, paths);
  } finally {
    await lock.release();
  }
}

async function migrateLocked(fs: FileSystemPort, paths: PathsService): Promise<void> {
  const state = await retiredNameState(fs, paths);
  const rewrites: Array<[string, string]> = [];
  const agents = join(paths.hubDir(), "AGENTS.md");
  if (state.heading) {
    const text = await fs.readText(agents);
    const markers = paths.blockMarkers();
    const start = text.indexOf(markers.start);
    const end = text.indexOf(markers.end, start);
    rewrites.push([
      agents,
      text.slice(0, start) +
        text
          .slice(start, end)
          .replace(new RegExp(`^## ${RETIRED_HEADING}\\r?$`, "m"), "## agent-workflow") +
        text.slice(end),
    ]);
  }
  rewrites.push(...(await decisionRewrites(fs, paths)));
  for (const [path, text] of rewrites) await fs.writeText(path, text);
  if (!state.marker || state.conflict) return;
  const oldPath = join(paths.cwdRoot(), RETIRED_MARKER_FILE);
  if (!(await fs.exists(paths.cwdMarkerFile()))) {
    await fs.writeText(
      paths.cwdMarkerFile(),
      `${JSON.stringify(normalizeMarker(JSON.parse(await fs.readText(oldPath))), null, 2)}\n`,
    );
  }
  await fs.remove(oldPath);
}

async function decisionRewrites(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<Array<[string, string]>> {
  const rewrites: Array<[string, string]> = [];
  const decisions = join(paths.hubDir(), "docs", "decisions");
  if (!(await fs.exists(decisions))) return rewrites;
  for (const entry of await fs.list(decisions)) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
    const file = join(decisions, entry.name);
    const raw = JSON.parse(await fs.readText(file));
    if (raw.schema === RETIRED_INDEX_SCHEMA) {
      if (!Array.isArray(raw.notes))
        throw new Error(`No se puede migrar ${file}: notes no es una lista`);
      rewrites.push([
        file,
        `${JSON.stringify({ ...raw, schema: "agent-workflow.decision-index/v1", notes: raw.notes.map((note: unknown) => migrateNote(note, file)) }, null, 2)}\n`,
      ]);
    } else if (raw.schema === RETIRED_NOTE_SCHEMA) {
      rewrites.push([file, `${JSON.stringify(migrateNote(raw, file), null, 2)}\n`]);
    }
  }
  return rewrites;
}

function migrateNote(value: unknown, file: string): Record<string, unknown> {
  const checked = validateDecisionNote(value);
  if (!checked.ok || checked.value === null)
    throw new Error(
      `No se puede migrar ${file}: ${checked.failures.map((f) => f.code).join(", ")}`,
    );
  const { digest: _old, ...body } = checked.value;
  const note = { ...body, schema: "agent-workflow.decision-note/v1" };
  return {
    ...(value as Record<string, unknown>),
    schema: note.schema,
    digest: computeNoteDigest(note),
  };
}
