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

/**
 * WHAT AN OBLIGATION IS FOR, which is not the same as what it says.
 *
 * A note that reconciles forward can leave two very different things owing, and
 * before this they were the same list of sentences: work THIS lineage still has
 * to do, and work it hands to somebody else. Counting both as pending is what
 * left a finished plan neither executable nor closable — the handoff could never
 * be discharged from inside the run, so the run could never close.
 *
 * `compensation` is owed by the lineage and blocks its closure until settled.
 * `handoff` is owed by somebody outside it: it stays visible, and it never
 * blocks. The class is stated by whoever writes the note, because only they know
 * which of the two they meant.
 */
export const OBLIGATION_KINDS = ["compensation", "handoff"] as const;

export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export interface NoteObligation {
  /** The work, in the words the note stated it. */
  text: string;
  kind: ObligationKind;
  /**
   * Whether the NOTE said the class, or this reading supplied it.
   *
   * A published note written before classes existed carries bare text, and it is
   * read as `compensation` — the safe half. Remembering that nobody declared it
   * is what lets the reconciliation ask the plan whether that text is actually a
   * handoff the plan already enumerates, and what keeps the write path able to
   * refuse a NEW note that omits what it should have said.
   */
  declared: boolean;
}

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
  obligations: NoteObligation[];
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

/**
 * The wire form of one obligation: the shape it has ON DISK.
 *
 * An obligation nobody classified goes back out as the bare string it came in
 * as. That is not nostalgia for the old format — it is the only way a note
 * published years ago keeps the digest it was sealed with. Normalizing it into
 * an object on read and writing that object back would re-seal every legacy
 * record in the chain, and a chain whose records no longer verify is exactly
 * what the append-only rule exists to prevent.
 */
export function obligationToWire(
  obligation: NoteObligation,
): string | { text: string; kind: ObligationKind } {
  return obligation.declared ? { text: obligation.text, kind: obligation.kind } : obligation.text;
}

/**
 * The obligations as they are WRITTEN — read back to their bytes, or left
 * exactly as they came when they cannot be read at all.
 *
 * Left as they came, and never replaced by `[]`: a draft that forgot to say
 * what work it creates and one that says "none" are opposite claims, and
 * sealing the first as the second would put the difference beyond anybody's
 * reach. So the unreadable value travels into the digest untouched and
 * {@link validateDecisionNote} refuses it under its own code — a refusal
 * somebody can act on, where a crash would be one nobody can.
 */
function wireObligations(value: unknown): unknown {
  const read = normalizeObligations(value);
  return read === null ? value : read.map(obligationToWire);
}

/** The note as it is written and sealed — normalized fields back to their bytes. */
export function noteToWire(note: DecisionNote): Record<string, unknown> {
  return { ...note, obligations: wireObligations(note.obligations) };
}

/** The note's own digest, by the SAME code every sealed record uses. */
export function computeNoteDigest(note: Omit<DecisionNote, "digest">): string {
  return sealedRecordDigest({
    ...note,
    obligations: wireObligations(note.obligations),
  } as unknown as Record<string, unknown>);
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
  const obligations = readObligations(raw.obligations, fail);
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
    obligations: obligations as NoteObligation[],
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

/**
 * Whether two notes record the SAME decision, ignoring which correlative it got.
 *
 * This is what makes "an identical retry recovers the same result without
 * deciding again" a property of content. The id cannot take part: a retry mints
 * the next number off a chain that already holds the first attempt, so comparing
 * sealed digests would call every retry a new decision and append a duplicate —
 * the chain would grow one indistinguishable note per interrupted run, and the
 * composition would then report an overlap nobody caused.
 *
 * Everything else does take part, including the fields that look like prose. Two
 * notes that supersede the same assertions for different stated reasons are two
 * decisions, and treating the second as a repeat of the first would drop the
 * reason the chain exists to preserve.
 */
export function sameDecision(a: DecisionNote, b: DecisionNote): boolean {
  return canonicalDecision(a) === canonicalDecision(b);
}

function canonicalDecision(note: DecisionNote): string {
  // Over the WIRE form, like every other seal in this module: a note just
  // sealed from a draft and the same note read back out of the chain differ
  // only in how their obligations are held in memory, and comparing those two
  // shapes would call an interrupted run's retry a brand-new decision.
  const { id: _id, digest: _digest, ...rest } = noteToWire(note);
  return sealedRecordDigest(rest);
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

/**
 * Read `obligations` in either form, and remember which one it was.
 *
 * Both are accepted on READ and only one on write (see
 * {@link checkObligationsDeclared}): a chain already published is data nobody
 * can go back and re-state, while a note being minted now has an author who can.
 */
function readObligations(value: unknown, fail: Fail): NoteObligation[] | null {
  if (!Array.isArray(value)) {
    fail(
      "NOTE_OBLIGATIONS_MISSING",
      "'obligations' es obligatorio y debe ser una lista",
      "enumerá el trabajo que nace, cada uno como { text, kind } con kind 'compensation' o 'handoff'; [] si ninguno",
    );
    return null;
  }
  const out: NoteObligation[] = [];
  for (const [i, entry] of value.entries()) {
    const read = readObligation(entry);
    if (read === null) {
      fail(
        "NOTE_OBLIGATIONS_INVALID",
        `'obligations[${i}]' no es ni un texto no vacío ni un { text, kind } con kind ${OBLIGATION_KINDS.join(" o ")}`,
        "una obligación dice qué trabajo nace y de qué clase es; el texto suelto sólo se lee, para las notas ya publicadas",
      );
      return null;
    }
    out.push(read);
  }
  return out;
}

/**
 * One obligation in either form — the legacy text or the classed object — or
 * `null` when it is neither.
 *
 * IDEMPOTENT: a value that already carries `declared` keeps it, so reading an
 * obligation this module already read never promotes a legacy `false` to `true`
 * and never moves the note's seal.
 *
 * And an undeclared obligation gets the SAFE class, whatever else the record
 * says. `declared: false` is not a field of either on-disk shape — it only
 * appears on a value already read — so a record spelling it alongside a class
 * is claiming a reading it does not have. Honouring that class would let bytes
 * that seal as the legacy form read as the classed one, and two surfaces would
 * disagree about the same record. The class it declares is ignored instead:
 * nothing is gained by writing it.
 */
function readObligation(value: unknown): NoteObligation | null {
  if (typeof value === "string") {
    return value.length === 0 ? null : { text: value, kind: "compensation", declared: false };
  }
  if (!isRecord(value)) return null;
  const { text, kind, declared } = value;
  if (typeof text !== "string" || text.length === 0) return null;
  if (typeof kind !== "string" || !OBLIGATION_KINDS.includes(kind as ObligationKind)) return null;
  const stated = typeof declared === "boolean" ? declared : true;
  return { text, kind: stated ? (kind as ObligationKind) : "compensation", declared: stated };
}

/** The whole list in either form, or `null` when any entry is neither. */
export function normalizeObligations(value: unknown): NoteObligation[] | null {
  if (!Array.isArray(value)) return null;
  const out: NoteObligation[] = [];
  for (const entry of value) {
    const read = readObligation(entry);
    if (read === null) return null;
    out.push(read);
  }
  return out;
}

/**
 * The write path's own rule: a NOTE BEING MINTED states every class.
 *
 * Read tolerance and write strictness are not in tension — they are the same
 * decision seen from the two ends of the chain. What is already published cannot
 * be re-stated by anybody, so it is read with the safe default; what is being
 * written has an author in front of it, and letting them omit the class would
 * mint tomorrow's legacy note today.
 */
export function checkObligationsDeclared(note: DecisionNote): NoteFailure[] {
  const bare = note.obligations.filter((obligation) => !obligation.declared);
  if (bare.length === 0) return [];
  return [
    {
      code: "NOTE_OBLIGATION_KIND_MISSING",
      message: `${note.id} anexa obligaciones sin clase: ${bare.map((o) => o.text).join("; ")}`,
      action:
        "declará cada obligación como { text, kind }: 'compensation' es trabajo que este linaje debe y bloquea su cierre, 'handoff' es trabajo que queda a cargo de otra gente y no lo bloquea",
    },
  ];
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
