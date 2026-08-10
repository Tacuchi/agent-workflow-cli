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

import type { CapabilityFailure, ValidationOutcome } from "../../domain/capability/protocol.js";
import { requireAdapter } from "../../domain/design/adapter.js";
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
import { DESIGN_ADAPTERS } from "../../domain/design/profiles.js";
import {
  SIMPLE_CORE_SECTIONS,
  SIMPLE_DESIGN_FILE,
  SIMPLE_SECTIONS,
} from "../../domain/design/simple.js";
import {
  type DesignSource,
  type SourceReport,
  classifySource,
  reportSources,
} from "../../domain/design/sources.js";
import { localDateIso } from "../dates.js";
import { readDesignIndex, resolveDesignPackage } from "../design/design-index-service.js";
import { checkRecordPrecondition } from "../design/design-record-service.js";
import {
  type SimpleTarget,
  buildSimpleProposal,
  resolveSimpleTarget,
} from "../design/design-simple-service.js";
import { buildSemanticRequest, parseSemanticResponse } from "../semantic-operation/protocol.js";
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

  const validations: ValidationOutcome[] = [
    {
      id: "design-manifest",
      passed: found.ok,
      detail: found.ok ? null : found.failures.map((f) => `${f.code}: ${f.message}`).join("; "),
    },
  ];
  const report = reportSources([], `${id}`);
  const simple = found.mode === "simple";
  const maturity = attainedMaturity(
    requestedMaturity(ctx),
    found.ok ? "handoff" : "outline",
    report,
  );
  const fields: DesignReceiptFields = {
    package: found.id,
    baseline:
      found.current_baseline === null
        ? null
        : { revision: found.current_baseline.revision, digest: found.current_baseline.digest },
    path: found.path,
    root: "workspace",
    indexable: true,
    maturity: { requested: requestedMaturity(ctx), attained: simple ? null : maturity.attained },
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
      value: { design: fields, ok: found.ok, failures: found.failures },
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
  const route = await decideRoute(ctx, sources, root.value);
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
      gaps: [request.contract, `destinos permitidos: ${request.allowed_destinations.join(", ")}`],
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

  return route.value.target === null
    ? packageProposal(ctx, report, route.value, answered)
    : simpleProposal(ctx, report, route.value, answered);
}

/** The two routes' shared answer: where to write, what to write, and why. */
interface RouteDecision {
  verdict: ExpansionVerdict;
  contract: string;
  inventory: unknown;
  destinations: string[];
  /** Present exactly on the simple route: the identity and folder already fixed. */
  target: SimpleTarget | null;
  root: OutputRoot;
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
  sources: DesignSource[],
  root: OutputRoot,
): Promise<RouteResolution> {
  const index = ctx.workspace === null ? null : await readDesignIndex(ctx.fs, ctx.workspace);
  // By IDENTITY and only when one was named. `find(p => p.id === null)` would
  // match the first package whose manifest does not validate — an entry that has
  // no identity is not the one this invocation continues.
  const named = packageInput(ctx);
  const targeted =
    index === null || named === null ? null : (index.packages.find((p) => p.id === named) ?? null);

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

  // The package route is also the only one available outside a workspace or
  // outside `docs/designs/`: a simple design derives its identity from the index,
  // and there is no index to derive it from.
  //
  // `render` and `record` are package operations whatever the signals say —
  // projecting revisions and sealing governance decisions are things a catalog
  // has and one document does not. Routing them by the vocabulary would ask a
  // simple design for a maturity and a rendition it never had.
  if (
    verdict.mode === "package" ||
    !AUTHORING_OPERATIONS.includes(ctx.operation.name) ||
    index === null ||
    !isIndexable(root)
  ) {
    // The compare-and-swap base is the caller's claim on this route, and a safety
    // check that can be omitted is one nobody performs. It is demanded HERE
    // rather than in the descriptor because the simple route derives it instead.
    if (ctx.operation.name === "update" && textInput(ctx, "base") === null) {
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
    return {
      ok: true,
      value: {
        verdict,
        contract: contractFor(ctx.operation.name),
        inventory: { root: root.root, mode: root.kind },
        destinations: [root.root],
        target: null,
        root,
      },
    };
  }

  const resolved = resolveSimpleTarget(index, ctx.operation.name, {
    title: textInput(ctx, "title"),
    packageId: packageInput(ctx),
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
      target: resolved.value,
      root,
    },
  };
}

/** The simple route's durable step: one authored document, everything else derived. */
async function simpleProposal(
  ctx: HandlerContext,
  report: SourceReport,
  route: RouteDecision,
  answered: readonly { path: string; content: string }[],
): Promise<HandlerResult> {
  const target = route.target as SimpleTarget;
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

  // A target only exists when `decideRoute` read the index, which it only does
  // inside a workspace: the simple route and a null workspace cannot coexist.
  const built = await buildSimpleProposal(ctx.fs, ctx.workspace as string, {
    target,
    document: document.content,
    published: localDateIso(new Date()),
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

  const fields: DesignReceiptFields = {
    package: built.value.packageId,
    baseline: { revision: built.value.revision, digest: built.value.digest },
    path: target.path,
    root: route.root.kind,
    indexable: true,
    // No ladder to climb: see `DesignReceiptFields.maturity`.
    maturity: { requested: requestedMaturity(ctx), attained: null },
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
        gaps: [],
      },
      reference: null,
      completeness: "partial",
    },
    base: built.value.base,
  };
}

/** The expanded route's durable step — the package the agent authored, unchanged. */
function packageProposal(
  ctx: HandlerContext,
  report: SourceReport,
  route: RouteDecision,
  answered: readonly { path: string; content: string }[],
): HandlerResult {
  const artifacts = answered.map((a) => ({ path: a.path, content: a.content }));
  // The gate verdict the `012` computes is not available until the package is
  // on disk, so a proposal can never claim more than `outline` here — which is
  // exactly the rule that stops a partial from being promoted.
  const maturity = attainedMaturity(requestedMaturity(ctx), "outline", report);
  const fields: DesignReceiptFields = {
    package: packageInput(ctx),
    baseline: null,
    path: route.root.root,
    root: route.root.kind,
    indexable: isIndexable(route.root),
    maturity: { requested: requestedMaturity(ctx), attained: maturity.attained },
    sources: report.sources,
    renditions: [],
    route: routeOf(route.verdict),
  };

  return {
    kind: "durable",
    artifacts,
    output: {
      value: { design: fields, artifacts: artifacts.map((a) => a.path), gaps: maturity.gaps },
      reference: null,
      // The durable step has not run yet, so nothing is published. Claiming
      // `complete` here would let a gate accept a proposal as a package.
      completeness: "partial",
    },
    base: null,
  };
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

function contractFor(operation: string): string {
  const shared =
    "Respondé un único objeto JSON con 'version', 'operation', 'input_digest', 'state': 'proposed' " +
    "y 'artifacts': [{path, content}]. Cada 'path' es relativo al workspace y cae dentro de los " +
    "destinos permitidos. Ningún artefacto inventa un formato: los del UI Design Package v1 son los únicos aceptados.";
  const perOperation: Record<string, string> = {
    create: "Autorá la PRIMERA revisión del package a partir de las fuentes declaradas.",
    update:
      "Autorá la revisión SIGUIENTE sobre la base declarada. No reescribas revisiones ya selladas.",
    render:
      "Regenerá las proyecciones de la revisión indicada. Una proyección no es normativa y nunca se sella.",
    record:
      "Sellá la decisión de gobierno sobre la revisión indicada, sin tocar el contenido del package.",
  };
  return `${perOperation[operation] ?? ""} ${shared}`.trim();
}

function inputValue(ctx: HandlerContext, name: string): unknown {
  return ctx.request.inputs.find((i) => i.name === name)?.value;
}

/** The five operations this floor answers — the descriptor's, not a second list. */
export const DESIGN_FLOOR_OPERATIONS = DESIGN_OPERATIONS;
