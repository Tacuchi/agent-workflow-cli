import { join } from "node:path";
import { type SpecBaseline, correlativeOfSpecPath, withSpecBaseline } from "../domain/lineage.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { functionalSpecDigest } from "./parsers/spec-functional.js";
import {
  declaresStandalone,
  parseLineageDeclaration,
  parsePlanBaselineSeal,
} from "./parsers/spec-relation.js";

export type PlanLineageCode = "PLAN_LINEAGE_UNSEALED";

export interface PlanLineageFailure {
  code: PlanLineageCode;
  message: string;
  /** One-based line of the lineage label, when there is one. */
  line?: number;
}

/** What the header declares about provenance, before any spec is read. */
export type PlanLineageReading =
  | { kind: "derived"; path: string; number: string; line: number }
  | { kind: "standalone" }
  | { kind: "refused"; failure: PlanLineageFailure };

/** What publishing the plan does about its seal. */
export type PlanLineageSeal =
  | { status: "sealed"; baseline: SpecBaseline }
  | { status: "standalone" }
  | { status: "refused"; failure: PlanLineageFailure };

/**
 * The lineage a plan's HEADER declares, read header first.
 *
 * The board reads `## Origin` before the standalone marker on purpose, to
 * associate legacy plans. Publication needs a different answer — whether the
 * plan carries a label a seal can be computed from — so a standalone plan whose
 * Origin mentions a spec is standalone here, and a plan with neither is refused
 * instead of published without a seal.
 */
export function readPlanLineage(text: string, specDir: string): PlanLineageReading {
  const declared = parseLineageDeclaration(text, specDir);
  if (declared === null) {
    if (declaresStandalone(text)) return { kind: "standalone" };
    return refused(
      `el plan no declara su linaje: falta \`> Derived from\` con la ruta de su spec (${specDir}/NNN-spec-<slug>.md) en la cabecera, o \`> Standalone: <de dónde salió>\` si nació de la conversación`,
    );
  }
  const [path, ...others] = declared.paths;
  if (path === undefined) {
    return refused(
      `la etiqueta de linaje de la línea ${declared.line} no nombra la ruta de su spec (${specDir}/NNN-spec-<slug>.md)`,
      declared.line,
    );
  }
  if (others.length > 0) {
    return refused(
      `la etiqueta de linaje de la línea ${declared.line} nombra más de una spec (${declared.paths.join(", ")}): un sello fija una sola versión`,
      declared.line,
    );
  }
  const safe = checkSafeRelativePath(path);
  if (!safe.ok) {
    return refused(
      `la etiqueta de linaje de la línea ${declared.line} apunta a '${path}', que sale del hub: ${safe.why}`,
      declared.line,
    );
  }
  const number = correlativeOfSpecPath(path, specDir);
  if (number === null) {
    return refused(
      `la etiqueta de linaje de la línea ${declared.line} no nombra una spec bajo '${specDir}/'`,
      declared.line,
    );
  }
  return { kind: "derived", path, number, line: declared.line };
}

/**
 * The seal publication stamps, computed from the spec file the header names.
 *
 * The digest is the spec's FUNCTIONAL digest, so a later comma in the spec does
 * not turn the plan divergent. A spec that cannot be read is a refusal: a plan
 * that declares a lineage and leaves unsealed would be the silent case this
 * exists to end.
 */
export async function observePlanLineageSeal(
  fs: FileSystemPort,
  root: string,
  text: string,
  specDir: string,
): Promise<PlanLineageSeal> {
  const reading = readPlanLineage(text, specDir);
  if (reading.kind === "standalone") return { status: "standalone" };
  if (reading.kind === "refused") return { status: "refused", failure: reading.failure };
  let specText: string;
  try {
    specText = await fs.readText(join(root, reading.path));
  } catch {
    return {
      status: "refused",
      failure: {
        code: "PLAN_LINEAGE_UNSEALED",
        line: reading.line,
        message: `la spec '${reading.path}' que nombra la etiqueta de linaje de la línea ${reading.line} no se puede leer`,
      },
    };
  }
  const baseline = {
    path: reading.path,
    number: reading.number,
    digest: functionalSpecDigest(specText),
  };
  // The seal lives in the header blockquote. A label written as plain prose has
  // none to land in, and publishing it would be the silent unsealed plan again.
  const stamped = parsePlanBaselineSeal(withSpecBaseline(text, baseline), specDir);
  if (stamped.status !== "sealed" || stamped.baseline.digest !== baseline.digest) {
    return {
      status: "refused",
      failure: {
        code: "PLAN_LINEAGE_UNSEALED",
        line: reading.line,
        message: `la cabecera no tiene un blockquote donde viva el sello: escribí la etiqueta de la línea ${reading.line} como '> Derived from ${reading.path}'`,
      },
    };
  }
  return { status: "sealed", baseline };
}

function refused(message: string, line?: number): PlanLineageReading {
  return {
    kind: "refused",
    failure: { code: "PLAN_LINEAGE_UNSEALED", message, ...(line !== undefined ? { line } : {}) },
  };
}
