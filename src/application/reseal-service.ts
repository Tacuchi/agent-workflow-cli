/**
 * Re-sealing a plan's baseline: the cheap exit a legitimate divergence has.
 *
 * The seal digests the spec's FUNCTIONAL payload, so an editorial edit no longer
 * moves it. Two divergences survive that, and both are legitimate:
 *
 * - a plan whose seal is the LEGACY byte-exact digest, which any edit of its
 *   spec — a comma in `## Context` included — turns `divergent`;
 * - a functional change the plan ALREADY covers as written, reviewed by a person
 *   who concluded the plan still holds.
 *
 * Until now the only way out of either was a whole `/w:plan-refine`: thirteen
 * steps, the plan's bytes redrafted, a preview approved and a publication — all
 * of it to make the publication recompute one line. And a divergent plan cannot
 * close (`PLAN_EXEC_DONE_BASELINE_INVALID`), so the cost was not optional.
 *
 * What this is NOT is an automatic repair. A re-seal is a HUMAN ASSERTION —
 * "I read this plan against the spec as it stands and it still holds" — so it is
 * approved explicitly, by the digest of the very proposal that was shown, and it
 * never fires on its own. Nothing here decides that a plan is still valid; it
 * only records that somebody did.
 *
 * The two halves are the retirement's, deliberately: {@link prepareReseal} is
 * read-only and answers with the preview plus the sealed proposal, and
 * {@link applyReseal} RE-RUNS the preparation, demands that the approval still
 * matches what the recomputation produces, and only then publishes under the
 * workspace lock with the plan's own digest as the compare-and-swap base. That is
 * what makes it impossible to overwrite a `plan-exec` publication in flight: if
 * the plan or its spec moved since the preview, the recomputed digest differs and
 * the approval no longer fits.
 */

import { join } from "node:path";
import { type SpecBaseline, formatSpecBaseline, withSpecBaseline } from "../domain/lineage.js";
import { type LocalProposal, baseDigest, sealProposal } from "../domain/proposal.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { resolveCoreDocsCanon } from "./docs-canon-service.js";
import { applyLocalProposal } from "./local-proposal.js";
import { functionalSpecDigest, unclosedSpecFence } from "./parsers/spec-functional.js";
import {
  type ParsedSpecRelation,
  parseDerivedFromPath,
  parsePlanBaselineSeal,
  parseSpecRelation,
} from "./parsers/spec-relation.js";
import { type PathsService, resolveWorkspaceRoot } from "./paths-service.js";
import { locatePlanDocument } from "./plan-locator.js";

/** What the proposal calls itself: one operation, one vocabulary. */
const RESEAL_OPERATION = "reseal.baseline";

/**
 * Every refusal a re-seal OWNS.
 *
 * Closed on purpose, and it is the whole vocabulary {@link prepareReseal} can
 * emit. The publication's own codes (`PROPOSAL_BASE_STALE`, `PROPOSAL_LOCKED`,
 * …) reach a caller of {@link applyReseal} verbatim instead: re-coding them
 * would hide WHICH guarantee stopped the write behind a word invented here.
 */
export type ResealCode =
  | "RESEAL_DOCS_CANON_INVALID"
  | "RESEAL_TARGET_INVALID"
  | "RESEAL_TARGET_AMBIGUOUS"
  | "RESEAL_PLAN_ABSENT"
  | "RESEAL_PLAN_STANDALONE"
  | "RESEAL_PLAN_LINEAGE_UNDECLARED"
  | "RESEAL_PLAN_HEADERLESS"
  | "RESEAL_SPEC_PATH_INVALID"
  | "RESEAL_SPEC_ABSENT"
  | "RESEAL_SPEC_UNREADABLE"
  | "RESEAL_SPEC_FENCE_UNCLOSED"
  | "RESEAL_APPROVAL_MISMATCH";

export interface ResealFailure {
  /** A {@link ResealCode}, or the publication's own when the write refused. */
  code: string;
  message: string;
  /** One valid next move — never a dead end. */
  action: string;
}

/** Everything a person needs before asserting that the plan still holds. */
export interface ResealPreview {
  /** Workspace-relative path of the plan whose seal is rewritten. */
  plan: string;
  /** Workspace-relative path of the spec the plan declares as its source. */
  spec: string;
  /** The digest the plan seals TODAY; `null` when it seals nothing. */
  sealed_digest: string | null;
  /** The spec's functional digest as it reads now — what the seal becomes. */
  current_digest: string;
  /** The exact `> Baseline: …` line the plan is going to carry. */
  baseline_line: string;
}

export type ResealPreparation =
  | { status: "prepared"; preview: ResealPreview; proposal: LocalProposal }
  /** The seal already IS the current one: idempotent, and nothing is written. */
  | { status: "already"; preview: ResealPreview }
  | { status: "failed"; failure: ResealFailure };

export type ResealApplication =
  | {
      status: "applied";
      preview: ResealPreview;
      /** The approved seal, echoed back so a report can be audited. */
      digest: string;
      written: string[];
      /** The bytes were already on disk — a re-entry, not a fresh write. */
      already_applied: boolean;
    }
  | { status: "already"; preview: ResealPreview }
  | { status: "failed"; failure: ResealFailure };

export interface ApplyResealInput {
  /** The plan: a workspace-relative path, or its correlative. */
  target: string;
  /** The digest `prepare` showed. Nothing is written unless it still fits. */
  approval: string;
}

type Failed = { status: "failed"; failure: ResealFailure };

function fail(code: ResealCode, message: string, action: string): Failed {
  return { status: "failed", failure: { code, message, action } };
}

/**
 * Everything a re-seal would write, having written nothing.
 *
 * Read-only so it is safe to run on the wrong target — which is exactly what
 * somebody about to assert "this plan still holds" needs to be able to do. The
 * preview a person reads, the digest they approve and the bytes `apply` publishes
 * are three views of ONE record, so "what I was shown" and "what will happen"
 * cannot drift into two descriptions that disagree.
 */
export async function prepareReseal(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
): Promise<ResealPreparation> {
  const root = await resolveWorkspaceRoot(fs, env, paths);
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return fail(
      "RESEAL_DOCS_CANON_INVALID",
      `no se puede ubicar el plan: ${canon.error}`,
      "corregí [docs] para conservar el layout canónico y volvé a preparar el re-sello",
    );
  }
  const located = await locatePlan(fs, root, canon.canon.plan, target);
  if ("failure" in located) return located as Failed;
  const planPath = located.path;

  let planText: string;
  try {
    planText = await fs.readText(join(root, planPath));
  } catch {
    return fail(
      "RESEAL_PLAN_ABSENT",
      `'${planPath}' no se puede leer: no hay plan al que re-sellarle el baseline`,
      `verificá la ruta del plan bajo '${canon.canon.plan}/' y volvé a preparar el re-sello`,
    );
  }

  const declared = sealableSpec(planPath, planText, canon.canon.spec);
  if ("failure" in declared) return declared;
  const derived = declared.path;

  const specAbsolute = join(root, derived);
  if (!(await fs.exists(specAbsolute))) {
    return fail(
      "RESEAL_SPEC_ABSENT",
      `'${derived}' no está en el workspace: no hay contrato vigente contra el que sellar`,
      `restaurá la spec en '${canon.canon.spec}/' o corregí el '> Derived from …' del plan`,
    );
  }
  let specText: string;
  try {
    specText = await fs.readText(specAbsolute);
  } catch (err) {
    return fail(
      "RESEAL_SPEC_UNREADABLE",
      `'${derived}' no se puede leer: ${err instanceof Error ? err.message : String(err)}`,
      "resolvé el acceso a la spec y volvé a preparar el re-sello: un sello sobre bytes que no se leyeron no afirma nada",
    );
  }

  const fence = unclosedSpecFence(specText);
  if (fence !== null) {
    // With a fence open the spec has no visible contract sections, so the
    // functional digest degrades to the exact bytes: sealing that would pin a
    // digest guaranteed to diverge again on the next editorial edit, and the
    // person would come back here forever. The exit is upstream, in the spec.
    return fail(
      "RESEAL_SPEC_FENCE_UNCLOSED",
      `'${derived}' tiene un fence sin cerrar en la línea ${fence + 1}: sus secciones de contrato no se ven y el sello caería al byte-exacto, que vuelve a divergir con cualquier edición`,
      `cerrá la fence abierta en la línea ${fence + 1} de '${derived}' y volvé a preparar el re-sello`,
    );
  }

  const baseline: SpecBaseline = {
    path: derived,
    number: declared.number,
    digest: functionalSpecDigest(specText),
  };
  const seal = parsePlanBaselineSeal(planText, canon.canon.spec);
  const preview: ResealPreview = {
    plan: planPath,
    spec: derived,
    sealed_digest: seal.status === "sealed" ? seal.baseline.digest : null,
    current_digest: baseline.digest,
    baseline_line: formatSpecBaseline(baseline),
  };

  const next = withSpecBaseline(planText, baseline);
  if (next === planText) {
    // Two ways the stamp is a no-op, and they mean opposite things. The seal is
    // already the current one — idempotent — or the document has no header
    // blockquote for the line to live in, and inventing one would restructure
    // somebody's plan so a field fits.
    if (seal.status === "sealed" && seal.baseline.digest === baseline.digest) {
      return { status: "already", preview };
    }
    return fail(
      "RESEAL_PLAN_HEADERLESS",
      `'${planPath}' no tiene blockquote de cabecera donde vive el sello: el re-sello no reestructura el plan para que quepa un campo`,
      "escribí la cabecera del plan como blockquote ('> Derived from <ruta de la spec>') y volvé a preparar el re-sello",
    );
  }

  return {
    status: "prepared",
    preview,
    proposal: sealProposal({
      operation: RESEAL_OPERATION,
      artifacts: [{ path: planPath, content: next, overwrite: true }],
      // The plan's CURRENT digest, so the write lands on the bytes the preview
      // was computed from and on no others.
      bases: [{ path: planPath, digest: baseDigest(planText) }],
      effects: ["mutate_overwrite"],
      requiresApproval: ["mutate_overwrite"],
    }),
  };
}

/**
 * Land exactly the line that was previewed, or nothing at all.
 *
 * The preparation runs AGAIN, from the live workspace, and the approval is
 * compared against what THAT produces. Trusting the digest a preview handed back
 * would authorize a state that may no longer exist — and the state that moves
 * here is not hypothetical: `plan-exec` publishes into the same plan while a
 * person reads a preview. Under that recomputation `applyLocalProposal` adds the
 * lock, the compare-and-swap on the plan's bytes and the all-or-nothing write,
 * which is why none of the three is re-implemented here.
 */
export async function applyReseal(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ApplyResealInput,
): Promise<ResealApplication> {
  const prepared = await prepareReseal(fs, env, paths, input.target);
  if (prepared.status === "failed") return prepared;
  if (prepared.status === "already") return { status: "already", preview: prepared.preview };

  if (input.approval.trim() !== prepared.proposal.digest) {
    return fail(
      "RESEAL_APPROVAL_MISMATCH",
      "lo aprobado no es lo que se re-sellaría: el plan o su spec cambiaron desde la vista previa",
      `volvé a correr 'aw reseal prepare ${prepared.preview.plan}', leé la vista previa vigente y aprobá ese digest`,
    );
  }

  const root = await resolveWorkspaceRoot(fs, env, paths);
  const applied = await applyLocalProposal(fs, paths, {
    root,
    proposal: prepared.proposal,
    // The one class this exercises, granted by the person who typed the digest.
    // Nothing is self-authorized: overwriting a published contract is exactly
    // what may not happen without somebody saying so.
    approval: { digest: prepared.proposal.digest, granted: ["mutate_overwrite"] },
    selfAuthorized: [],
  });
  if (!applied.ok) {
    return {
      status: "failed",
      failure: {
        code: applied.failure.code,
        message: applied.failure.message,
        action: applied.failure.action,
      },
    };
  }
  return {
    status: "applied",
    preview: prepared.preview,
    digest: prepared.proposal.digest,
    written: applied.result.written,
    already_applied: applied.result.already_applied,
  };
}

/**
 * The spec this plan's HEADER declares, once it is sealable — or the refusal.
 *
 * The path is the seal's hint and the number is its identity, so both have to come
 * from the SAME header declaration. `Derived from` is the only evidence that
 * qualifies: a spec named in `## Origin` prose is a mention, and sealing a version
 * against a mention would pin a contract nobody declared.
 *
 * And the path is then guarded the way every write boundary guards a path a
 * DOCUMENT supplies — the peer that seals from `submit.ts` refuses to seal at all
 * when this fails. What that stops is not hypothetical: the harvesting pattern
 * accepts `.` and `/` after `-spec`, so `docs/specs/040-spec-../../…/secreto.md`
 * is a valid `Derived from` for it, and the board resolves a seal by NUMBER — a
 * digest taken from that file is bytes the board can never match. The person pays
 * the human assertion, the divergence stays, and every later `prepare` answers
 * `already`: a plan left permanently unclosable by the command that exists to
 * close it. Containment is NOT re-checked on top, because the pattern anchors its
 * match at the canon's own spec folder, so a path with no relative segment is
 * already inside it (unlike `locatePlan`, whose target comes from a person's argv).
 */
function sealableSpec(
  planPath: string,
  planText: string,
  specDir: string,
): { path: string; number: string } | Failed {
  const derived = parseDerivedFromPath(planText, specDir);
  const relation = parseSpecRelation(planText, specDir);
  if (relation.status === "standalone") {
    return fail(
      "RESEAL_PLAN_STANDALONE",
      `'${planPath}' se declara standalone ('> Standalone: …'): un plan nacido de la conversación no deriva de ninguna spec, así que no hay versión contra la que re-sellar`,
      "si en realidad deriva de una spec, declarala con '> Derived from <ruta de la spec>' en su cabecera; si no deriva de ninguna, no hay baseline que re-sellar y su sello ausente no es un defecto",
    );
  }
  if (derived === null || relation.status !== "declared" || relation.evidence !== "derived-from") {
    return undeclaredHeaderLineage(planPath, relation, specDir);
  }
  const safe = checkSafeRelativePath(derived);
  if (!safe.ok) {
    return fail(
      "RESEAL_SPEC_PATH_INVALID",
      `el '> Derived from' de '${planPath}' apunta a '${derived}', que no es una ruta del workspace: ${safe.why}`,
      `corregí el '> Derived from ${specDir}/NNN-spec-<slug>.md' del plan y volvé a preparar el re-sello: el sello se digiere de la spec que el tablero resuelve por número, y un archivo fuera de esa carpeta dejaría sello y tablero digiriendo dos documentos distintos`,
    );
  }
  return { path: derived, number: relation.number };
}

/**
 * Why a header that is not standalone still cannot be sealed — said about the
 * document that got the refusal.
 *
 * One code, four sentences, because four different populations reach here and each
 * one is a different repair. Answering all of them "this plan is standalone" was
 * the defect worth naming: the LEGACY plan that declares its spec in `## Origin`
 * is precisely the population that carries a byte-exact seal, so it is the one the
 * board sends here most often — and telling it that it declares no spec is false
 * twice over, leaving a plan that cannot close and two surfaces contradicting each
 * other about the same document.
 */
function undeclaredHeaderLineage(
  planPath: string,
  relation: ParsedSpecRelation,
  specDir: string,
): Failed {
  const code: ResealCode = "RESEAL_PLAN_LINEAGE_UNDECLARED";
  const stamped = "el sello se estampa desde el '> Derived from …' de la cabecera";
  if (relation.status === "declared" && relation.evidence !== "derived-from") {
    return fail(
      code,
      `'${planPath}' declara la spec ${relation.number} en '## Origin' y no en su cabecera: ${stamped}, y una mención en prosa no dice de qué ARCHIVO leer la versión vigente`,
      `agregá '> Derived from ${specDir}/${relation.number}-spec-<slug>.md' a la cabecera del plan y volvé a preparar el re-sello`,
    );
  }
  if (relation.status === "declared") {
    return fail(
      code,
      `el '> Derived from' de '${planPath}' nombra más de una ruta para la spec ${relation.number}: ${stamped}, y dos rutas no sellan UNA versión`,
      "dejá una sola ruta de spec en el '> Derived from' del plan y volvé a preparar el re-sello",
    );
  }
  if (relation.status === "ambiguous") {
    return fail(
      code,
      `'${planPath}' nombra más de una spec de origen (${relation.numbers.join(", ")}): ${stamped}, y dos orígenes no sellan UNA versión`,
      "dejá una sola spec de origen en el plan y volvé a preparar el re-sello",
    );
  }
  return fail(
    code,
    `'${planPath}' no declara ninguna spec de origen ni se declara standalone: sin spec declarada no hay versión contra la que re-sellar`,
    `si el plan deriva de una spec, declarala con '> Derived from ${specDir}/NNN-spec-<slug>.md'; si nació de la conversación, declaralo con '> Standalone: <de dónde salió>' y no hay baseline que re-sellar`,
  );
}

/**
 * The plan a target names: an exact workspace-relative path, or a correlative
 * resolved against the documentary canon.
 *
 * The short form exists because typing the whole slug to fix one line is
 * ceremony, and it resolves against the CANON rather than a literal `docs/plans`
 * so a workspace that declares its own plan folder is read the way every other
 * surface reads it. A path is checked with the same guard every write boundary
 * uses and then required to be INSIDE that folder — comparing segments, so
 * `docs/plans-viejos` never passes as `docs/plans`: a re-seal writes a plan's
 * header, and nothing else in the tree is a plan.
 */
/** The plan this re-seal was pointed at, with the codes a re-seal owns. */
async function locatePlan(
  fs: FileSystemPort,
  root: string,
  planDir: string,
  target: string,
): Promise<{ path: string } | Failed> {
  const located = await locatePlanDocument(fs, root, planDir, target, {
    outside: "el re-sello escribe la cabecera de un plan y nada más",
    ambiguous: "pasá la ruta exacta del plan que querés re-sellar",
  });
  if (located.ok) return { path: located.path };
  const code: ResealCode =
    located.reason === "absent"
      ? "RESEAL_PLAN_ABSENT"
      : located.reason === "ambiguous"
        ? "RESEAL_TARGET_AMBIGUOUS"
        : "RESEAL_TARGET_INVALID";
  return fail(code, located.message, located.action);
}
