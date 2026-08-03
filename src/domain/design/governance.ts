import { createHash } from "node:crypto";
import { canonicalJson } from "../../application/semantic-operation/protocol.js";
import { isCalendarDate } from "./baseline.js";
import { isDigest, parseBaselineRef } from "./identity.js";
import type { DesignManifest } from "./manifest.js";
import {
  type AllowedKeys,
  type DesignFailure,
  Reader,
  isNonEmptyString,
  isRecord,
} from "./validation.js";

/**
 * Governance: four dimensions that move independently (AC-SEM-06).
 *
 * Maturity says whether a design is finished. Review says whether a human
 * agreed with it. Currentness says whether a newer revision exists. Execution
 * policy says whether any of that is required to implement. Collapsing any two
 * of them is the mistake this module exists to prevent — which is why a
 * superseded revision stays executable, an approval never reaches the next
 * revision, and only an explicit revocation forbids anything.
 *
 * Records live OUTSIDE the baseline they decide on. A review inside its own
 * baseline would change that baseline's digest, so the thing being approved
 * would no longer be the thing that was approved.
 */

export type ReviewDecision = "proposed" | "approved" | "rejected";

export interface DesignReview {
  schema: string;
  id: string;
  /** The exact baseline decided on: `DES-001@r2`. */
  target: string;
  /** The digest that baseline had. A record decides on BYTES, not on a name. */
  target_digest: string;
  author: string;
  date: string;
  decision: ReviewDecision;
  evidence: string[];
  digest: string;
}

export interface DesignRevocation {
  schema: string;
  id: string;
  target: string;
  target_digest: string;
  author: string;
  date: string;
  reason: string;
  digest: string;
}

export type GovernanceRecord = DesignReview | DesignRevocation;

export interface GovernanceValidation<T> {
  ok: boolean;
  value: T | null;
  failures: DesignFailure[];
  touched: ReadonlySet<string>;
}

export const REVIEW_ALLOWED_KEYS: AllowedKeys = {
  "": [
    "schema",
    "id",
    "target",
    "target_digest",
    "author",
    "date",
    "decision",
    "evidence",
    "digest",
  ],
};

export const REVOCATION_ALLOWED_KEYS: AllowedKeys = {
  "": ["schema", "id", "target", "target_digest", "author", "date", "reason", "digest"],
};

const DECISIONS: ReadonlySet<string> = new Set(["proposed", "approved", "rejected"]);

/**
 * A record's own digest, over its canonical JSON WITHOUT `digest`.
 *
 * The same rule a baseline uses. Including the field would make the record
 * unverifiable — you cannot hash a value that contains its own hash.
 */
export function computeRecordDigest(record: Omit<GovernanceRecord, "digest">): string {
  const { digest: _drop, ...rest } = record as GovernanceRecord;
  return `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
}

export function validateDesignReview(
  raw: unknown,
  artifact: string,
): GovernanceValidation<DesignReview> {
  const r = new Reader(REVIEW_ALLOWED_KEYS);
  const common = readCommon(r, raw, artifact, "REV", "workline.design-review/v1");
  if (common === null) return { ok: false, value: null, failures: r.failures, touched: r.touched };

  const decision = r.read(common.node, "decision");
  const evidence = r.read(common.node, "evidence");
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    r.invalid(
      artifact,
      "'decision' debe ser 'proposed', 'approved' o 'rejected'",
      "una revisión nace 'proposed'; solo 'approved' concede algo",
    );
  }
  if (!Array.isArray(evidence) || !evidence.every(isNonEmptyString)) {
    r.invalid(
      artifact,
      "'evidence' debe ser una lista de strings",
      "usá [] si la decisión no cita nada: la evidencia nunca reemplaza a la decisión",
    );
  } else if (new Set(evidence).size !== evidence.length) {
    r.fail(
      "DESIGN_ID_DUPLICATE",
      artifact,
      "'evidence' repite una entrada",
      "citar dos veces la misma fuente no la hace más evidencia",
    );
  }
  if (r.failures.length > 0)
    return { ok: false, value: null, failures: r.failures, touched: r.touched };

  const value: DesignReview = {
    ...common.value,
    schema: "workline.design-review/v1",
    decision: decision as ReviewDecision,
    evidence: evidence as string[],
  };
  return finish(r, value, artifact);
}

export function validateDesignRevocation(
  raw: unknown,
  artifact: string,
): GovernanceValidation<DesignRevocation> {
  const r = new Reader(REVOCATION_ALLOWED_KEYS);
  const common = readCommon(r, raw, artifact, "RVK", "workline.design-revocation/v1");
  if (common === null) return { ok: false, value: null, failures: r.failures, touched: r.touched };

  const reason = r.read(common.node, "reason");
  if (!isNonEmptyString(reason)) {
    r.invalid(
      artifact,
      "'reason' es obligatorio y no puede estar vacío",
      "un bloqueo sin razón no es auditable",
    );
    return { ok: false, value: null, failures: r.failures, touched: r.touched };
  }
  const value: DesignRevocation = {
    ...common.value,
    schema: "workline.design-revocation/v1",
    reason,
  };
  return finish(r, value, artifact);
}

interface CommonRecord {
  node: Record<string, unknown>;
  value: Omit<GovernanceRecord, "decision" | "evidence" | "reason" | "schema">;
}

function readCommon(
  r: Reader,
  raw: unknown,
  artifact: string,
  prefix: "REV" | "RVK",
  schema: string,
): CommonRecord | null {
  if (!isRecord(raw)) {
    r.fail(
      "DESIGN_RECORD_NOT_OBJECT",
      artifact,
      "el record de gobierno no es un objeto JSON",
      "un record es un documento JSON con su propio digest",
    );
    return null;
  }
  r.closed(raw, "", artifact);

  const declared = r.read(raw, "schema");
  const id = r.read(raw, "id");
  const target = r.read(raw, "target");
  const targetDigest = r.read(raw, "target_digest");
  const author = r.read(raw, "author");
  const date = r.read(raw, "date");
  const digest = r.read(raw, "digest");

  if (declared !== schema) {
    r.invalid(
      artifact,
      `'schema' debe ser '${schema}'`,
      "declará el contrato que el record cumple",
    );
  }
  if (typeof id !== "string" || !new RegExp(`^${prefix}-(?:[0-9]{3}|[1-9][0-9]{3,})$`).test(id)) {
    r.invalid(artifact, `'id' debe ser ${prefix}-NNN`, `numerá el record como ${prefix}-001`);
  }
  if (parseBaselineRef(target) === null) {
    r.invalid(
      artifact,
      "'target' debe ser el baseline exacto DES-NNN@rN",
      "un record decide sobre UNA revisión, no sobre un package",
    );
  }
  if (!isDigest(targetDigest)) {
    r.invalid(
      artifact,
      "'target_digest' debe ser el sha256 que ese baseline tenía",
      "sin el digest el record aprueba un nombre, no unos bytes",
    );
  }
  if (!isNonEmptyString(author)) {
    r.invalid(artifact, "'author' es obligatorio", "nombrá a quien decidió, o el rol que lo hizo");
  }
  // Que EXISTA, no solo que tenga la forma: `decisionOn` ordena por esta fecha,
  // así que un 9999-99-99 se ancla arriba y ninguna decisión real lo desplaza.
  if (typeof date !== "string" || !isCalendarDate(date)) {
    r.invalid(artifact, "'date' debe ser un día real AAAA-MM-DD", "fechá la decisión");
  }
  if (!isDigest(digest)) {
    r.invalid(artifact, "'digest' debe ser un sha256", "sellá el record con su propio digest");
  }
  if (r.failures.length > 0) return null;

  return {
    node: raw,
    value: {
      id: id as string,
      target: target as string,
      target_digest: targetDigest as string,
      author: author as string,
      date: date as string,
      digest: digest as string,
    },
  };
}

/** The record's own seal has to match what the record says. */
function finish<T extends GovernanceRecord>(
  r: Reader,
  value: T,
  artifact: string,
): GovernanceValidation<T> {
  const expected = computeRecordDigest(value);
  if (expected !== value.digest) {
    r.fail(
      "DESIGN_DIGEST_MISMATCH",
      artifact,
      `'digest' dice ${value.digest} y el contenido sella ${expected}`,
      "recalculá el digest sobre el JSON canónico sin el campo 'digest'",
    );
    return { ok: false, value: null, failures: r.failures, touched: r.touched };
  }
  return { ok: true, value, failures: [], touched: r.touched };
}

/**
 * What governance says about executing against a baseline.
 *
 * Four independent answers, never collapsed into one boolean: a superseded
 * revision that nobody revoked stays perfectly executable, and a policy that
 * demands approval does not change anybody's maturity.
 */
export interface ExecutionVerdict {
  /** `false` only when an explicit revocation names this exact revision. */
  executable: boolean;
  /** Warnings that do NOT block — a newer revision exists, for instance. */
  notices: string[];
  failures: DesignFailure[];
}

export interface ApprovalPolicy {
  /**
   * Off by default (T7.3). Turning it on demands an `approved` record for the
   * exact baseline — it never promotes an artifact or alters a maturity.
   */
  requireApproval: boolean;
}

export function judgeExecution(
  manifest: DesignManifest,
  baselineRef: string,
  records: GovernanceRecord[],
  policy: ApprovalPolicy,
): ExecutionVerdict {
  const parsed = parseBaselineRef(baselineRef);
  const notices: string[] = [];
  const failures: DesignFailure[] = [];

  if (parsed === null || parsed.package !== manifest.id) {
    return {
      executable: false,
      notices,
      failures: [
        {
          code: "DESIGN_REFERENCE_MISSING",
          artifact: baselineRef,
          message: `'${baselineRef}' no es un baseline de ${manifest.id}`,
          action: "referenciá el baseline exacto DES-NNN@rN del package",
        },
      ],
    };
  }

  const published = manifest.baselines.find((b) => b.revision === parsed.revision);
  if (published === undefined) {
    return {
      executable: false,
      notices,
      failures: [
        {
          code: "DESIGN_REFERENCE_MISSING",
          artifact: baselineRef,
          message: `${manifest.id} no publicó la revisión r${parsed.revision}`,
          action: `revisiones publicadas: ${manifest.baselines.map((b) => `r${b.revision}`).join(", ")}`,
        },
      ],
    };
  }

  const revocation = records.find(
    (record) => isRevocation(record) && decidesOn(record, baselineRef, published.digest),
  );
  if (revocation !== undefined) {
    failures.push({
      code: "DESIGN_REVISION_REVOKED",
      artifact: baselineRef,
      message: `${baselineRef} está revocada: ${(revocation as DesignRevocation).reason}`,
      action: "una revocación explícita es la única prohibición: usá otra revisión",
    });
    return { executable: false, notices, failures };
  }

  // Superseded AVISA y sigue ejecutable: publicar la siguiente no invalida una
  // referencia que alguien fijó a propósito.
  const current = manifest.current_baseline;
  if (current !== null && current.revision > parsed.revision) {
    notices.push(
      `${baselineRef} está superseded por ${manifest.id}@r${current.revision}; sigue ejecutable`,
    );
  }

  if (policy.requireApproval) {
    failures.push(...requireApproved(baselineRef, published.digest, records));
  }
  return { executable: failures.length === 0, notices, failures };
}

/**
 * AC-SEM-10: an approval covers ONE baseline and never the next.
 *
 * A new revision is born `proposed` by construction — there simply is no record
 * naming it — so nothing has to reset anything. Inheritance is impossible rather
 * than forbidden, which is the stronger of the two.
 */
function requireApproved(
  baselineRef: string,
  digest: string,
  records: GovernanceRecord[],
): DesignFailure[] {
  // La decisión VIGENTE, no «¿alguna vez hubo un approved?»: si review fuera un
  // acumulador monótono, una aprobación sería irretirable y el único remedio
  // pasaría a ser una revocación, que es otra dimensión y otra causa.
  if (decisionOn(baselineRef, records, digest) === "approved") return [];
  return [
    {
      code: "DESIGN_APPROVAL_MISSING",
      artifact: baselineRef,
      message: `la política exige aprobación y ${baselineRef} no tiene un review 'approved'`,
      action: "aprobá esa revisión exacta: una aprobación no se hereda de la anterior",
    },
  ];
}

/**
 * Whether a record decides on THIS revision — by name and by BYTES.
 *
 * `target_digest` is what makes the record about a thing instead of about a
 * number: a revision republished with the same number and different content is
 * not the revision anybody approved.
 */
function decidesOn(record: GovernanceRecord, baselineRef: string, digest: string): boolean {
  return record.target === baselineRef && record.target_digest === digest;
}

/**
 * The index and the records have to say the same thing (mirrors `checkBaselineAuthority`).
 *
 * `governance.reviews[]` declares an id, a path, a digest and a target; the file
 * at that path declares its own. Nobody was comparing them, so a manifest could
 * index `REV-001 @r2 sha256:3333…` while the file said `REV-777 @r1 sha256:0a60…`
 * and both halves validated on their own. An index that can disagree with what
 * it indexes is a second, silent source of truth.
 */
export function checkGovernanceAuthority(
  manifest: DesignManifest,
  records: Map<string, GovernanceRecord>,
  packagePath: string,
): DesignFailure[] {
  const failures: DesignFailure[] = [];
  const indexed = [
    ...manifest.governance.reviews.map((e) => ({ ...e, kind: "review" as const })),
    ...manifest.governance.revocations.map((e) => ({ ...e, kind: "revocation" as const })),
  ];

  for (const entry of indexed) {
    const artifact = `${packagePath}/${entry.path}`;
    const record = records.get(entry.path);
    if (record === undefined) {
      failures.push({
        code: "DESIGN_REFERENCE_FILE_MISSING",
        artifact,
        message: `el manifest indexa ${entry.id} y '${entry.path}' no está`,
        action: "restauralo, o sacá la entrada del índice",
      });
      continue;
    }
    for (const [what, indexedValue, realValue] of [
      ["id", entry.id, record.id],
      ["target", entry.target, record.target],
      ["digest", entry.digest, record.digest],
    ] as const) {
      if (indexedValue === realValue) continue;
      failures.push({
        code: "DESIGN_AUTHORITY_CONFLICT",
        artifact,
        message: `el índice dice ${what} ${indexedValue} y el record dice ${realValue}`,
        action: "el record es la autoridad: corregí el índice del manifest",
      });
    }
    const isRev = isReview(record);
    if ((entry.kind === "review") !== isRev) {
      failures.push({
        code: "DESIGN_AUTHORITY_CONFLICT",
        artifact,
        message: `${entry.id} está indexado como ${entry.kind} y el record es otra cosa`,
        action: "una aprobación y una revocación no son intercambiables",
      });
    }
  }
  return failures;
}

export function isReview(record: GovernanceRecord): record is DesignReview {
  return record.schema === "workline.design-review/v1";
}

export function isRevocation(record: GovernanceRecord): record is DesignRevocation {
  return record.schema === "workline.design-revocation/v1";
}

/**
 * The decision standing on a baseline right now.
 *
 * The LAST record by date wins, and a baseline nobody reviewed is `proposed` —
 * the state everything is born in.
 */
export function decisionOn(
  baselineRef: string,
  records: GovernanceRecord[],
  digest?: string,
): ReviewDecision {
  const reviews = records
    .filter(isReview)
    .filter((review) =>
      digest === undefined ? review.target === baselineRef : decidesOn(review, baselineRef, digest),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  return reviews.at(-1)?.decision ?? "proposed";
}
