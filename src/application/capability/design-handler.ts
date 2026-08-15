/**
 * The built-in floor of `design`.
 *
 * "Floor" is not a placeholder: it is the implementation a core gate can count
 * on when nothing extra is installed, and it is the same code an improvement
 * gets compared against. It is built entirely out of what already exists —
 * the package index, the published validators, the adapter registry, the
 * semantic handshake — because a floor that reimplemented the design domain
 * would be a second design domain.
 *
 * The split between the CLI and the agent is the repo's usual one, and it is why
 * the authoring operations answer `needs_input` first: the CLI owns identity,
 * destinations, limits, validation and writing; the AGENT authors the content.
 * `create` cannot invent a package body, so it says what a valid answer must
 * contain and waits for one — that is a question, not a failure.
 */

import { join } from "node:path";
import type {
  CapabilityFailure,
  CapabilityInputValue,
  ValidationOutcome,
} from "../../domain/capability/protocol.js";
import { requireAdapter } from "../../domain/design/adapter.js";
import type { DesignMaturity } from "../../domain/design/artifact.js";
import { DESIGN_DESCRIPTOR, DESIGN_OPERATIONS } from "../../domain/design/capability.js";
import {
  type DesignReceiptFields,
  type OutputRoot,
  attainedMaturity,
  isIndexable,
  resolveOutputRoot,
} from "../../domain/design/direct.js";
import {
  type ExpansionVerdict,
  deriveStructuralSignals,
  judgeExpansion,
} from "../../domain/design/expansion.js";
import {
  DESIGN_MANIFEST_FILE,
  DESIGN_MANIFEST_SCHEMA_ID,
  type DesignManifest,
} from "../../domain/design/manifest.js";
import { PROJECTIONS } from "../../domain/design/naming.js";
import { DESIGN_ADAPTERS } from "../../domain/design/profiles.js";
import {
  SIMPLE_CORE_SECTIONS,
  SIMPLE_DESIGN_FILE,
  SIMPLE_SECTIONS,
  designFolder,
  designSlug,
  nextPackageId,
  simpleMaturity,
  validateSimpleDesign,
} from "../../domain/design/simple.js";
import {
  type DesignSource,
  type SourceReport,
  classifySource,
  reportSources,
} from "../../domain/design/sources.js";
import { type CoreDocsCanon, DEFAULT_CORE_DOCS_CANON } from "../../domain/docs-canon.js";
import type { ProposalBase } from "../../domain/proposal.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { localDateIso } from "../dates.js";
import { type ConsumerDocument, readConsumerDocument } from "../design/consumer-document.js";
import { currentEntries, gatePackageContent } from "../design/design-content-gate-service.js";
import {
  type DesignIndex,
  type DesignPackageEntry,
  readDesignIndex,
  resolveDesignPackage,
} from "../design/design-index-service.js";
import {
  type PackageCandidateInput,
  buildPackageCandidate,
} from "../design/design-publish-service.js";
import { checkRecordPrecondition } from "../design/design-record-service.js";
import {
  type SimpleTarget,
  buildSimpleProposal,
  resolveSimpleTarget,
} from "../design/design-simple-service.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import { buildSemanticRequest, parseSemanticResponse } from "../semantic-operation/protocol.js";
import type { PublishableArtifact } from "../semantic-operation/publish.js";
import type { CapabilityHandler, HandlerContext, HandlerResult } from "./dispatcher.js";
import { registerCapability } from "./dispatcher.js";

/** Artefact ceilings for one authored revision. Generous, and still a ceiling. */
const LIMITS = { max_artifacts: 60, max_artifact_bytes: 256_000 };

/** The two operations that AUTHOR content, and therefore the only ones a route applies to. */
const AUTHORING_OPERATIONS: readonly string[] = ["create", "update"];

export const designHandler: CapabilityHandler = {
  descriptor: DESIGN_DESCRIPTOR,
  async run(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.operation.name === "validate") return validatePackage(ctx);
    return authoring(ctx);
  },
};

registerCapability(designHandler);

/**
 * Judge a package without writing anything.
 *
 * The one operation that survives `off`, so it deliberately depends on nothing
 * but the workspace it was pointed at: it reads the index, resolves BY IDENTITY
 * (never by path) and reports the validator's own verdict.
 */
async function validatePackage(ctx: HandlerContext): Promise<HandlerResult> {
  const id = inputValue(ctx, "package");
  if (typeof id !== "string" || id.trim().length === 0) {
    return { kind: "needs_input", gaps: ["la identidad del package a validar, p. ej. 'DES-001'"] };
  }
  if (ctx.workspace === null) {
    return {
      kind: "blocked",
      failure: {
        code: "DESIGN_WORKSPACE_ABSENT",
        message: "no hay workspace donde buscar el package",
        action: "corré la validación desde el workspace que contiene docs/designs/",
      },
    };
  }

  const index = await readDesignIndex(ctx.fs, ctx.workspace);
  const found = resolveDesignPackage(index, id.trim());
  if (found === null) {
    return {
      kind: "blocked",
      failure: {
        code: "DESIGN_PACKAGE_NOT_FOUND",
        message: `no hay ningún package con identidad ${id}`,
        action: `revisá 'aw designs' para ver las identidades publicadas bajo ${index.root}/`,
      },
    };
  }

  // The SAME content gate `aw designs` runs. Judging a package with the
  // structural check alone answered `handoff` for a tree the listing then
  // rejected — the verdict and the listing have to be the same verdict.
  const content = await gatePackageContent(ctx.fs, ctx.workspace, found);
  const failures = [...found.failures, ...content];
  const ok = found.ok && content.length === 0;
  const validations: ValidationOutcome[] = [
    {
      id: "design-manifest",
      passed: found.ok,
      detail: found.ok ? null : found.failures.map((f) => `${f.code}: ${f.message}`).join("; "),
    },
    {
      id: "design-content",
      passed: content.length === 0,
      detail:
        content.length === 0 ? null : content.map((f) => `${f.code}: ${f.message}`).join("; "),
    },
  ];
  const report = reportSources([], `${id}`);
  const simple = found.mode === "simple";
  const gate = ok
    ? await publishedMaturity(ctx.fs, ctx.workspace, found)
    : { attained: "outline" as const, reasons: failures.map((f) => f.message) };
  const maturity = attainedMaturity(requestedMaturity(ctx), gate.attained, report);
  const fields: DesignReceiptFields = {
    package: found.id,
    baseline:
      found.current_baseline === null
        ? null
        : { revision: found.current_baseline.revision, digest: found.current_baseline.digest },
    // A verdict publishes nothing, so there is nothing it could have failed to
    // seal: the package's own baseline above is the whole answer.
    unsealed: null,
    path: found.path,
    root: "workspace",
    indexable: true,
    maturity: { requested: requestedMaturity(ctx), attained: maturity.attained },
    sources: [],
    renditions: [],
    // Judging an existing design reports the route it IS, not one this attempt
    // chose: the signals that expanded it were recorded when it was published,
    // and re-deriving them now from a different invocation would invent a cause.
    route: { mode: simple ? "simple" : "package", signals: [], cause: null },
  };

  return {
    kind: "completed",
    validations,
    output: {
      value: { design: fields, ok, failures, gaps: [...gate.reasons, ...maturity.gaps] },
      reference:
        found.id === null || found.current_baseline === null
          ? null
          : {
              id: found.id,
              revision: found.current_baseline.revision,
              digest: found.current_baseline.digest,
              locator: found.path,
            },
      // A verdict is either produced or not; there is no half of one, which is
      // why `validate` declares only `complete` in its descriptor.
      completeness: "complete",
    },
  };
}

/**
 * The authoring operations, through the handshake the repo already uses.
 *
 * `prepare` publishes the contract a valid answer has to satisfy and stops;
 * `validate` parses the answer against that same contract — destinations,
 * limits, staleness — and hands back the artifacts for the durable step. Every
 * rejection there comes from `parseSemanticResponse`, so the authoring path
 * inherits the write boundary rather than restating it.
 */
async function authoring(ctx: HandlerContext): Promise<HandlerResult> {
  // Where the output lands is decided BEFORE anything else: outside a workspace
  // an explicit root is required, and without one nothing is written anywhere.
  const root = resolveOutputRoot(ctx.workspace, ctx.request.context.target, ctx.operation.name);
  if (!root.ok) {
    return {
      kind: "blocked",
      failure: {
        code: root.failure.code,
        message: root.failure.message,
        action: root.failure.action,
      },
    };
  }

  // Outside a workspace every destination this route could declare is ABSOLUTE,
  // and the write boundary only admits workspace-relative paths inside the
  // declared ones: an absolute answer is refused for being absolute and a
  // relative one for falling outside them. No answer exists, so publishing the
  // contract burns an authoring round over a question with no valid reply — and
  // `apply` demands a workspace anyway, so it could never land either. The
  // refusal belongs here, where the root is decided, and not one stage later
  // where it reads as the author's mistake.
  if (ctx.workspace === null) {
    return {
      kind: "blocked",
      failure: {
        code: "DESIGN_WORKSPACE_ABSENT",
        message: `fuera de un workspace los destinos de '${ctx.operation.name}' son absolutos y ninguna respuesta puede caer dentro de ellos`,
        action:
          "corré la operación dentro del workspace donde debe quedar el diseño: 'target' acota la carpeta DENTRO del workspace, no publica fuera de él",
      },
    };
  }
  const workspace = ctx.workspace;

  const consumerInput = inputOf(ctx, "consumer_document");
  let docsCanon: CoreDocsCanon = DEFAULT_CORE_DOCS_CANON;
  // A compound design publication changes a spec or plan in the same durable
  // effect. Resolve the shared documentary roots only when this operation has a
  // consumer (or is required to carry one), so a package-only design remains
  // independent while a consumer can never use a layout custody/retirement do
  // not share.
  if (consumerInput !== undefined || requiresConsumerDocument(ctx)) {
    const resolved = await resolveCoreDocsCanon(ctx.fs, ctx.paths);
    if (!resolved.ok) {
      return {
        kind: "blocked",
        failure: {
          code: "DOCS_CANON_INVALID",
          message: resolved.error,
          action: "corregí [docs] para conservar el layout documental canónico antes de publicar",
        },
      };
    }
    docsCanon = resolved.canon;
  }

  const consumer = readConsumerDocument(consumerInput, docsCanon);
  if (!consumer.ok) return { kind: "blocked", failure: consumer.failure };
  if (requiresConsumerDocument(ctx) && consumer.value === null) {
    return {
      kind: "blocked",
      failure: {
        code: "DESIGN_CONSUMER_REQUIRED",
        message:
          "esta publicación compuesta fija un baseline nuevo y necesita el documento consumidor final",
        action:
          "pasá 'consumer_document' como attachment con los bytes finales, su path de spec/plan y el digest base",
      },
    };
  }

  const precondition = await operationPrecondition(ctx);
  if (precondition !== null) return { kind: "blocked", failure: precondition };

  const sources = declaredSources(ctx);
  const report = reportSources(sources, ctx.operation.name);
  if (report.failures.length > 0) {
    const first = report.failures[0];
    return {
      kind: "blocked",
      failure: {
        code: first?.code ?? "DESIGN_SOURCE_INVALID",
        message: first?.message ?? "una fuente declarada no es reportable",
        action: first?.action ?? "declará la causa de cada fuente que no se usó",
      },
    };
  }

  // Simple by default, and the route is decided BEFORE the contract is published:
  // what a valid answer looks like, and where it may land, are different on the
  // two routes, so asking first and classifying afterwards would publish a
  // contract for a route the run is not on.
  const route = await decideRoute(ctx, workspace, sources, root.value);
  if (!route.ok) return { kind: "blocked", failure: route.failure };

  const request = buildSemanticRequest({
    operation: `${ctx.request.capability}.${ctx.request.operation}`,
    inputs: ctx.request.inputs.map((i) => ({ name: i.name, value: i.value })),
    contract: route.value.contract,
    inventory: route.value.inventory,
    allowedDestinations: route.value.destinations,
    limits: LIMITS,
    readSet: [],
    readSetBytes: 0,
  });

  if (ctx.verb !== "validate") {
    return {
      kind: "needs_input",
      gaps: [
        request.contract,
        `destinos permitidos: ${request.allowed_destinations.join(", ")}`,
        // Answering means quoting this digest back verbatim; naming it here saves
        // the caller from reimplementing `canonicalJson` to recompute it.
        `input_digest: ${request.input_digest}`,
      ],
    };
  }
  if (ctx.answer === null || ctx.answer.trim().length === 0) {
    return {
      kind: "needs_input",
      gaps: ["la respuesta autorada, como un único objeto JSON por stdin"],
    };
  }

  // The answer is DATA to validate. Its own `input_digest` has to match the one
  // this request was built from, which is what stops an answer written against
  // a world that has since moved.
  const parsed = parseSemanticResponse(ctx.answer, request);
  if (!parsed.ok) return { kind: "blocked", failure: parsed.failure };
  const answered = parsed.value.artifacts ?? [];

  const { target } = route.value;
  if (target.mode === "simple") {
    return simpleProposal(
      ctx,
      workspace,
      report,
      route.value,
      target.simple,
      answered,
      consumer.value,
      docsCanon,
    );
  }
  if (target.mode === "package") {
    return packageProposal(
      ctx,
      workspace,
      report,
      route.value,
      target.package,
      answered,
      consumer.value,
      docsCanon,
    );
  }
  return projectionProposal(ctx, workspace, report, route.value, target.projection, answered);
}

/**
 * Which route this attempt is on, with everything that route already fixed.
 *
 * A discriminated union and not two nullable fields: the package route used to
 * carry a null target meaning «publish verbatim», and that third state is
 * exactly the one that wrote artifacts nobody sealed and reported success. A
 * route that cannot name its destination now fails to be a route at all.
 */
type RouteTarget =
  | { mode: "simple"; simple: SimpleTarget }
  | { mode: "package"; package: PackageTarget }
  | { mode: "projection"; projection: ProjectionTarget };

/** The two routes' shared answer: where to write, what to write, and why. */
interface RouteDecision {
  verdict: ExpansionVerdict;
  contract: string;
  inventory: unknown;
  destinations: string[];
  target: RouteTarget;
  root: OutputRoot;
}

/**
 * What a package-route create/update publishes over, fixed before any byte is
 * authored — the mirror of {@link SimpleTarget} on the expanded route.
 */
interface PackageTarget {
  packageId: string;
  /** Workspace-relative package folder. */
  path: string;
  /** The revision this publication will mint: 1 for a new package. */
  revision: number;
  /** The current manifest, or the initial one a create synthesized. */
  manifest: DesignManifest;
  /** The exact manifest snapshot {@link manifest} was resolved from. */
  manifest_base: ProposalBase | null;
}

/**
 * What a `render` or a `record` publishes over — {@link PackageTarget}'s mirror
 * for the operations that mint no revision.
 *
 * There is no baseline to derive and no compare-and-swap to run, so all a route
 * has to fix here is WHERE it writes — a package the index already carries — and
 * WHY nothing gets sealed, because that second half is what the receipt owes.
 */
interface ProjectionTarget {
  /**
   * The package as the index reports it, manifest already validated. The whole
   * entry and not its pieces: what this route publishes over is a design that
   * EXISTS, and its maturity is answered by the same function that answers it
   * for `validate` — which needs to know whether it is a simple design or a
   * package to know what to read.
   */
  entry: IndexedPackage;
  /** Why this publication mints no revision, in the receipt's own words. */
  unsealed: string;
}

type RouteResolution =
  | { ok: true; value: RouteDecision }
  | { ok: false; failure: CapabilityFailure };

/**
 * Which route this attempt runs on, and everything that follows from it.
 *
 * The structural half of the vocabulary is derived here from what the invocation
 * really carries; the semantic half is whatever the caller declared, judged
 * against the same closed list. Nothing else can widen the route: an unknown id
 * or a structural one somebody typed comes back as a rejection in the verdict
 * rather than as an expansion nobody can explain.
 */
async function decideRoute(
  ctx: HandlerContext,
  workspace: string,
  sources: DesignSource[],
  root: OutputRoot,
): Promise<RouteResolution> {
  // Always readable, never null: a workspace with no `docs/designs/` yet answers
  // an EMPTY index, and outside a workspace `authoring` already refused. A
  // nullable index here used to carry a third state that every branch below had
  // to restate and that no invocation could reach.
  const index = await readDesignIndex(ctx.fs, workspace);
  // By IDENTITY and only when one was named. `find(p => p.id === null)` would
  // match the first package whose manifest does not validate — an entry that has
  // no identity is not the one this invocation continues.
  const named = packageInput(ctx);
  const targeted = named === null ? null : (index.packages.find((p) => p.id === named) ?? null);

  const verdict = judgeExpansion(
    declaredExpansionSignals(ctx),
    deriveStructuralSignals({
      sensitiveSources: ctx.request.policy.sensitive_sources === true,
      externalTransmission: ctx.request.policy.external_transmission === true,
      sources,
      governanceRecords:
        (targeted?.manifest?.governance.reviews.length ?? 0) +
        (targeted?.manifest?.governance.revocations.length ?? 0),
      publishedRevisions: targeted?.manifest?.baselines.length ?? 0,
    }),
  );

  // The package route is also the only one available outside `docs/designs/`: a
  // simple design derives its identity from the index, and a root the index does
  // not cover has none to derive from.
  //
  // `render` and `record` are package operations whatever the signals say —
  // projecting revisions and sealing governance decisions are things a catalog
  // has and one document does not. Routing them by the vocabulary would ask a
  // simple design for a maturity and a rendition it never had.
  if (
    verdict.mode === "package" ||
    !AUTHORING_OPERATIONS.includes(ctx.operation.name) ||
    !isIndexable(root)
  ) {
    return packageRoute(ctx, verdict, index, root);
  }

  const resolved = resolveSimpleTarget(index, ctx.operation.name, {
    title: textInput(ctx, "title"),
    packageId: packageInput(ctx),
    root: root.root,
  });
  if (!resolved.ok) {
    const { code, message, action } = resolved.failure;
    return { ok: false, failure: { code, message, action } };
  }

  return {
    ok: true,
    value: {
      verdict,
      contract: simpleContract(resolved.value),
      inventory: {
        root: root.root,
        mode: "simple",
        package: resolved.value.packageId,
        revision: resolved.value.revision,
        document: `${resolved.value.path}/${SIMPLE_DESIGN_FILE}`,
      },
      // The exact file, not its folder: on the simple route the CLI already knows
      // the one destination, so anything else is not a design it can publish.
      destinations: [`${resolved.value.path}/${SIMPLE_DESIGN_FILE}`],
      target: { mode: "simple", simple: resolved.value },
      root,
    },
  };
}

/**
 * The package route. It seals, or it does not run.
 *
 * There used to be a third outcome, declared in the code as a known limitation:
 * when the target could not be derived the answer was written EXACTLY as
 * authored — no baseline, no manifest, no gate — and the receipt said
 * `completed` anyway. The measured effect was a tree `aw designs` refuses right
 * afterwards, which only a hand check ever discovers. An operation that did not
 * happen is a better outcome than a dossier nobody can read, so what used to be
 * a silent half-write is now either a sealed publication or a refusal that names
 * what is missing.
 */
function packageRoute(
  ctx: HandlerContext,
  verdict: ExpansionVerdict,
  index: DesignIndex,
  root: OutputRoot,
): RouteResolution {
  // `render` and `record` author no normative content: a projection is derived
  // from the manifest and a governance decision decides ON a baseline. Minting
  // no revision is their NATURE, not a defect, so they get their own route
  // instead of the refusal that briefly made both unreachable.
  if (!AUTHORING_OPERATIONS.includes(ctx.operation.name)) {
    return projectionRoute(ctx, verdict, index, root);
  }

  const resolved = resolvePackageTarget(ctx, index, root);
  if (!resolved.ok) return { ok: false, failure: resolved.failure };
  const target = resolved.value;
  return {
    ok: true,
    value: {
      verdict,
      contract: packageContract(ctx.operation.name, target),
      inventory: {
        root: root.root,
        mode: "package",
        package: target.packageId,
        revision: target.revision,
        path: target.path,
      },
      // The package folder, not the taxonomy root: the destination check is
      // segment-based, so every artifact lands INSIDE this package or nowhere.
      destinations: [target.path],
      target: { mode: "package", package: target },
      root,
    },
  };
}

/** Why each non-authoring operation mints no revision, said in its own receipt. */
const UNSEALED_CAUSE: Record<string, string> = {
  render:
    "'render' regenera proyecciones: las deriva el CLI del manifest y ningún baseline las selecciona, así que no hay revisión que acuñar",
  record:
    "'record' decide SOBRE una revisión que ya existe: sella una decisión de gobierno y no acuña una línea base nueva",
};

/**
 * The route of an operation that publishes WITHOUT minting a revision.
 *
 * It writes inside a package the index already carries, and refuses when there
 * is none. The two halves are one rule: with a manifest already there the tree
 * stays readable — `aw designs` accepts afterwards exactly what it accepted
 * before, because nothing sealed moves — and without one the files would land in
 * a folder the listing then rejects for having no manifest, which is the
 * illegible tree this plan exists to stop.
 */
function projectionRoute(
  ctx: HandlerContext,
  verdict: ExpansionVerdict,
  index: DesignIndex,
  root: OutputRoot,
): RouteResolution {
  const operation = ctx.operation.name;
  const named = packageInput(ctx);
  if (named === null) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        message: `'${operation}' escribe dentro de un package que ya existe y no se declaró cuál`,
        action: "pasá 'package' con su id, por ejemplo DES-007",
      },
    };
  }
  const located = locatePackage(index, named);
  if (!located.ok) return { ok: false, failure: located.failure };

  const entry = located.value;
  const target: ProjectionTarget = {
    entry,
    unsealed: UNSEALED_CAUSE[operation] ?? `'${operation}' no acuña una revisión`,
  };
  return {
    ok: true,
    value: {
      verdict,
      contract: projectionContract(operation, target),
      inventory: {
        root: root.root,
        mode: entry.manifest.mode,
        package: entry.manifest.id,
        path: entry.path,
        // Consultative and load-bearing: an author who does not know the answer
        // will not be sealed writes a revision nobody asked for.
        seals: false,
      },
      // The package folder the INDEX reports, not the root the invocation named:
      // this operation writes into a package that already exists, wherever it is.
      destinations: [entry.path],
      target: { mode: "projection", projection: target },
      root,
    },
  };
}

/**
 * The package route's target, derived BEFORE the contract is published.
 *
 * `create` mints the identity and the folder from the title, over an initial
 * manifest that exists only to give the candidate builder a line to start from.
 * It needs no index: with none there is no line to continue, and a package
 * written to a declared root numbers from that root. `update` locates the
 * package BY IDENTITY and checks the declared base against the line in force —
 * the compare-and-swap, run at the moment the contract is fixed instead of
 * discovered mid-publish.
 */
type PackageTargetResolution =
  | { ok: true; value: PackageTarget }
  | { ok: false; failure: CapabilityFailure };

function resolvePackageTarget(
  ctx: HandlerContext,
  index: DesignIndex,
  root: OutputRoot,
): PackageTargetResolution {
  return ctx.operation.name === "create"
    ? mintPackageTarget(ctx, index, root)
    : continuePackageTarget(ctx, index);
}

/** A brand-new package: the identity and the folder, from the title and the root. */
function mintPackageTarget(
  ctx: HandlerContext,
  index: DesignIndex,
  root: OutputRoot,
): PackageTargetResolution {
  const title = textInput(ctx, "title");
  if (title === null) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        message: "un package nuevo necesita un título",
        action: "pasá 'title' con el nombre humano del diseño: de ahí salen la carpeta y el id",
      },
    };
  }
  const packageId = nextPackageId(index.packages.map((p) => p.id ?? p.declared_id));
  return {
    ok: true,
    value: {
      packageId,
      // The DECLARED root, not the index's: a `target` that narrows where the
      // package lands has to be where it lands, or the folder and the
      // destination allowlist the request publishes disagree.
      path: designFolder(root.root, packageId, designSlug(title)),
      revision: 1,
      manifest: initialPackageManifest(packageId, title, localDateIso(new Date())),
      manifest_base: null,
    },
  };
}

/**
 * The package an operation writes into, located BY IDENTITY.
 *
 * Shared by the two routes that continue a package that already exists, so
 * "ambiguous", "missing" and "broken" get one diagnosis each: three answers that
 * differ only in wording is how a fix ends up applied to whichever copy the
 * reader happened to hit.
 */
/** An index entry that resolved: the manifest is there and it validated. */
type IndexedPackage = DesignPackageEntry & { manifest: DesignManifest };

type PackageLookup =
  | { ok: true; value: IndexedPackage }
  | { ok: false; failure: CapabilityFailure };

function locatePackage(index: DesignIndex, named: string): PackageLookup {
  // By identity, and never by the FIRST match. Two packages claiming one id
  // break every reference to it, and picking whichever the walk reached first
  // would write into one of them at random.
  const claiming = index.packages.filter((p) => p.id === named || p.declared_id === named);
  if (claiming.length > 1) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_REFERENCE_AMBIGUOUS",
        message: `${named} está declarado por ${claiming.length} packages: ${claiming.map((p) => p.path).join(", ")}`,
        action:
          "dos packages no pueden reclamar la misma identidad: renombrá uno y volvé a intentar",
      },
    };
  }
  const found = claiming[0];
  if (found === undefined) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_PACKAGE_NOT_FOUND",
        message: `no hay ningún package ${named} bajo ${index.root}/`,
        action: `revisá 'aw designs' para ver las identidades publicadas bajo ${index.root}/`,
      },
    };
  }
  // A BROKEN package is not a missing one: they are very different problems for
  // whoever has to fix one, so what comes back is the manifest's own diagnosis
  // and not «no existe».
  if (found.manifest === null) {
    const first = found.failures[0];
    return {
      ok: false,
      failure: {
        code: first?.code ?? "DESIGN_MANIFEST_MISSING",
        message: `${found.manifest_path}: ${first?.message ?? "el package no tiene un manifest legible"}`,
        action: first?.action ?? "reparalo antes de publicar sobre él",
      },
    };
  }
  return { ok: true, value: { ...found, manifest: found.manifest } };
}

/** The next revision of a package that exists: located by identity, base checked. */
function continuePackageTarget(ctx: HandlerContext, index: DesignIndex): PackageTargetResolution {
  const named = packageInput(ctx);
  if (named === null) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        message: "actualizar un package necesita la identidad del que se continúa",
        action: "pasá 'package' con su id, por ejemplo DES-007",
      },
    };
  }
  const located = locatePackage(index, named);
  if (!located.ok) return { ok: false, failure: located.failure };

  const found = located.value;
  const manifest = found.manifest;
  const current = manifest.current_baseline;
  const actual = current === null ? null : `${manifest.id}@r${current.revision}`;
  // The declared base is text on the wire: "null" is how a caller states the
  // package never published, which the failure below already advertised. The
  // null case cannot happen — `decideRoute` demands the input first — and the
  // guard keeps that a fact of this function, not of its caller.
  const declaredRaw = textInput(ctx, "base");
  if (declaredRaw === null) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_FIELD_INVALID",
        message: "actualizar un package declara sobre qué revisión se preparó",
        action:
          "pasá 'base' con la revisión vigente (por ejemplo DES-001@r3), o null si el package no publicó ninguna",
      },
    };
  }
  const declared = declaredRaw === "null" ? null : declaredRaw;
  if (declared !== actual) {
    return {
      ok: false,
      failure: {
        code: "DESIGN_BASE_STALE",
        message: `declaraste base ${declared ?? "ninguna revisión"} y la vigente es ${actual ?? "ninguna"}`,
        action:
          "releé el package y rehacé la revisión sobre la base nueva: una publicada no se reescribe",
      },
    };
  }
  return {
    ok: true,
    value: {
      packageId: manifest.id,
      path: found.path,
      revision: (current?.revision ?? 0) + 1,
      manifest,
      manifest_base: found.manifest_base,
    },
  };
}

/**
 * The manifest a `create` starts from: the empty catalog every package begins
 * with, so the candidate builder sees the same shape it sees on an update. It
 * is never written as-is — the first publication writes the DERIVED one.
 */
function initialPackageManifest(packageId: string, title: string, created: string): DesignManifest {
  return {
    schema: DESIGN_MANIFEST_SCHEMA_ID,
    id: packageId,
    mode: "package",
    title,
    created,
    derived_from: null,
    current_baseline: null,
    baselines: [],
    catalog: { flows: [], screens: [], rules: [], tokens: [], renditions: [], assets: [] },
    currentness: [],
    governance: { reviews: [], revocations: [] },
    relations: { specs: [], plans: [] },
  };
}

/** The simple route's durable step: one authored document, everything else derived. */
async function simpleProposal(
  ctx: HandlerContext,
  workspace: string,
  report: SourceReport,
  route: RouteDecision,
  target: SimpleTarget,
  answered: readonly { path: string; content: string }[],
  consumer: ConsumerDocument | null,
  docsCanon: CoreDocsCanon,
): Promise<HandlerResult> {
  const documentPath = `${target.path}/${SIMPLE_DESIGN_FILE}`;
  const document = answered.find((a) => a.path === documentPath);
  if (answered.length !== 1 || document === undefined) {
    return {
      kind: "blocked",
      failure: {
        code: "DESIGN_FIELD_INVALID",
        message: `un diseño simple es un solo archivo y llegaron ${answered.length}`,
        action: `respondé exactamente un artefacto en '${documentPath}': el manifest, el id, la revisión y el digest los deriva el CLI`,
      },
    };
  }

  const built = await buildSimpleProposal(ctx.fs, workspace, {
    target,
    document: document.content,
    published: localDateIso(new Date()),
    consumer_document: consumer,
    docs_canon: docsCanon,
  });
  if (!built.ok) {
    const first = built.failures[0];
    return {
      kind: "blocked",
      failure: {
        code: first?.code ?? "DESIGN_FIELD_INVALID",
        message: first?.message ?? "el documento no cumple el contrato de un diseño simple",
        action: first?.action ?? "corregí el documento y volvé a responder",
      },
    };
  }

  // The gate's verdict over the document, exactly as the package route takes it
  // from the gate over its own: what the design attains cannot depend on which
  // route wrote it.
  const gate = built.value.maturity;
  const maturity = attainedMaturity(requestedMaturity(ctx), gate.attained, report);
  const fields: DesignReceiptFields = {
    package: built.value.packageId,
    baseline: { revision: built.value.revision, digest: built.value.digest },
    unsealed: null,
    path: target.path,
    root: route.root.kind,
    indexable: true,
    maturity: { requested: requestedMaturity(ctx), attained: maturity.attained },
    sources: report.sources,
    renditions: [],
    route: routeOf(route.verdict),
  };

  return {
    kind: "durable",
    artifacts: built.value.artifacts.map((a) => ({
      path: a.path,
      content: a.content,
      overwrite: a.overwrite,
    })),
    output: {
      value: {
        design: fields,
        artifacts: built.value.artifacts.map((a) => a.path),
        gaps: [...gate.reasons, ...maturity.gaps],
      },
      reference: null,
      completeness: "partial",
    },
    bases: proposalBases(built.value.base, consumer?.base ?? null),
  };
}

/**
 * The expanded route's durable step. The CLI owns the seal, always.
 *
 * The authored artifacts are candidate files, and the manifest, the baseline
 * and `PACKAGE.md` are DERIVED here — the one candidate the whole system
 * publishes, so the gate verdict runs NOW, inside `validate`, and an invalid
 * tree is blocked before the first byte moves.
 */
async function packageProposal(
  ctx: HandlerContext,
  workspace: string,
  report: SourceReport,
  route: RouteDecision,
  target: PackageTarget,
  answered: readonly { path: string; content: string }[],
  consumer: ConsumerDocument | null,
  docsCanon: CoreDocsCanon,
): Promise<HandlerResult> {
  // From workspace-relative to package-relative, which is the vocabulary the
  // candidate builder speaks. The destination check already confined every
  // answer to the package folder, so the prefix always strips.
  const prefix = `${target.path}/`;
  const files: PackageCandidateInput["files"] = [];
  for (const artifact of answered) {
    const relative = artifact.path.slice(prefix.length);
    if (owns(DERIVED_PATHS, relative)) {
      return {
        kind: "blocked",
        failure: {
          code: "DESIGN_FIELD_INVALID",
          message: `'${artifact.path}' no se autora: lo deriva y sella el CLI`,
          action:
            "quitalo de 'artifacts': el CLI deriva y sella design-manifest.json, baselines/ y PACKAGE.md a partir de los artefactos normativos",
        },
      };
    }
    files.push({ path: relative, content: artifact.content });
  }

  const candidate = await buildPackageCandidate(ctx.fs, workspace, {
    manifest: target.manifest,
    packagePath: target.path,
    files,
    published: localDateIso(new Date()),
    consumer_document: consumer,
    docs_canon: docsCanon,
  });
  if (!candidate.ok) {
    // The gate's own verdict, with its real code and next action: this is where
    // an invalid tree stops being publishable instead of being sealed verbatim.
    const first = candidate.failures[0];
    return {
      kind: "blocked",
      failure: {
        code: first?.code ?? "DESIGN_FIELD_INVALID",
        message: first?.message ?? "el package no cumple el contrato de publicación",
        action: first?.action ?? "corregí los artefactos y volvé a responder",
      },
    };
  }

  // The verdict over the catalog this revision LEAVES, not over the files it
  // brings. A revision of a single token introduces no document that could
  // object, and judging only what it introduces answered `handoff` for a package
  // whose current flow was still `outline` — a receipt the `validate` right
  // afterwards contradicted about the same tree.
  const gate = catalogMaturity(candidate.value.manifest);
  const maturity = attainedMaturity(requestedMaturity(ctx), gate.attained, report);
  const fields: DesignReceiptFields = {
    package: target.packageId,
    baseline: { revision: candidate.value.revision, digest: candidate.value.baseline.digest },
    unsealed: null,
    path: target.path,
    root: route.root.kind,
    indexable: isIndexable(route.root),
    maturity: { requested: requestedMaturity(ctx), attained: maturity.attained },
    sources: report.sources,
    renditions: [],
    route: routeOf(route.verdict),
  };

  return {
    kind: "durable",
    artifacts: candidate.value.artifacts,
    output: {
      value: {
        design: fields,
        artifacts: candidate.value.artifacts.map((a) => a.path),
        gaps: [...gate.reasons, ...maturity.gaps],
      },
      reference: null,
      // The durable step has not run yet, so nothing is published. Claiming
      // `complete` here would let a gate accept a proposal as a package.
      completeness: "partial",
    },
    // `target.manifest_base` was captured with the exact bytes parsed into
    // `target.manifest`. A concurrent change therefore fails at apply instead
    // of being accidentally adopted as this candidate's CAS base.
    bases: proposalBases(target.manifest_base, consumer?.base ?? null),
  };
}

/**
 * The durable step of a publication that mints NO revision.
 *
 * What it refuses is the only way one of these operations can leave the package
 * unreadable: a hand-authored manifest or baseline seals the tree with something
 * nobody derived, and `aw designs` rejects it right afterwards. Everything else
 * lands as authored — a projection replaces the one it regenerates, anything
 * else is additive — and the receipt says, in words, that nothing was sealed.
 */
async function projectionProposal(
  ctx: HandlerContext,
  workspace: string,
  report: SourceReport,
  route: RouteDecision,
  target: ProjectionTarget,
  answered: readonly { path: string; content: string }[],
): Promise<HandlerResult> {
  const entry = target.entry;
  const prefix = `${entry.path}/`;
  const artifacts: PublishableArtifact[] = [];
  for (const artifact of answered) {
    const relative = artifact.path.slice(prefix.length);
    if (owns(SEALED_PATHS, relative)) {
      return {
        kind: "blocked",
        failure: {
          code: "DESIGN_FIELD_INVALID",
          message: `'${artifact.path}' es lo que sella el package, y '${ctx.operation.name}' no acuña revisión`,
          action: `quitalo de 'artifacts': ${DESIGN_MANIFEST_FILE} y 'baselines/' los deriva y sella una publicación de contenido normativo, con 'create' o 'update'`,
        },
      };
    }
    artifacts.push({
      path: artifact.path,
      content: artifact.content,
      // Regenerating a projection REPLACES it — that is what regenerating means,
      // and `render` declares `mutate_overwrite` for exactly this. Nothing else
      // is regenerable: a governance record decides on bytes that already exist,
      // so publishing over one would rewrite a decision somebody made.
      overwrite: PROJECTIONS.includes(relative),
    });
  }

  // The design's own maturity, unchanged: this publication catalogues nothing,
  // so reporting anything else would credit or blame it for a verdict it did
  // not move. Through the same function `validate` uses, which is what keeps a
  // simple design judged by its document instead of by an empty catalog.
  const gate = await publishedMaturity(ctx.fs, workspace, entry);
  const maturity = attainedMaturity(requestedMaturity(ctx), gate.attained, report);
  const fields: DesignReceiptFields = {
    package: entry.manifest.id,
    // Null, and SAID: `unsealed` is what turns "no hay línea base" from an
    // omission into a declaration.
    baseline: null,
    unsealed: target.unsealed,
    path: entry.path,
    root: route.root.kind,
    // Resolved FROM the index, so it is indexed whatever root the invocation
    // happened to name.
    indexable: true,
    maturity: { requested: requestedMaturity(ctx), attained: maturity.attained },
    sources: report.sources,
    renditions: [],
    route: routeOf(route.verdict),
  };

  return {
    kind: "durable",
    artifacts,
    output: {
      value: {
        design: fields,
        artifacts: artifacts.map((a) => a.path),
        gaps: [...gate.reasons, ...maturity.gaps],
      },
      reference: null,
      // Nothing is on disk until the approval lands, here as everywhere else.
      completeness: "partial",
    },
    // Nothing to compare and swap: this publication reads no manifest to derive
    // its output, so there is no state it could have been computed against.
    bases: [],
  };
}

/**
 * Package-relative paths the CLI SEALS. Authoring one is refused on every route:
 * a hand-written manifest or baseline is precisely the tree the listing rejects.
 */
const SEALED_PATHS: readonly string[] = [DESIGN_MANIFEST_FILE, "baselines"];

/** What a SEALING publication also derives for itself: the projections it renders. */
const DERIVED_PATHS: readonly string[] = [...SEALED_PATHS, ...PROJECTIONS];

/** Is this package-relative path one of `owned` — the entry itself, or under it? */
function owns(owned: readonly string[], relative: string): boolean {
  return owned.some((path) => relative === path || relative.startsWith(`${path}/`));
}

/** One artifact's vote on the maturity of the whole revision. */
interface MaturityClaim {
  /** How the artifact is named in a reason. */
  subject: string;
  maturity: DesignMaturity;
}

interface MaturityCeiling {
  attained: DesignMaturity;
  /** Empty exactly when `attained` is `handoff`. */
  reasons: string[];
}

/**
 * The maturity a catalog attains as a whole.
 *
 * `handoff` is a property of the WHOLE thing being published: a package is
 * consumed as one dossier, so the weakest CURRENT document is what an
 * implementer hits. The empty case is vacuously `handoff`, and that is only
 * sound because every caller derives its claims from {@link currentEntries},
 * which yields exactly one entry per catalogued id: no claims means the catalog
 * has no flow and no screen — no ladder to climb — rather than a filter having
 * eaten the ones it has.
 */
function ceilingOf(claims: readonly MaturityClaim[]): MaturityCeiling {
  const holding = claims.filter((c) => c.maturity !== "handoff");
  if (holding.length === 0) return { attained: "handoff", reasons: [] };
  return {
    attained: "outline",
    reasons: holding.map(
      (c) =>
        `${c.subject} alcanza '${c.maturity}': una publicación vale lo que vale su artefacto más flojo`,
    ),
  };
}

/**
 * The maturity a package attains — ONE function, over the manifest that IS its
 * catalog.
 *
 * The same question for the tree a publication will LEAVE (the candidate's
 * manifest) and for the one already published (the entry's), so the receipt and
 * the `validate` right after it cannot answer differently about the same tree.
 * Which revision of each artifact answers is the content gate's own
 * `currentEntries`, and reusing it is the point: reading `currentness` again
 * here dropped every artifact it did not enumerate, and a manifest is allowed
 * not to enumerate one.
 *
 * Reading the catalog rather than the files is not a shortcut: the manifest
 * records the maturity each revision was sealed with — the publication gate
 * refused it otherwise — and that IS the verdict in force.
 */
function catalogMaturity(manifest: DesignManifest): MaturityCeiling {
  const claims = [...currentEntries(manifest, "flows"), ...currentEntries(manifest, "screens")].map(
    (entry) => ({
      subject: `${entry.id}@r${entry.revision}`,
      maturity: entry.maturity ?? ("outline" as DesignMaturity),
    }),
  );
  return ceilingOf(claims);
}

/**
 * The gate's verdict over a design that is ALREADY published.
 *
 * Two shapes, one question: a simple design is judged by its own document, a
 * package by its catalog. This only runs once the content gate came back clean,
 * which is what makes the catalog's recorded maturities trustworthy here.
 */
async function publishedMaturity(
  fs: FileSystemPort,
  workspace: string,
  entry: DesignPackageEntry,
): Promise<MaturityCeiling> {
  const manifest = entry.manifest;
  if (manifest === null) {
    return {
      attained: "outline",
      reasons: [`'${entry.manifest_path}' no valida: sin manifest no hay catálogo que juzgar`],
    };
  }
  if (manifest.mode !== "simple") return catalogMaturity(manifest);

  const absolute = join(workspace, entry.path, SIMPLE_DESIGN_FILE);
  if (!(await fs.exists(absolute))) {
    return {
      attained: "outline",
      reasons: [`'${entry.path}/${SIMPLE_DESIGN_FILE}' no está: no hay documento que juzgar`],
    };
  }
  const parsed = validateSimpleDesign(await fs.readText(absolute), SIMPLE_DESIGN_FILE);
  if (!parsed.ok || parsed.value === null) {
    return { attained: "outline", reasons: parsed.failures.map((f) => f.message) };
  }
  const verdict = simpleMaturity(parsed.value);
  return { attained: verdict.attained, reasons: verdict.reasons };
}

/** The verdict as the receipt states it: mode, signals and the one-line cause. */
function routeOf(verdict: ExpansionVerdict): DesignReceiptFields["route"] {
  return { mode: verdict.mode, signals: verdict.fired, cause: verdict.cause };
}

/**
 * What each operation has to be true BEFORE it can even ask for content.
 *
 * Kept apart from the authoring path so the two read as what they are: this is
 * about the world (does the profile exist, is the evidence still current), the
 * other is about the answer.
 */
async function operationPrecondition(ctx: HandlerContext): Promise<CapabilityFailure | null> {
  // `record` seals a statement ABOUT a revision, so its evidence has to still
  // be the evidence. This is the check the end of B2 deferred in writing.
  if (ctx.operation.name === "record" && ctx.workspace !== null) {
    const id = inputValue(ctx, "package");
    if (typeof id === "string" && id.trim().length > 0) {
      const outcome = await checkRecordPrecondition(ctx.fs, ctx.workspace, id.trim());
      const first = outcome.failures[0];
      if (!outcome.ok && first !== undefined) {
        return { code: first.code, message: first.message, action: first.action };
      }
    }
  }

  // `render` resolves its profile BY ID, which is what the adapter registry is
  // for: asking for one that does not exist has to list the ones that do.
  if (ctx.operation.name === "render") {
    const profile = inputValue(ctx, "profile");
    const adapter = requireAdapter(String(profile ?? ""), DESIGN_ADAPTERS, ctx.operation.name);
    if (!adapter.ok) {
      const { code, message, action } = adapter.failure;
      return { code, message, action };
    }
  }
  return null;
}

/**
 * The sources the invocation declared, classified.
 *
 * A locator the catalog does not recognize becomes `unsupported` WITH its
 * reason rather than an error: one unreadable attachment must not sink an
 * operation that had four good sources — it has to show up in the receipt and
 * cost the run its `handoff`, which is a very different thing.
 */
function declaredSources(ctx: HandlerContext): DesignSource[] {
  const raw = ctx.request.inputs.find((i) => i.name === "sources")?.value;
  const locators = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  return locators.map((locator) => {
    const kind = classifySource(locator);
    if (kind === null) {
      return {
        name: "sources",
        kind: "host_context" as const,
        locator,
        disposition: "unsupported" as const,
        reason: `'${locator}' no corresponde a ningún tipo de fuente del catálogo v1`,
        derived: [],
        sensitivity: "public" as const,
        essential: true,
      };
    }
    return {
      name: "sources",
      kind,
      locator,
      disposition: "used" as const,
      reason: null,
      derived: [],
      sensitivity: "public" as const,
      essential: true,
    };
  });
}

function requestedMaturity(ctx: HandlerContext): "outline" | "handoff" | null {
  const value = inputValue(ctx, "maturity");
  return value === "handoff" || value === "outline" ? value : null;
}

/**
 * The expansion signals the caller put on the table.
 *
 * Accepted as a repeated input or as one comma-separated value, because a
 * command line and a composing flow hand lists over differently — and neither
 * spelling should be the one that silently drops a signal. Whether each id is
 * admissible is `judgeExpansion`'s call, not this reader's.
 */
function declaredExpansionSignals(ctx: HandlerContext): string[] {
  const raw = ctx.request.inputs.filter((i) => i.name === "expansion").map((i) => i.value);
  return raw
    .flatMap((value) => (Array.isArray(value) ? value.map(String) : String(value).split(",")))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function textInput(ctx: HandlerContext, name: string): string | null {
  const value = inputValue(ctx, name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function packageInput(ctx: HandlerContext): string | null {
  return textInput(ctx, "package");
}

/** What a valid answer is on the simple route: one document, three sections, no metadata. */
function simpleContract(target: SimpleTarget): string {
  return [
    `Escribí el diseño como UN solo documento Markdown en '${target.path}/${SIMPLE_DESIGN_FILE}'.`,
    `Abrilo con '# <título>' y usá solo estas secciones, en este orden: ${SIMPLE_SECTIONS.map((s) => `## ${s}`).join(", ")}.`,
    `Siempre van ${SIMPLE_CORE_SECTIONS.map((s) => `'## ${s}'`).join(", ")}; las demás solo si dicen algo, y nunca vacías.`,
    "No escribas manifest, id, revisión, digest, madurez ni referencias: todo eso lo deriva el CLI de este documento.",
    "Respondé un único objeto JSON con 'version', 'operation', 'input_digest', 'state': 'proposed' y 'artifacts': [{path, content}] con ese único archivo.",
  ].join(" ");
}

/**
 * What a valid answer is on the SEALED package route: the normative artifacts,
 * and nothing the CLI derives.
 *
 * The split is the same one the simple route states: the agent authors content,
 * the CLI owns identity, sealing and projections. Naming the derived files in
 * the contract is what keeps a hand-authored manifest or baseline from coming
 * back as an answer — those arrive as a rejection, not as a silent overwrite.
 */
function packageContract(operation: string, target: PackageTarget): string {
  const perOperation: Record<string, string> = {
    create: "Autorá la PRIMERA revisión del package a partir de las fuentes declaradas.",
    update:
      "Autorá la revisión SIGUIENTE sobre la base declarada. No reescribas revisiones ya selladas.",
  };
  return [
    perOperation[operation] ?? "",
    `El id asignado es '${target.packageId}' y la carpeta '${target.path}': ambos van en el 'inventory' del request.`,
    `El frontmatter de cada artefacto declara ese id de package (por ejemplo '${target.packageId}/FLW-001').`,
    "NO autores 'design-manifest.json', nada bajo 'baselines/' ni 'PACKAGE.md': el CLI los deriva y sella a partir de tus artefactos, y rechaza la respuesta si los incluye.",
    "Respondé un único objeto JSON con 'version', 'operation', 'input_digest', 'state': 'proposed' y 'artifacts': [{path, content}]. Cada 'path' es relativo al workspace y cae dentro de los destinos permitidos. Ningún artefacto inventa un formato: los del UI Design Package v1 son los únicos aceptados.",
  ]
    .join(" ")
    .trim();
}

/**
 * What a valid answer is on the route that mints NO revision.
 *
 * It states that first, and states it before anything else: an author who thinks
 * the answer will be sealed writes a revision, and a revision is exactly what
 * this route does not publish.
 */
function projectionContract(operation: string, target: ProjectionTarget): string {
  const perOperation: Record<string, string> = {
    render:
      "Regenerá las proyecciones de la revisión vigente. Una proyección no es normativa: sale del manifest y ningún baseline la sella.",
    record:
      "Escribí la decisión de gobierno sobre la revisión indicada, sin tocar el contenido normativo del package.",
  };
  return [
    perOperation[operation] ?? "",
    `Esta operación NO acuña una revisión: ${target.unsealed}.`,
    `Se escribe DENTRO de '${target.entry.path}', el package ${target.entry.manifest.id} que ya está indexado.`,
    `NO autores '${DESIGN_MANIFEST_FILE}' ni nada bajo 'baselines/': son lo que sella el package y solo los deriva una publicación de contenido normativo.`,
    "Respondé un único objeto JSON con 'version', 'operation', 'input_digest', 'state': 'proposed' y 'artifacts': [{path, content}]. Cada 'path' es relativo al workspace y cae dentro de ese package.",
  ]
    .join(" ")
    .trim();
}

function inputOf(ctx: HandlerContext, name: string): CapabilityInputValue | undefined {
  return ctx.request.inputs.find((i) => i.name === name);
}

function inputValue(ctx: HandlerContext, name: string): unknown {
  return inputOf(ctx, name)?.value;
}

/** A composed refine replaces its consumer in the same approved publication. */
function requiresConsumerDocument(ctx: HandlerContext): boolean {
  return (
    AUTHORING_OPERATIONS.includes(ctx.operation.name) &&
    ctx.request.caller.route === "compose" &&
    (ctx.request.caller.flow === "spec-refine" || ctx.request.caller.flow === "plan-refine")
  );
}

/** One proposal owns every non-null compare-and-swap base it depends on. */
function proposalBases(...candidates: Array<ProposalBase | null>): ProposalBase[] {
  return candidates.filter((candidate): candidate is ProposalBase => candidate !== null);
}

/** The five operations this floor answers — the descriptor's, not a second list. */
export const DESIGN_FLOOR_OPERATIONS = DESIGN_OPERATIONS;
