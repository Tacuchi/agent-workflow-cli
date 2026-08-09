import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";

/**
 * Canonical kinds of session artifacts. Stable enum used as the bridge between
 * runtime code and on-disk filenames; lets us migrate filenames (R1/R3) without
 * touching call-sites.
 */
export type ArtifactKind =
  | "session"
  | "objective"
  | "decisions"
  | "conclusions"
  | "tasks"
  | "checkpoint"
  | "backlog"
  | "scripts_sql"
  | "analysis_file"
  | "technical_note";

/**
 * Filename candidates per kind. Order matters: EN UPPERCASE canonical first,
 * legacy variants after (fallback for sessions created before the redesign).
 * Lookup in {@link findArtifact} is case-insensitive.
 *
 * `objective` is retained ONLY as a legacy read fallback (new sessions write
 * `session` → SESSION.md). `decisions` canonical is DECISION.md (singular) with
 * DECISIONS.md / DECISIONES.md kept as legacy fallbacks.
 */
export const ARTIFACT_FILENAMES: Record<ArtifactKind, readonly string[]> = {
  session: ["SESSION.md"],
  objective: ["OBJECTIVE.md", "OBJETIVO.md"],
  decisions: ["DECISION.md", "DECISIONS.md", "DECISIONES.md"],
  conclusions: ["CONCLUSIONS.md", "CONCLUSIONES.md"],
  tasks: ["TASKS.md"],
  checkpoint: ["CHECKPOINT.md"],
  backlog: ["BACKLOG.md"],
  scripts_sql: ["SCRIPTS.sql"],
  analysis_file: ["ANALYSIS-FILE.md"],
  technical_note: ["TECHNICAL-NOTE.md"],
};

/**
 * What each artifact is FOR: who writes it, what fact it owns, who reads it.
 *
 * The catalog exists because "una fuente por hecho" is only checkable if every
 * artifact says which fact it owns. Without it the rule is prose: two artifacts
 * can drift into telling the same story, a new kind can arrive owning nothing, and
 * nobody notices until two surfaces answer the same question differently.
 *
 * `primary_source` is the load-bearing column — it is what the session narrative
 * attributes each of its lines to. `consumers` names the PUBLIC surfaces, so an
 * artifact nothing reads is visible as such instead of quietly accumulating.
 *
 * Kept next to {@link ARTIFACT_FILENAMES} on purpose: the two are the same
 * decision seen from two sides, and a kind added to one and forgotten in the other
 * is exactly what the coverage test refuses.
 */
export interface ArtifactRole {
  /** Who writes it — a loop, a CLI command, or the person. */
  producer: string;
  /** The fact this artifact is the primary place for. */
  primary_source: string;
  /** Public surfaces that read it. Empty means nothing reads it yet, and says so. */
  consumers: readonly string[];
  /** Present only for a kind kept alive to READ old sessions, never written. */
  legacy?: true;
}

export const ARTIFACT_CATALOG: Record<ArtifactKind, ArtifactRole> = {
  session: {
    producer: "aw session-create (el loop dueño de la corrida)",
    primary_source: "el objetivo, el origen y los criterios de éxito de la sesión",
    consumers: ["aw session-artifacts", "aw status", "aw resume", "export-*"],
  },
  objective: {
    producer: "sesiones anteriores al rediseño",
    primary_source: "el objetivo, en sesiones que nacieron antes de SESSION.md",
    consumers: ["aw session-artifacts", "aw resume"],
    legacy: true,
  },
  decisions: {
    producer: "el loop, a medida que decide",
    primary_source: "las decisiones no obvias y su razón",
    consumers: ["aw session-artifacts", "export-reports"],
  },
  conclusions: {
    producer: "la investigación inline de la corrida",
    primary_source: "el veredicto de una investigación y por qué quedó así",
    consumers: ["aw session-artifacts", "aw resume", "export-reports"],
  },
  tasks: {
    producer: "el loop que descompone trabajo dentro de la sesión",
    primary_source: "las tareas de la sesión y su avance",
    consumers: ["aw session-artifacts", "aw status"],
  },
  checkpoint: {
    producer: "aw checkpoint-write y el loop en cada frontera",
    primary_source: "qué se completó, qué queda y cuál es el próximo paso",
    consumers: ["aw checkpoint-read", "aw resume", "aw resume-summary", "aw status"],
  },
  backlog: {
    producer: "el cierre de la corrida, sólo si algo quedó diferido",
    primary_source: "lo diferido y por qué",
    consumers: ["aw session-artifacts", "aw resume"],
  },
  scripts_sql: {
    producer: "el loop que toca base de datos, sin ejecutarlo",
    primary_source: "el DDL/DML derivado de la corrida",
    consumers: ["aw session-artifacts", "export-scripts"],
  },
  analysis_file: {
    producer: "la investigación inline de la corrida",
    primary_source: "la evidencia cruda que la investigación recogió",
    consumers: ["aw session-artifacts", "export-reports"],
  },
  technical_note: {
    producer: "el loop, cuando el detalle técnico excede al CHECKPOINT",
    primary_source: "el detalle técnico que no cabe en el recorrido humano",
    consumers: ["aw session-artifacts"],
  },
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
