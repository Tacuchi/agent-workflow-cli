import { CRITERION_GLOBAL, isDigest } from "./design/identity.js";
import { sealedRecordDigest } from "./sealed-record.js";

/**
 * A DECISION NOTE: the durable record of a divergence that was reconciled
 * forward instead of sent back to `plan-refine` or `spec-refine`.
 *
 * The form is deliberately the one design governance already uses: a sealed
 * record that lives OUTSIDE the thing it decides on, naming that thing by
 * identity AND by the digest it had. A note stored inside its spec or plan would
 * change that document's digest, so the contract being amended would no longer
 * be the contract that was amended — the same trap `DesignReview` was shaped to
 * avoid, one level up.
 *
 * Two rules give the chain its meaning:
 *
 * - **Complete or rejected.** Every field below is mandatory and each absence
 *   has its OWN code. A note missing its resume point is not a slightly worse
 *   note: it is a decision nobody can act on, and accepting it would put an
 *   authoritative record in the chain that the composition later has to guess
 *   about.
 * - **Append-only.** Correcting a note never rewrites it. It publishes another
 *   note that names the one it replaces, so the history of what was decided
 *   stays readable and only the EFFECTIVE reading changes.
 */

/** One end of the lineage: a document, its correlative and its exact bytes. */
export interface NoteAnchor {
  path: string;
  number: string;
  digest: string;
}

/** Where the run stood when the divergence appeared. */
export interface NoteExecution {
  /** Session folder that produced the note. */
  session: string;
  /** Phase the run was in, e.g. `F4`. */
  phase: string;
}

export interface NoteLineage {
  spec: NoteAnchor;
  plan: NoteAnchor;
  execution: NoteExecution;
}

/**
 * How far the decision reaches.
 *
 * `plan-only` amends how the plan gets there; `functional` amends what the spec
 * promised. Keeping them apart is what lets `status` say whether a consumer's
 * acceptance changed or merely its route.
 */
export type NoteScope = "functional" | "plan-only";

export interface DecisionNote {
  schema: string;
  /** `DEC-NNN`, minted under the workspace lock like every other correlative. */
  id: string;
  lineage: NoteLineage;
  decision: string;
  reason: string;
  /** Effective assertions this note replaces, addressed as `S033/AC-05`. */
  supersedes_assertions: string[];
  /** The note this one corrects, by id — `null` when it corrects none. */
  supersedes_note: string | null;
  scope: NoteScope;
  /** Plans reached by the decision, workspace-relative. */
  consumers: string[];
  evidence_preserved: string[];
  evidence_invalidated: string[];
  obligations: string[];
  /** Where execution resumes once the note is registered. */
  resume_point: string;
  date: string;
  digest: string;
}

export const NOTE_SCHEMA = "workline.decision-note/v1";

const NOTE_ID_RE = /^DEC-(?:[0-9]{3}|[1-9][0-9]{3,})$/;
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CRITERION_RE = new RegExp(`^${CRITERION_GLOBAL.source}$`);

export interface NoteFailure {
  code: string;
  message: string;
  action: string;
}

export interface NoteValidation {
  ok: boolean;
  value: DecisionNote | null;
  failures: NoteFailure[];
}

/** The note's own digest, by the SAME code every sealed record uses. */
export function computeNoteDigest(note: Omit<DecisionNote, "digest">): string {
  return sealedRecordDigest(note as unknown as Record<string, unknown>);
}

/**
 * Read a note, refusing anything incomplete under its own code.
 *
 * The codes are per-field on purpose. "La nota es inválida" sends whoever wrote
 * it to re-read the whole record; `NOTE_RESUME_POINT_MISSING` sends them to the
 * one line that is missing.
 */
export function validateDecisionNote(raw: unknown): NoteValidation {
  const failures: NoteFailure[] = [];
  const fail = (code: string, message: string, action: string): void => {
    failures.push({ code, message, action });
  };
  if (!isRecord(raw)) {
    fail(
      "NOTE_NOT_OBJECT",
      "la nota de decisión no es un objeto JSON",
      "una nota es un record sellado con su propio digest",
    );
    return { ok: false, value: null, failures };
  }
  if (raw.schema !== NOTE_SCHEMA) {
    // El gate de versión corre solo y primero: leer campos de un formato que no
    // conocemos reporta sinsentidos derivados y manda a arreglar un campo cuando
    // lo que falta es actualizar.
    fail(
      "NOTE_SCHEMA_UNKNOWN",
      `versión de formato no soportada: ${JSON.stringify(raw.schema)}`,
      `este Workline entiende ${NOTE_SCHEMA}`,
    );
    return { ok: false, value: null, failures };
  }

  if (typeof raw.id !== "string" || !NOTE_ID_RE.test(raw.id)) {
    fail("NOTE_ID_INVALID", "'id' debe ser DEC-NNN", "numerá la nota como DEC-001");
  }
  const lineage = readLineage(raw.lineage, fail);
  requireText(
    raw.decision,
    "decision",
    "NOTE_DECISION_MISSING",
    "qué se decidió, en una frase",
    fail,
  );
  requireText(
    raw.reason,
    "reason",
    "NOTE_REASON_MISSING",
    "por qué se decidió eso y no otra cosa",
    fail,
  );
  const assertions = readAssertions(raw.supersedes_assertions, fail);
  const supersedesNote = readSupersedesNote(raw.supersedes_note, fail);
  const scope = readScope(raw.scope, fail);
  const consumers = requireList(
    raw.consumers,
    "consumers",
    "NOTE_CONSUMERS_MISSING",
    "enumerá los planes alcanzados; [] si no alcanza a ninguno",
    fail,
  );
  const preserved = requireList(
    raw.evidence_preserved,
    "evidence_preserved",
    "NOTE_EVIDENCE_PRESERVED_MISSING",
    "enumerá la evidencia que sigue valiendo; [] si ninguna",
    fail,
  );
  const invalidated = requireList(
    raw.evidence_invalidated,
    "evidence_invalidated",
    "NOTE_EVIDENCE_INVALIDATED_MISSING",
    "enumerá la evidencia que dejó de valer; [] si ninguna",
    fail,
  );
  const obligations = requireList(
    raw.obligations,
    "obligations",
    "NOTE_OBLIGATIONS_MISSING",
    "enumerá el trabajo compensatorio que nace; [] si ninguno",
    fail,
  );
  requireText(
    raw.resume_point,
    "resume_point",
    "NOTE_RESUME_POINT_MISSING",
    "decí desde dónde sigue la ejecución",
    fail,
  );
  if (typeof raw.date !== "string" || !CALENDAR_DATE_RE.test(raw.date)) {
    fail(
      "NOTE_DATE_INVALID",
      "'date' debe ser una fecha AAAA-MM-DD",
      "la cadena se ordena por fecha e id: sin fecha válida el orden es una opinión",
    );
  }

  if (failures.length > 0) return { ok: false, value: null, failures };

  const value: DecisionNote = {
    schema: NOTE_SCHEMA,
    id: raw.id as string,
    lineage: lineage as NoteLineage,
    decision: raw.decision as string,
    reason: raw.reason as string,
    supersedes_assertions: assertions as string[],
    supersedes_note: supersedesNote,
    scope: scope as NoteScope,
    consumers: consumers as string[],
    evidence_preserved: preserved as string[],
    evidence_invalidated: invalidated as string[],
    obligations: obligations as string[],
    resume_point: raw.resume_point as string,
    date: raw.date as string,
    digest: "",
  };
  const expected = computeNoteDigest(stripDigest(value));
  if (typeof raw.digest !== "string" || raw.digest.length === 0) {
    fail("NOTE_DIGEST_MISSING", "'digest' es obligatorio", `sellá la nota con ${expected}`);
    return { ok: false, value: null, failures };
  }
  if (raw.digest !== expected) {
    fail(
      "NOTE_DIGEST_MISMATCH",
      "el 'digest' no corresponde al contenido de la nota",
      `una nota publicada no se reescribe: el sello de este contenido es ${expected}`,
    );
    return { ok: false, value: null, failures };
  }
  return { ok: true, value: { ...value, digest: raw.digest }, failures };
}

function stripDigest(note: DecisionNote): Omit<DecisionNote, "digest"> {
  const { digest: _drop, ...rest } = note;
  return rest;
}

/**
 * The chain of notes for one lineage, in a deterministic order.
 *
 * Date first, id second. Two notes written the same day still have exactly one
 * order, and it is the order they were minted in — which is what makes "apply
 * them in order" a fact rather than whatever the filesystem returned.
 */
export function orderNotes(notes: readonly DecisionNote[]): DecisionNote[] {
  return [...notes].sort((a, b) =>
    a.date === b.date ? compareNoteIds(a.id, b.id) : a.date < b.date ? -1 : 1,
  );
}

function compareNoteIds(a: string, b: string): number {
  const na = Number(a.slice(4));
  const nb = Number(b.slice(4));
  return na === nb ? (a < b ? -1 : a > b ? 1 : 0) : na - nb;
}

/**
 * Whether appending this note to an existing chain keeps it append-only.
 *
 * Two refusals, and both are the same rule seen from different sides: an id
 * already in the chain would REWRITE a published note, and a `supersedes_note`
 * pointing at nothing would claim to correct a decision that was never taken.
 */
export function checkAppendOnly(
  chain: readonly DecisionNote[],
  incoming: DecisionNote,
): NoteFailure[] {
  const failures: NoteFailure[] = [];
  const byId = new Map(chain.map((note) => [note.id, note]));
  if (byId.has(incoming.id)) {
    failures.push({
      code: "NOTE_ALREADY_PUBLISHED",
      message: `${incoming.id} ya está publicada en este linaje`,
      action:
        "corregir una nota es publicar OTRA que la sustituya por referencia, nunca reescribirla",
    });
  }
  if (incoming.supersedes_note !== null && !byId.has(incoming.supersedes_note)) {
    failures.push({
      code: "NOTE_SUPERSEDES_ABSENT",
      message: `${incoming.id} dice sustituir a ${incoming.supersedes_note}, que no está en el linaje`,
      action: "una sustitución nombra una nota publicada de la misma cadena",
    });
  }
  return failures;
}

/** The notes still in force: every one nobody later superseded. */
export function effectiveNotes(chain: readonly DecisionNote[]): DecisionNote[] {
  const superseded = new Set(
    chain.map((note) => note.supersedes_note).filter((id): id is string => id !== null),
  );
  return orderNotes(chain).filter((note) => !superseded.has(note.id));
}

// ── field readers ────────────────────────────────────────────────────────────

type Fail = (code: string, message: string, action: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(
  value: unknown,
  field: string,
  code: string,
  action: string,
  fail: Fail,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `'${field}' es obligatorio y no puede estar vacío`, action);
  }
}

function requireList(
  value: unknown,
  field: string,
  code: string,
  action: string,
  fail: Fail,
): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) {
    fail(code, `'${field}' es obligatorio y debe ser una lista de strings`, action);
    return null;
  }
  return value as string[];
}

function readScope(value: unknown, fail: Fail): NoteScope | null {
  if (value !== "functional" && value !== "plan-only") {
    fail(
      "NOTE_SCOPE_INVALID",
      "'scope' debe ser 'functional' o 'plan-only'",
      "decí si la decisión cambia lo prometido o sólo el camino para llegar",
    );
    return null;
  }
  return value;
}

function readSupersedesNote(value: unknown, fail: Fail): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !NOTE_ID_RE.test(value)) {
    fail(
      "NOTE_SUPERSEDES_INVALID",
      "'supersedes_note' debe ser un DEC-NNN o null",
      "usá null si esta nota no corrige ninguna anterior",
    );
    return null;
  }
  return value;
}

function readAssertions(value: unknown, fail: Fail): string[] | null {
  const list = requireList(
    value,
    "supersedes_assertions",
    "NOTE_ASSERTIONS_MISSING",
    "enumerá las afirmaciones que sustituye como S033/AC-05; [] si no sustituye ninguna",
    fail,
  );
  if (list === null) return null;
  const wrong = list.filter((id) => !CRITERION_RE.test(id));
  if (wrong.length > 0) {
    fail(
      "NOTE_ASSERTIONS_INVALID",
      `'supersedes_assertions' no usa la gramática de criterio en: ${wrong.join(", ")}`,
      "direccioná cada afirmación como S033/AC-05 — es la misma gramática que ya existe, no una segunda",
    );
    return null;
  }
  if (new Set(list).size !== list.length) {
    fail(
      "NOTE_ASSERTIONS_DUPLICATE",
      "'supersedes_assertions' repite una afirmación",
      "nombrar dos veces la misma afirmación no la sustituye dos veces",
    );
    return null;
  }
  return list;
}

function readAnchor(value: unknown, side: "spec" | "plan", fail: Fail): NoteAnchor | null {
  if (!isRecord(value)) {
    fail(
      "NOTE_LINEAGE_MISSING",
      `'lineage.${side}' es obligatorio`,
      `anclá el ${side} con su ruta, su correlativo y su digest exacto`,
    );
    return null;
  }
  const { path, number, digest } = value;
  if (typeof path !== "string" || path.length === 0 || typeof number !== "string") {
    fail(
      "NOTE_LINEAGE_INVALID",
      `'lineage.${side}' necesita 'path' y 'number'`,
      "el linaje nombra documentos reales del workspace",
    );
    return null;
  }
  if (!isDigest(digest)) {
    fail(
      "NOTE_LINEAGE_DIGEST_INVALID",
      `'lineage.${side}.digest' debe ser el sha256 exacto de ese documento`,
      "sin el digest la nota decide sobre un nombre, no sobre unos bytes",
    );
    return null;
  }
  return { path, number, digest };
}

function readLineage(value: unknown, fail: Fail): NoteLineage | null {
  if (!isRecord(value)) {
    fail(
      "NOTE_LINEAGE_MISSING",
      "'lineage' es obligatorio",
      "una nota sin linaje no se puede componer sobre ningún baseline",
    );
    return null;
  }
  const spec = readAnchor(value.spec, "spec", fail);
  const plan = readAnchor(value.plan, "plan", fail);
  const execution = value.execution;
  if (
    !isRecord(execution) ||
    typeof execution.session !== "string" ||
    execution.session.length === 0 ||
    typeof execution.phase !== "string" ||
    execution.phase.length === 0
  ) {
    fail(
      "NOTE_EXECUTION_STATE_MISSING",
      "'lineage.execution' necesita 'session' y 'phase'",
      "registrá desde qué sesión y en qué fase apareció la divergencia",
    );
    return null;
  }
  if (spec === null || plan === null) return null;
  return { spec, plan, execution: { session: execution.session, phase: execution.phase } };
}
