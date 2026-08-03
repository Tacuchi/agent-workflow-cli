/**
 * The built-in floor of `design`.
 *
 * "Floor" is not a placeholder: it is the implementation a core gate can count
 * on when nothing extra is installed, and it is the same code an improvement
 * gets compared against. It is built entirely out of what already exists —
 * the package index, the published validators, the semantic handshake — because
 * a floor that reimplemented the design domain would be a second design domain.
 *
 * The split between the CLI and the agent is the repo's usual one, and it is why
 * the authoring operations answer `needs_input` first: the CLI owns identity,
 * destinations, limits, validation and writing; the AGENT authors the content.
 * `create` cannot invent a package body, so it says what a valid answer must
 * contain and waits for one — that is a question, not a failure.
 */

import type { ValidationOutcome } from "../../domain/capability/protocol.js";
import { DESIGN_DESCRIPTOR, DESIGN_OPERATIONS } from "../../domain/design/capability.js";
import { readDesignIndex, resolveDesignPackage } from "../design/design-index-service.js";
import { buildSemanticRequest, parseSemanticResponse } from "../semantic-operation/protocol.js";
import type { CapabilityHandler, HandlerContext, HandlerResult } from "./dispatcher.js";
import { registerCapability } from "./dispatcher.js";

const DESIGNS_ROOT = "docs/designs";

/** Artefact ceilings for one authored revision. Generous, and still a ceiling. */
const LIMITS = { max_artifacts: 60, max_artifact_bytes: 256_000 };

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
  return {
    kind: "completed",
    validations,
    output: {
      value: {
        id: found.id,
        path: found.path,
        current_baseline: found.current_baseline,
        ok: found.ok,
        failures: found.failures,
      },
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
  const target = ctx.request.context.target ?? DESIGNS_ROOT;
  const request = buildSemanticRequest({
    operation: `${ctx.request.capability}.${ctx.request.operation}`,
    inputs: ctx.request.inputs.map((i) => ({ name: i.name, value: i.value })),
    contract: contractFor(ctx.operation.name),
    inventory: { root: DESIGNS_ROOT },
    allowedDestinations: [target],
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
  const parsed = parseSemanticResponse(ctx.answer, {
    ...request,
    input_digest: request.input_digest,
  });
  if (!parsed.ok) return { kind: "blocked", failure: parsed.failure };

  const artifacts = (parsed.value.artifacts ?? []).map((a) => ({
    path: a.path,
    content: a.content,
  }));
  return {
    kind: "durable",
    artifacts,
    output: {
      value: { artifacts: artifacts.map((a) => a.path) },
      reference: null,
      // The durable step has not run yet, so nothing is published. Claiming
      // `complete` here would let a gate accept a proposal as a package.
      completeness: "partial",
    },
    base: null,
  };
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
