import { basename } from "node:path";
import { DEFAULT_DOCS_CANON } from "../../src/application/docs-canon-service.js";
import { EXPORT_CATEGORIES } from "../../src/application/export-service.js";
import { DEFAULT_CORE_DOCS_CANON } from "../../src/domain/docs-canon.js";

/**
 * The docs/ folders the CLI writes by default: the core document graph and one
 * per export category, read from the live canon rather than restated here.
 */
export function cliDocsFolders(): string[] {
  return [
    ...Object.values(DEFAULT_CORE_DOCS_CANON),
    ...EXPORT_CATEGORIES.map((category) => DEFAULT_DOCS_CANON[category]),
  ].map((dir) => basename(dir));
}
