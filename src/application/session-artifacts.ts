import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";

/**
 * Canonical kinds of session artifacts. Stable enum used as the bridge between
 * runtime code and on-disk filenames; lets us migrate filenames (R1/R3) without
 * touching call-sites.
 */
export type ArtifactKind =
  | "objective"
  | "findings"
  | "decisions"
  | "evidence"
  | "conclusions"
  | "recommendation"
  | "delivery"
  | "dependencies"
  | "discovery"
  | "problem"
  | "tasks"
  | "checkpoint"
  | "status"
  | "requirements"
  | "backlog"
  | "scripts_sql";

/**
 * Filename candidates per kind. Order matters: EN UPPERCASE first (canonical
 * for new writes), ES UPPERCASE second (legacy fallback for sessions created
 * before R3 Sprint 1). Lookup in {@link findArtifact} is case-insensitive.
 *
 * `tasks`/`checkpoint`/`status`/`requirements` are already English and have no
 * Spanish predecessor — they keep a single entry.
 */
export const ARTIFACT_FILENAMES: Record<ArtifactKind, readonly string[]> = {
  objective: ["OBJECTIVE.md", "OBJETIVO.md"],
  findings: ["FINDINGS.md", "HALLAZGOS.md"],
  decisions: ["DECISIONS.md", "DECISIONES.md"],
  evidence: ["EVIDENCE.md", "EVIDENCIA.md"],
  conclusions: ["CONCLUSIONS.md", "CONCLUSIONES.md"],
  recommendation: ["RECOMMENDATION.md", "RECOMENDACION.md"],
  delivery: ["DELIVERY.md", "ENTREGA.md"],
  dependencies: ["DEPENDENCIES.md", "DEPENDENCIAS.md"],
  discovery: ["DISCOVERY.md"],
  problem: ["PROBLEM.md", "PROBLEMA.md"],
  tasks: ["TASKS.md"],
  checkpoint: ["CHECKPOINT.md"],
  status: ["STATUS.md"],
  requirements: ["REQUIREMENTS.md"],
  backlog: ["BACKLOG.md"],
  scripts_sql: ["SCRIPTS.sql"],
};

/** Canonical EN UPPERCASE filename for `kind`. Use when writing a new artifact. */
export function canonicalArtifactFilename(kind: ArtifactKind): string {
  const names = ARTIFACT_FILENAMES[kind];
  return names[0] as string;
}

/** Canonical EN UPPERCASE path inside `folder` for `kind`. Use when writing a new artifact. */
export function canonicalArtifactPath(folder: string, kind: ArtifactKind): string {
  return join(folder, canonicalArtifactFilename(kind));
}

/**
 * Find an existing artifact of `kind` inside `folder`. Tries each candidate
 * filename (EN preferred → ES legacy) using case-insensitive matching, so
 * `Objective.md` and `objetivo.md` both resolve. Returns the absolute path of
 * the first match, or `null` if none exist (or `folder` itself is missing).
 *
 * Use {@link canonicalArtifactPath} when the caller wants to write a brand-new
 * artifact and doesn't care whether a legacy version exists.
 *
 * Implementation: lists the folder once for case-insensitive lookup, then falls
 * back to direct {@link FileSystemPort.exists} probes for each candidate. The
 * fallback covers (a) folders that don't list cleanly (e.g. fake fs in tests
 * that adds files without registering parent dir entries) and (b) any race
 * where a file appeared after the listing.
 */
export async function findArtifact(
  folder: string,
  kind: ArtifactKind,
  fs: FileSystemPort,
): Promise<string | null> {
  const index = await buildFolderIndex(folder, fs);
  const fromIndex = findArtifactInIndex(folder, kind, index);
  if (fromIndex) return fromIndex;
  for (const candidate of ARTIFACT_FILENAMES[kind]) {
    const candidatePath = join(folder, candidate);
    if (await fs.exists(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

/**
 * Bulk variant of {@link findArtifact}: lists `folder` once and resolves all
 * known artifact kinds in a single pass. Returns a record `kind → path | null`.
 * Use when checking presence of multiple artifacts on the same folder (e.g.
 * `listArtefacts` in checkpoint state-reader) — avoids N readdir calls.
 *
 * Falls back to {@link FileSystemPort.exists} per candidate when the listing
 * doesn't include a candidate filename, mirroring the resilience of
 * {@link findArtifact}.
 */
export async function listExistingArtifacts(
  folder: string,
  fs: FileSystemPort,
): Promise<Record<ArtifactKind, string | null>> {
  const index = await buildFolderIndex(folder, fs);
  const result = {} as Record<ArtifactKind, string | null>;
  for (const kind of Object.keys(ARTIFACT_FILENAMES) as ArtifactKind[]) {
    let found = findArtifactInIndex(folder, kind, index);
    if (!found) {
      for (const candidate of ARTIFACT_FILENAMES[kind]) {
        const candidatePath = join(folder, candidate);
        if (await fs.exists(candidatePath)) {
          found = candidatePath;
          break;
        }
      }
    }
    result[kind] = found;
  }
  return result;
}

async function buildFolderIndex(folder: string, fs: FileSystemPort): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(folder);
  } catch {
    return index;
  }
  for (const e of entries) {
    if (e.type !== "file") continue;
    index.set(e.name.toLowerCase(), e.name);
  }
  return index;
}

function findArtifactInIndex(
  folder: string,
  kind: ArtifactKind,
  index: Map<string, string>,
): string | null {
  for (const candidate of ARTIFACT_FILENAMES[kind]) {
    const actual = index.get(candidate.toLowerCase());
    if (actual) {
      return join(folder, actual);
    }
  }
  return null;
}
