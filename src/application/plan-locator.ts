import { join } from "node:path";
import { normalizeCorrelativeInput } from "../domain/correlative.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type { FileSystemPort } from "../ports/file-system.js";

/**
 * WHICH PLAN A CROSS-CUTTING COMMAND WAS POINTED AT.
 *
 * Two spellings, because both are what somebody actually types: the path they
 * copied from `aw status`, or the correlative they remember. Resolving them is
 * the same three refusals every time — not a path of this workspace, no plan
 * with that number, a number that names more than one document — so it is ONE
 * implementation rather than one per command.
 *
 * What it deliberately does NOT do is name the codes. Each command owns its own
 * closed vocabulary, and a shared locator emitting `RESEAL_…` from inside a
 * settlement would make the refusal lie about who refused. It reports the SHAPE
 * of the problem and lets the caller spell it.
 */
export type PlanLocatorReason = "invalid" | "absent" | "ambiguous";

export type PlanLocation =
  | { ok: true; path: string }
  | { ok: false; reason: PlanLocatorReason; message: string; action: string };

/**
 * The two clauses that belong to the CALLER, not to the locator.
 *
 * Why a plan outside the canon is wrong, and what to pass instead of an
 * ambiguous correlative, both depend on what the command does with the plan.
 * They travel as parameters rather than being sniffed back out of a shared
 * message: a wording change made for one command would otherwise silently
 * delete the other's clause, which is exactly how this went wrong once.
 */
export interface PlanLocatorWording {
  /** Appended to the refusal for a path outside the plan directory. */
  outside: string;
  /** The action for a correlative that names more than one document. */
  ambiguous: string;
}

const DEFAULT_WORDING: PlanLocatorWording = {
  outside: "",
  ambiguous: "pasá la ruta exacta del plan",
};

export async function locatePlanDocument(
  fs: FileSystemPort,
  root: string,
  planDir: string,
  target: string,
  wording: PlanLocatorWording = DEFAULT_WORDING,
): Promise<PlanLocation> {
  const raw = target.trim();
  if (raw.includes("/") || raw.endsWith(".md")) {
    const safe = checkSafeRelativePath(raw);
    if (!safe.ok) {
      return {
        ok: false,
        reason: "invalid",
        message: `'${target}' no es una ruta del workspace: ${safe.why}`,
        action: `pasá la ruta del plan relativa al workspace ('${planDir}/NNN-plan-<slug>.md') o su correlativo`,
      };
    }
    const expected = planDir.split("/");
    const inside =
      safe.segments.length > expected.length &&
      expected.every((segment, index) => safe.segments[index] === segment);
    if (!inside) {
      return {
        ok: false,
        reason: "invalid",
        message: `'${safe.path}' no está bajo '${planDir}/'${wording.outside.length === 0 ? "" : `: ${wording.outside}`}`,
        action: `pasá la ruta de un plan bajo '${planDir}/' o su correlativo`,
      };
    }
    return { ok: true, path: safe.path };
  }

  const number = normalizeCorrelativeInput(raw);
  if (number === null) {
    return {
      ok: false,
      reason: "invalid",
      message: `'${target}' no es ni una ruta ni un correlativo`,
      action: `pasá la ruta del plan ('${planDir}/NNN-plan-<slug>.md') o su correlativo ('035')`,
    };
  }
  const matches = await plansNumbered(fs, join(root, planDir), number);
  const [first] = matches;
  if (first === undefined) {
    return {
      ok: false,
      reason: "absent",
      message: `no hay ningún plan '${number}' en '${planDir}/'`,
      action: "verificá el correlativo con 'aw status' o pasá la ruta exacta del plan",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `'${number}' nombra ${matches.length} documentos en '${planDir}/': ${matches.join(", ")}`,
      action: wording.ambiguous,
    };
  }
  return { ok: true, path: `${planDir}/${first}` };
}

/** File names of `planDir` that carry this correlative, in directory order. */
async function plansNumbered(
  fs: FileSystemPort,
  absoluteDir: string,
  number: string,
): Promise<string[]> {
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(absoluteDir);
  } catch {
    // A folder that is not there holds no plan: the caller reports the absence
    // of the document, which is what a person can act on.
    return [];
  }
  const named = new RegExp(`^${number}-.*\\.md$`);
  return entries
    .filter((entry) => entry.type === "file" && named.test(entry.name))
    .map((entry) => entry.name);
}
