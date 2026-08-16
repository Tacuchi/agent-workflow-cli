import { join } from "node:path";
import {
  type DecisionNote,
  type NoteFailure,
  type NoteLineage,
  checkAppendOnly,
  computeNoteDigest,
  orderNotes,
  validateDecisionNote,
} from "../domain/decision-note.js";
import type { FileSystemPort } from "../ports/file-system.js";

/**
 * Where a lineage's decision notes live, and how one is added.
 *
 * ONE index per lineage, named by the SPEC's correlative: every note that amends
 * the contract of spec 033 is in `docs/decisions/033-decisions-<slug>.json`, in
 * order. Scattering them one-file-per-note would make "the effective contract"
 * a directory scan whose result depends on what the filesystem returned, and the
 * whole point of the chain is that its order is a fact.
 *
 * The index is the same shape the design subsystem already uses: a document that
 * INDEXES sealed records, each record keeping its own digest, so appending never
 * touches the bytes of a record that was already published.
 */

export const NOTE_INDEX_SCHEMA = "workline.decision-index/v1";

export interface DecisionIndex {
  schema: string;
  /** The spec whose contract this chain amends. */
  spec: { path: string; number: string };
  notes: DecisionNote[];
}

export interface IndexRead {
  index: DecisionIndex;
  /** `false` when the lineage has no chain yet — the caller creates, not replaces. */
  exists: boolean;
}

/** `docs/decisions/033-decisions-<slug>.json` for spec 033. */
export function noteIndexPath(decisionDir: string, specNumber: string, slug: string): string {
  return `${decisionDir}/${specNumber}-decisions-${slug}.json`;
}

export async function readNoteIndex(
  fs: FileSystemPort,
  root: string,
  path: string,
  spec: { path: string; number: string },
): Promise<{ ok: true; read: IndexRead } | { ok: false; failures: NoteFailure[] }> {
  const absolute = join(root, path);
  if (!(await fs.exists(absolute))) {
    return {
      ok: true,
      read: { index: { schema: NOTE_INDEX_SCHEMA, spec, notes: [] }, exists: false },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(absolute));
  } catch (error) {
    return {
      ok: false,
      failures: [
        {
          code: "NOTE_INDEX_UNREADABLE",
          message: `${path} no se puede leer como JSON: ${String(error)}`,
          action:
            "el índice de decisiones es un documento sellado: reparalo a mano antes de agregar otra nota",
        },
      ],
    };
  }
  return readIndexValue(parsed, path, spec);
}

function readIndexValue(
  parsed: unknown,
  path: string,
  spec: { path: string; number: string },
): { ok: true; read: IndexRead } | { ok: false; failures: NoteFailure[] } {
  const failures: NoteFailure[] = [];
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      failures: [
        {
          code: "NOTE_INDEX_INVALID",
          message: `${path} no es un objeto JSON`,
          action: "el índice tiene 'schema', 'spec' y 'notes'",
        },
      ],
    };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.schema !== NOTE_INDEX_SCHEMA) {
    return {
      ok: false,
      failures: [
        {
          code: "NOTE_INDEX_SCHEMA_UNKNOWN",
          message: `versión de formato no soportada: ${JSON.stringify(raw.schema)}`,
          action: `este Workline entiende ${NOTE_INDEX_SCHEMA}`,
        },
      ],
    };
  }
  if (!Array.isArray(raw.notes)) {
    return {
      ok: false,
      failures: [
        {
          code: "NOTE_INDEX_INVALID",
          message: `${path}: 'notes' debe ser una lista`,
          action: "usá [] si el linaje todavía no tiene notas",
        },
      ],
    };
  }
  const notes: DecisionNote[] = [];
  for (const [i, entry] of raw.notes.entries()) {
    const read = validateDecisionNote(entry);
    if (!read.ok || read.value === null) {
      // Una nota publicada que ya no valida es corrupción del índice, no una
      // nota nueva mal escrita: no se descarta en silencio.
      failures.push(
        ...read.failures.map((f) => ({ ...f, message: `${path}: notes[${i}] ${f.message}` })),
      );
      continue;
    }
    notes.push(read.value);
  }
  if (failures.length > 0) return { ok: false, failures };
  return {
    ok: true,
    read: { index: { schema: NOTE_INDEX_SCHEMA, spec, notes: orderNotes(notes) }, exists: true },
  };
}

/** The next `DEC-NNN` for this lineage — sequential, never reused. */
export function nextNoteId(index: DecisionIndex): string {
  const max = index.notes.reduce((acc, note) => Math.max(acc, Number(note.id.slice(4))), 0);
  return `DEC-${String(max + 1).padStart(3, "0")}`;
}

/** Seal a note draft: its id and digest come from the chain, never from the caller. */
export function sealNote(
  index: DecisionIndex,
  draft: Omit<DecisionNote, "id" | "digest">,
): DecisionNote {
  const withId = { ...draft, id: nextNoteId(index) };
  return { ...withId, digest: computeNoteDigest(withId) };
}

/**
 * Append a note, or refuse with everything that is wrong.
 *
 * Refusing composes the note's own completeness check with the chain's
 * append-only rule, because both answer the same question — whether this record
 * may become authoritative — and reporting them one round at a time would make
 * an author fix a field, resubmit, and only then learn the id was taken.
 */
export function appendNote(
  index: DecisionIndex,
  note: DecisionNote,
): { ok: true; index: DecisionIndex } | { ok: false; failures: NoteFailure[] } {
  const read = validateDecisionNote(note);
  const chain = checkAppendOnly(index.notes, note);
  const failures = [...read.failures, ...chain];
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, index: { ...index, notes: orderNotes([...index.notes, note]) } };
}

/** The artifact a proposal publishes for this index — stable, pretty, newline-terminated. */
export function noteIndexArtifact(
  path: string,
  index: DecisionIndex,
): { path: string; content: string } {
  return { path, content: `${JSON.stringify(index, null, 2)}\n` };
}

/**
 * Refuse a publication that would rewrite the very baseline it decides on.
 *
 * This is the invariant the whole form exists for: a note stored inside its spec
 * or plan changes that document's digest, so the contract being amended stops
 * being the contract that was amended. Checking the PROPOSAL — not just where we
 * meant to write — is what makes it a property instead of a convention.
 */
export function checkNoBaselineRewrite(
  artifacts: readonly { path: string }[],
  lineage: NoteLineage,
): NoteFailure[] {
  const forbidden = new Map([
    [lineage.spec.path, "la spec"],
    [lineage.plan.path, "el plan"],
  ]);
  const hits = artifacts.filter((a) => forbidden.has(a.path));
  return hits.map((a) => ({
    code: "NOTE_REWRITES_BASELINE",
    message: `registrar la nota reescribiría ${forbidden.get(a.path)} (${a.path})`,
    action: "una nota se guarda FUERA de lo que decide: sacá ese documento de la propuesta",
  }));
}
