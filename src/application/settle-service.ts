/**
 * `aw settle`: saldar las obligaciones de un plan que ya no tiene recorrido abierto.
 *
 * The closure of a `plan-exec` run settles its own obligations, and that is the
 * ordinary path. This is the other half: a plan blocked TODAY, in a workspace
 * where the run that created the obligation closed months ago. Before this, the
 * only way out was writing `docs/decisions/` by hand — the exact surgery the
 * scaffolding exists to make unnecessary.
 *
 * CROSS-CUTTING, like `reseal` and the retirement pair: it opens no flow and
 * creates no session. And it has `reseal`'s two steps for `reseal`'s reason —
 * a person ASSERTS something between them: that the compensatory work was done,
 * or that it was somebody else's all along. `prepare` shows what each settlement
 * would publish and the digest that authorizes it; `apply` re-derives everything
 * from the live workspace, demands that digest back, and publishes under the
 * lock. Two steps, and never one more: `list` is the same reading without a seal.
 *
 * What it never does is compete with a run. A `plan-exec` run holding this plan
 * owns its closure, and settling underneath it would publish a note the run's
 * own boundary is about to derive. So the command refuses and names the run.
 */

import { basename, join } from "node:path";
import type { DecisionNote, NoteFailure, ObligationKind } from "../domain/decision-note.js";
import { type BaselineInput, composeEffectiveContract } from "../domain/effective-contract.js";
import { specBaselineDigest } from "../domain/lineage.js";
import { type PlanReconciliation, reconciliationOf } from "../domain/reconciliation.js";
import { type ObligationSettlement, deriveSettlementNote } from "../domain/settlement.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { noteIndexPath, readNoteIndex } from "./decision-note-service.js";
import { DEFAULT_DOCS_CANON, resolveCoreDocsCanon } from "./docs-canon-service.js";
import { functionalSpecDigest } from "./parsers/spec-functional.js";
import {
  parseDerivedFromPath,
  parseSpecCriteria,
  parseSpecRelation,
} from "./parsers/spec-relation.js";
import { type PathsService, resolveWorkspaceRoot } from "./paths-service.js";
import { currentResumePoint } from "./plan-current-point.js";
import { settlePlanExecObligations } from "./plan-exec-decision-service.js";
import { locatePlanDocument } from "./plan-locator.js";
import { holdingRunOf, readHoldingRuns } from "./plan-open-run.js";
import { semanticDigest } from "./semantic-operation/protocol.js";

/**
 * Every refusal a settlement OWNS.
 *
 * Closed, like `reseal`'s. The publication's own codes reach the caller verbatim
 * instead of being re-spelled here: hiding WHICH guarantee stopped a write
 * behind a word invented at this layer is how a person ends up reading an action
 * that does not apply to what actually happened.
 */
export type SettleCode =
  | "SETTLE_DOCS_CANON_INVALID"
  | "SETTLE_TARGET_INVALID"
  | "SETTLE_TARGET_AMBIGUOUS"
  | "SETTLE_PLAN_ABSENT"
  | "SETTLE_PLAN_LINEAGE_UNDECLARED"
  | "SETTLE_SPEC_UNREADABLE"
  | "SETTLE_RUN_OPEN"
  | "SETTLE_OBLIGATION_UNKNOWN"
  | "SETTLE_DECLARATION_INVALID"
  | "SETTLE_APPROVAL_MISMATCH";

export interface SettleFailure {
  /** A {@link SettleCode}, or the chain's / publication's own when it refused. */
  code: string;
  message: string;
  /** One valid next move — never a dead end. */
  action: string;
}

/** One obligation still in force, with everything needed to decide about it. */
export interface SettleObligation {
  /** The note that created it, and its position in that note's list. */
  note: string;
  index: number;
  text: string;
  kind: ObligationKind;
  /** `true` when the note did not state the class and this reading supplied it. */
  legacy: boolean;
  /** The plan item that made a legacy obligation read as a handoff, if any. */
  corresponds_to: string | null;
  /** Where the NOTE said to come back — history, kept for the audit. */
  declared_point: string;
}

export interface SettleListing {
  plan: string;
  spec: string;
  /** Live compensations: the only ones that hold the closure shut. */
  compensations: SettleObligation[];
  /** Live handoffs: visible, never blocking. */
  handoffs: SettleObligation[];
  closable: boolean;
  /** The first phase the plan does not report validated, or the closure. */
  current_point: string;
}

/** What one carrier note's successor would say, before anything is written. */
export interface SettlePlanned {
  /** The note being superseded. */
  note: string;
  /**
   * Obligations it discharges, each with what proves it.
   *
   * The evidence travels HERE and not only into the note, because the seal is
   * computed over this object: it is the one field a person supplies rather than
   * the CLI deriving it, so leaving it out of the seal would let the text change
   * between the preview and the write while the approval still fitted.
   */
  settled: { text: string; evidence: string }[];
  /** What the successor keeps, each with the class it goes out carrying. */
  keeps: { text: string; kind: ObligationKind; declared: boolean }[];
  /** The session and phase the successor records — the carrier's own. */
  execution: { session: string; phase: string };
}

export type SettlePreparation =
  | {
      status: "prepared";
      listing: SettleListing;
      planned: SettlePlanned[];
      /** The seal `apply` demands back. */
      digest: string;
      /** The exact command that applies exactly this. */
      next: string;
    }
  /** Nothing was declared: the reading, with no seal and nothing to approve. */
  | { status: "listed"; listing: SettleListing }
  | { status: "failed"; failure: SettleFailure };

export type SettleApplication =
  | {
      status: "applied";
      listing: SettleListing;
      published: string[];
      settled: string[];
      /** Where the plan stands once every successor is in the chain. */
      reconciliation: PlanReconciliation;
    }
  | { status: "failed"; failure: SettleFailure };

export interface SettleDeclarations {
  /** `DEC-001[0]=<evidencia>` — the work was done, and this is what proves it. */
  settle: readonly string[];
  /** `DEC-001[1]` — the work is somebody else's. */
  handoff: readonly string[];
  /** `DEC-002[0]` — not done yet; it stays exactly as it is. */
  pending: readonly string[];
}

type Failed = { status: "failed"; failure: SettleFailure };

function fail(code: SettleCode, message: string, action: string): Failed {
  return { status: "failed", failure: { code, message, action } };
}

/**
 * What a plan still owes, read and reported without writing anything.
 *
 * Read-only so it is safe to run on the wrong plan — which is what somebody
 * about to assert "this work was done" needs. It is also the first half of both
 * other verbs: the listing a person reads, the successors they approve and the
 * notes `apply` publishes are three views of ONE derivation.
 */
export async function listSettle(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
): Promise<{ status: "listed"; listing: SettleListing } | Failed> {
  const read = await readLineage(fs, env, paths, target);
  if ("failure" in read) return read;
  return { status: "listed", listing: read.listing };
}

/**
 * Derive every successor and seal what approving them authorizes.
 *
 * With no declarations it is `list` with another name, and that is deliberate:
 * the first thing anybody does is look, and making them approve a seal in order
 * to see what they owe would be a confirmation over nothing.
 */
export async function prepareSettle(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
  declarations: SettleDeclarations,
): Promise<SettlePreparation> {
  const read = await readLineage(fs, env, paths, target);
  if ("failure" in read) return read;
  const { listing, chain, baseline, planText } = read;

  // La misma lectura que el tablero proyecta: si dos superficies contestaran por
  // su cuenta «hay una corrida sobre este plan», una de las dos se equivocaría.
  const open = holdingRunOf(await readHoldingRuns(fs, paths), listing.plan);
  if (open !== null) {
    return fail(
      "SETTLE_RUN_OPEN",
      `la sesión ${open.session} ${open.why}`,
      `seguí esa corrida con '${open.command}'; 'aw settle' es la salida cuando NO hay recorrido abierto`,
    );
  }

  const declared = parseDeclarations(declarations, listing);
  if ("failure" in declared) return declared;
  // With nothing declared this IS `list`, whatever the plan owes: making
  // somebody approve a seal in order to see what they owe would be a
  // confirmation over nothing, and failing when they owe nothing would make the
  // two verbs disagree about the same plan.
  if (declared.value.length === 0) return { status: "listed", listing };

  const planned = plannedFor(chain, declared.value, listing);
  if ("failure" in planned) return planned;

  // The seal covers WHAT WAS SHOWN and the bytes it was read from: the plan, the
  // chain and every successor. Any of the three moving makes the approval stop
  // fitting, which is what keeps a `plan-exec` publication in flight from being
  // overwritten by a yes given over an older reading.
  const sealed = semanticDigest({
    operation: "settle.obligations",
    plan: listing.plan,
    plan_digest: specBaselineDigest(planText),
    spec_digest: baseline.digest,
    chain: chain.map((note) => note.digest),
    planned: planned.value,
  });
  return {
    status: "prepared",
    listing,
    planned: planned.value,
    digest: sealed,
    next: applyCommand(listing.plan, declarations, sealed),
  };
}

/**
 * Publish exactly what was previewed, or nothing at all.
 *
 * The preparation runs AGAIN from the live workspace and the approval is
 * compared against what THAT produces — never against the digest a preview
 * handed back, which may describe a workspace that no longer exists. What
 * publishes is `settlePlanExecObligations`, the same path the closure of a run
 * takes, so the two cannot disagree about what a settlement writes.
 */
export async function applySettle(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: { target: string; approval: string; declarations: SettleDeclarations },
): Promise<SettleApplication> {
  const prepared = await prepareSettle(fs, env, paths, input.target, input.declarations);
  if (prepared.status === "failed") return prepared;
  if (prepared.status === "listed") {
    return fail(
      "SETTLE_DECLARATION_INVALID",
      "no se declaró ningún saldo: no hay nada que aplicar",
      `corré 'aw settle prepare ${prepared.listing.plan}' con --settle, --handoff o --pending y aprobá el digest que muestra`,
    );
  }
  if (input.approval.trim() !== prepared.digest) {
    return fail(
      "SETTLE_APPROVAL_MISMATCH",
      "lo aprobado no es lo que se publicaría: el plan, su spec o su cadena cambiaron desde la vista previa",
      `volvé a correr 'aw settle prepare ${prepared.listing.plan}' con las mismas declaraciones, leé la vista previa vigente y aprobá ese digest`,
    );
  }

  const root = await resolveWorkspaceRoot(fs, env, paths);
  const declared = parseDeclarations(input.declarations, prepared.listing);
  if ("failure" in declared) return declared;
  const settled = await settlePlanExecObligations(fs, paths, {
    root,
    // No run acts here, so each successor records the lineage of the note it
    // supersedes: a real session and a real phase, never a placeholder and never
    // another carrier's.
    execution: (carrier) => ({
      session: carrier.lineage.execution.session,
      phase: carrier.lineage.execution.phase,
    }),
    plan: prepared.listing.plan,
    date: new Date().toISOString().slice(0, 10),
    declarations: declared.value,
  });
  if (!settled.ok) {
    return {
      status: "failed",
      failure: {
        code: settled.failure.code,
        message: settled.failure.message,
        action: settled.failure.action,
      },
    };
  }
  return {
    status: "applied",
    listing: prepared.listing,
    published: settled.published.map((note) => note.id),
    settled: settled.settled,
    reconciliation: settled.reconciliation,
  };
}

// ── reading the lineage ──────────────────────────────────────────────────────

interface Lineage {
  listing: SettleListing;
  chain: DecisionNote[];
  /**
   * The spec as it reads now, with BOTH digests.
   *
   * `legacy_digest` is not optional decoration: a note published before the
   * functional payload existed pinned the exact bytes, and composing the chain
   * without it would refuse an old note over a spec nobody touched. The type
   * says so because anyone rebuilding this value from the declared shape would
   * silently break every legacy chain.
   */
  baseline: BaselineInput;
  planText: string;
}

async function readLineage(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
): Promise<Lineage | Failed> {
  const root = await resolveWorkspaceRoot(fs, env, paths);
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return fail(
      "SETTLE_DOCS_CANON_INVALID",
      `no se puede ubicar el plan: ${canon.error}`,
      "corregí [docs] para conservar el layout canónico y volvé a leer las obligaciones",
    );
  }
  const located = await locatePlanDocument(fs, root, canon.canon.plan, target, {
    outside: "un saldo se lee y se publica sobre un plan, y sobre nada más",
    ambiguous: "pasá la ruta exacta del plan cuyas obligaciones querés saldar",
  });
  if (!located.ok) {
    const code: SettleCode =
      located.reason === "absent"
        ? "SETTLE_PLAN_ABSENT"
        : located.reason === "ambiguous"
          ? "SETTLE_TARGET_AMBIGUOUS"
          : "SETTLE_TARGET_INVALID";
    return fail(code, located.message, located.action);
  }
  const planPath = located.path;

  const documents = await readDocuments(fs, root, planPath, canon.canon.plan);
  if ("failure" in documents) return documents;
  const { planText, specPath, specText, relation } = documents;
  const slug = specSlug(specPath, relation.number);
  if (slug === null) {
    // Degrading to an index path that cannot exist would answer "this plan owes
    // nothing" — a clean bill of health on the exact question the command
    // answers — over a chain that is sitting right there under another name.
    return fail(
      "SETTLE_PLAN_LINEAGE_UNDECLARED",
      `'${specPath}' no expone el slug de la spec: no se puede ubicar su cadena de decisiones`,
      "normalizá el nombre de la spec a 'NNN-spec-<slug>.md' y volvé a leer las obligaciones",
    );
  }
  const baseline = {
    path: specPath,
    number: relation.number,
    digest: functionalSpecDigest(specText),
    legacy_digest: specBaselineDigest(specText),
    criteria: parseSpecCriteria(specText, relation.number),
  };
  const chain = await readNoteIndex(
    fs,
    root,
    noteIndexPath(DEFAULT_DOCS_CANON.decision, relation.number, slug),
    { path: specPath, number: relation.number },
  );
  if (!chain.ok) return verbatim(chain.failures[0], "la cadena de decisiones no se puede leer");
  const composed = composeEffectiveContract(baseline, chain.read.index.notes);
  if (composed.status === "blocked") {
    return verbatim(composed.failures[0], "el contrato efectivo no compone");
  }
  const reading = reconciliationOf(composed.contract, chain.read.index.notes, planText);
  // THE CHAIN IS PER SPEC, AND A SPEC MAY HAVE SEVERAL PLANS. So the obligations
  // of this plan are the ones whose note pinned THIS plan, and nobody else's.
  // Without the filter, naming any plan of the lineage settled its siblings'
  // obligations — under a live run holding one of them, because the open-run
  // guard only ever compares the plan that was named — and it read their class
  // against a handoff section they never had.
  const mine = new Set(
    chain.read.index.notes
      .filter((note) => note.lineage.plan.path === planPath)
      .map((note) => note.id),
  );
  const project = (obligations: PlanReconciliation["pending"]): SettleObligation[] =>
    obligations
      .filter((obligation) => mine.has(obligation.by))
      .map((obligation) => ({
        note: obligation.by,
        index: obligation.index,
        text: obligation.text,
        kind: obligation.kind,
        legacy: obligation.legacy,
        corresponds_to: obligation.corresponds_to ?? null,
        declared_point: obligation.declared_point,
      }));
  return {
    chain: chain.read.index.notes,
    baseline,
    planText,
    listing: {
      plan: planPath,
      spec: specPath,
      compensations: project(reading.pending),
      handoffs: project(reading.handoffs),
      closable: reading.closable,
      current_point: currentResumePoint(planText),
    },
  };
}

// ── the declarations ─────────────────────────────────────────────────────────

const REFERENCE = /^(DEC-(?:[0-9]{3}|[1-9][0-9]{3,}))\[(\d+)\]$/;

/**
 * Parse `DEC-001[0]` and `DEC-001[0]=<evidencia>` into settlements.
 *
 * Every reference is checked against what the plan REALLY owes, and a reference
 * that names something else is refused rather than ignored: a settlement silently
 * dropped would report success over work nobody discharged.
 */
function parseDeclarations(
  declarations: SettleDeclarations,
  listing: SettleListing,
): { value: ObligationSettlement[] } | Failed {
  const out: ObligationSettlement[] = [];
  const seen = new Set<string>();
  const entries: Array<[ObligationSettlement["outcome"], readonly string[]]> = [
    ["settled", declarations.settle],
    ["handoff", declarations.handoff],
    ["pending", declarations.pending],
  ];
  for (const [outcome, raw] of entries) {
    for (const item of raw) {
      const parsed = parseDeclaration(item, outcome, listing, seen);
      if ("failure" in parsed) return parsed;
      seen.add(`${parsed.value.note}[${parsed.value.index}]`);
      out.push(parsed.value);
    }
  }
  return { value: out };
}

/** One `DEC-NNN[i]` or `DEC-NNN[i]=<evidencia>`, checked against what is owed. */
function parseDeclaration(
  item: string,
  outcome: ObligationSettlement["outcome"],
  listing: SettleListing,
  seen: ReadonlySet<string>,
): { value: ObligationSettlement } | Failed {
  const [reference, ...rest] = item.split("=");
  const evidence = rest.join("=").trim();
  const match = REFERENCE.exec((reference ?? "").trim());
  if (match === null) {
    return fail(
      "SETTLE_DECLARATION_INVALID",
      `'${item}' no nombra una obligación: se escribe DEC-NNN[posición]${outcome === "settled" ? "=<evidencia>" : ""}`,
      `'aw settle list ${listing.plan}' enumera las obligaciones vigentes con su nota y su posición`,
    );
  }
  const note = match[1] as string;
  const index = Number(match[2]);
  const key = `${note}[${index}]`;
  if (seen.has(key)) {
    return fail(
      "SETTLE_DECLARATION_INVALID",
      `${key} se declara dos veces`,
      "una obligación se salda una vez: decidí cuál de las dos lecturas vale",
    );
  }
  const owed = [...listing.compensations, ...listing.handoffs];
  if (!owed.some((obligation) => obligation.note === note && obligation.index === index)) {
    return fail(
      "SETTLE_OBLIGATION_UNKNOWN",
      `${key} no es una obligación vigente de '${listing.plan}'`,
      `'aw settle list ${listing.plan}' enumera las que sí lo son. Si un 'apply' anterior alcanzó a publicar parte de sus sucesores, esas obligaciones ya están saldadas: volvé a preparar con las que queden`,
    );
  }
  if (outcome === "settled" && evidence.length === 0) {
    return fail(
      "SETTLE_DECLARATION_INVALID",
      `se declara cumplida ${key} sin decir qué lo prueba`,
      `escribí --settle '${key}=<la salida real de lo que lo prueba>': sin evidencia no es un saldo, es una afirmación`,
    );
  }
  return {
    value: { note, index, outcome, ...(outcome === "settled" ? { evidence } : {}) },
  };
}

/** What each carrier's successor would say, derived and never authored. */
function plannedFor(
  chain: readonly DecisionNote[],
  declarations: readonly ObligationSettlement[],
  listing: SettleListing,
): { value: SettlePlanned[] } | Failed {
  const resolved = new Map<string, Map<number, ObligationKind>>();
  for (const obligation of [...listing.compensations, ...listing.handoffs]) {
    const perNote = resolved.get(obligation.note) ?? new Map<number, ObligationKind>();
    perNote.set(obligation.index, obligation.kind);
    resolved.set(obligation.note, perNote);
  }
  const out: SettlePlanned[] = [];
  for (const carrierId of [...new Set(declarations.map((entry) => entry.note))]) {
    const carrier = chain.find((note) => note.id === carrierId);
    if (carrier === undefined) {
      return fail(
        "SETTLE_OBLIGATION_UNKNOWN",
        `${carrierId} no está en la cadena de '${listing.plan}'`,
        `'aw settle list ${listing.plan}' enumera las obligaciones vigentes con su nota`,
      );
    }
    // Every obligation of this carrier whose class NOBODY declared needs a
    // reading from the person, and it needs it here. The successor has to state
    // a class for everything it carries forward — a note being minted may not
    // leave one unclassed — so an obligation left unnamed would be stamped
    // `declared` with the CLI's own inference and never be questioned again.
    // That reading is a person's: F2 built a whole boundary for it.
    const unread = unreadLegacy(carrier, declarations, listing);
    if (unread.length > 0) {
      return fail(
        "SETTLE_DECLARATION_INVALID",
        `${carrierId} carga obligaciones cuya clase nadie declaró y que no declaraste: ${unread.join("; ")}`,
        "el sucesor tiene que decir la clase de todo lo que arrastra, así que la lectura de cada una es tuya: declarala con --settle '<ref>=<evidencia>' o con --handoff '<ref>'",
      );
    }
    const execution = {
      session: carrier.lineage.execution.session,
      phase: carrier.lineage.execution.phase,
    };
    const derived = deriveSettlementNote(carrier, declarations, {
      ...execution,
      date: new Date().toISOString().slice(0, 10),
      resolved: resolved.get(carrierId) ?? new Map(),
    });
    if (!derived.ok) return verbatim(derived.failures[0], "el saldo no se puede derivar");
    if (derived.draft === null) continue;
    const evidenceOf = new Map(
      declarations
        .filter((entry) => entry.note === carrierId && entry.evidence !== undefined)
        .map((entry) => [carrier.obligations[entry.index]?.text ?? "", entry.evidence as string]),
    );
    out.push({
      note: carrierId,
      settled: derived.settled.map((text) => ({ text, evidence: evidenceOf.get(text) ?? "" })),
      keeps: derived.draft.obligations.map((obligation) => ({
        text: obligation.text,
        kind: obligation.kind,
        declared: obligation.declared,
      })),
      execution,
    });
  }
  if (out.length === 0) {
    return fail(
      "SETTLE_DECLARATION_INVALID",
      "ninguna declaración cambia la cadena: dejar todo pendiente no publica nada",
      "declará al menos una obligación cumplida con su evidencia o reconocida como traspaso",
    );
  }
  return { value: out };
}

/**
 * Obligations of this carrier whose class nobody declared and nobody read.
 *
 * Only the ones this settlement would carry FORWARD matter: one being discharged
 * leaves the chain, so its class stops being anybody's claim.
 */
function unreadLegacy(
  carrier: DecisionNote,
  declarations: readonly ObligationSettlement[],
  listing: SettleListing,
): string[] {
  const owed = [...listing.compensations, ...listing.handoffs];
  const out: string[] = [];
  for (const [index, obligation] of carrier.obligations.entries()) {
    if (obligation.declared) continue;
    // Not in force any more: superseded reasoning already left it behind.
    if (!owed.some((entry) => entry.note === carrier.id && entry.index === index)) continue;
    const declared = declarations.find(
      (entry) => entry.note === carrier.id && entry.index === index,
    );
    if (declared !== undefined && declared.outcome !== "pending") continue;
    out.push(`${carrier.id}[${index}] ${obligation.text}`);
  }
  return out;
}

function specSlug(path: string, number: string): string | null {
  const prefix = `${number}-spec-`;
  const file = basename(path);
  if (!file.startsWith(prefix) || !file.endsWith(".md")) return null;
  const slug = file.slice(prefix.length, -".md".length);
  return slug.length > 0 ? slug : null;
}

/** The exact command that applies exactly this — flags and all, never a shape. */
function applyCommand(plan: string, declarations: SettleDeclarations, digest: string): string {
  const flags = [
    ...declarations.settle.map((item) => `--settle ${quoted(item)}`),
    ...declarations.handoff.map((item) => `--handoff ${quoted(item)}`),
    ...declarations.pending.map((item) => `--pending ${quoted(item)}`),
  ];
  return `aw settle apply ${plan} ${flags.join(" ")} --approval ${digest}`;
}

/**
 * One shell argument, quoted so that pasting it back yields the SAME string.
 *
 * Evidence is prose somebody typed and prose contains apostrophes. Wrapping it
 * naively produced a command that re-split into a different declaration — and a
 * different declaration that still matched the approval, which is the one thing
 * the two-step exists to make impossible.
 */
function quoted(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * A refusal from the chain or the composition, carried VERBATIM.
 *
 * Re-coding it would hide which guarantee stopped the settlement behind a word
 * invented at this layer, and the action a person reads would stop matching what
 * actually happened.
 */
function verbatim(failure: NoteFailure | undefined, fallback: string): Failed {
  // A refusal always comes with at least one failure — every producer pushes
  // before returning — so the fallback is the shape TypeScript needs for an
  // index access, not a case anybody can reach.
  return {
    status: "failed",
    failure: failure ?? {
      code: "SETTLE_DECLARATION_INVALID",
      message: fallback,
      action: "corregí la cadena antes de saldar nada",
    },
  };
}

/** The plan, the spec it derives from, and the relation that ties them. */
async function readDocuments(
  fs: FileSystemPort,
  root: string,
  planPath: string,
  planDir: string,
): Promise<
  { planText: string; specPath: string; specText: string; relation: { number: string } } | Failed
> {
  let planText: string;
  try {
    planText = await fs.readText(join(root, planPath));
  } catch {
    return fail(
      "SETTLE_PLAN_ABSENT",
      `'${planPath}' no se puede leer: no hay plan cuyas obligaciones saldar`,
      `verificá la ruta del plan bajo '${planDir}/' o su correlativo`,
    );
  }
  const relation = parseSpecRelation(planText);
  const specPath = parseDerivedFromPath(planText);
  if (relation.status !== "declared" || specPath === null) {
    return fail(
      "SETTLE_PLAN_LINEAGE_UNDECLARED",
      `'${planPath}' no declara una única spec de origen: sin linaje no hay cadena de decisiones`,
      "abrí el plan con /w:plan-refine y declarale un único '> Derived from docs/specs/NNN-spec-…'; un plan sin spec registra sus decisiones en el DECISION.md de su sesión",
    );
  }
  try {
    return {
      planText,
      specPath,
      specText: await fs.readText(join(root, specPath)),
      relation: { number: relation.number },
    };
  } catch {
    return fail(
      "SETTLE_SPEC_UNREADABLE",
      `'${specPath}' no se puede leer: no hay contrato contra el que componer la cadena`,
      "restaurá la spec de origen del plan y volvé a leer las obligaciones",
    );
  }
}
