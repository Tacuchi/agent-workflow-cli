/**
 * Naming what to retire, unambiguously or not at all.
 *
 * A destructive command cannot take "024" and decide what the person meant. The
 * board holds a spec 024, a plan 024 and a session 024 at the same time, and each
 * one is a different amount of work to delete. So the selector is EXPLICIT by
 * default (`plan:024`), a bare number is accepted only while exactly one node
 * answers to it, and a path is accepted because a path is already unambiguous.
 *
 * Parsing here is pure: it says what SHAPE was asked for. Whether that shape
 * resolves to one node, several, or none is the resolver's job — the two are kept
 * apart so a parse error and an ambiguous target never come back as the same
 * failure.
 */

import { type WorklineKind, isWorklineKind, nodeFromDocPath } from "../workline-node.js";

export type TargetSelector =
  /** `plan:024` — kind and key both stated. */
  | { form: "qualified"; kind: WorklineKind; key: string }
  /** `024` — resolves only while a single node of any kind answers to it. */
  | { form: "bare"; key: string }
  /** `docs/plans/024-plan-x.md` — a document, identified by where it lives. */
  | { form: "path"; path: string; kind: WorklineKind; key: string }
  /** `119-comandos-plan-exec` — a session folder, spelled out. */
  | { form: "folder"; folder: string };

export interface SelectorProblem {
  code: "TARGET_EMPTY" | "TARGET_UNKNOWN_KIND" | "TARGET_MALFORMED";
  message: string;
  action: string;
}

export type SelectorParse =
  | { ok: true; selector: TargetSelector }
  | { ok: false; problem: SelectorProblem };

const BARE_NUMBER = /^\d{1,4}$/;
const SESSION_FOLDER = /^(?:session)?\d{3,}-[A-Za-z0-9._-]+$/;

export function parseTargetSelector(raw: string): SelectorParse {
  const text = raw.trim();
  if (text.length === 0) {
    return {
      ok: false,
      problem: {
        code: "TARGET_EMPTY",
        message: "no se indicó ningún objetivo",
        action:
          "pasá el objetivo: spec:<NNN> | plan:<PPP> | quick:<NNN> | session:<NNN|carpeta> | una ruta exacta",
      },
    };
  }

  // A path is checked first: `docs/plans/024-plan-x.md` contains no `:` on any
  // platform we support, but a Windows spelling could, and the path reading is
  // the more specific of the two.
  const fromPath = nodeFromDocPath(text);
  if (fromPath !== null) {
    return {
      ok: true,
      selector: {
        form: "path",
        path: normalizeSlashes(text),
        kind: fromPath.kind,
        key: fromPath.key,
      },
    };
  }

  const colon = text.indexOf(":");
  if (colon > 0) return parseQualified(text, colon);
  if (BARE_NUMBER.test(text)) return { ok: true, selector: { form: "bare", key: pad(text) } };
  if (SESSION_FOLDER.test(text)) return { ok: true, selector: { form: "folder", folder: text } };

  return {
    ok: false,
    problem: {
      code: "TARGET_MALFORMED",
      message: `'${raw}' no es un objetivo reconocible`,
      action:
        "usá spec:<NNN>, plan:<PPP>, quick:<NNN>, session:<NNN|carpeta> o la ruta exacta del documento",
    },
  };
}

function parseQualified(text: string, colon: number): SelectorParse {
  const kind = text.slice(0, colon).trim().toLowerCase();
  const key = text.slice(colon + 1).trim();
  if (!isWorklineKind(kind)) {
    return {
      ok: false,
      problem: {
        code: "TARGET_UNKNOWN_KIND",
        message: `'${kind}' no es una clase de nodo de Workline`,
        action: "las clases son spec, plan, quick y session",
      },
    };
  }
  if (key.length === 0) {
    return {
      ok: false,
      problem: {
        code: "TARGET_MALFORMED",
        message: `'${kind}:' no nombra nada`,
        action: `pasá ${kind}:<identidad>`,
      },
    };
  }
  // A session or a quick is addressed by number OR by folder; a spec and a plan
  // only ever by number, and padding it is what makes `plan:24` and `plan:024`
  // the same request instead of one that silently finds nothing.
  const normalized = BARE_NUMBER.test(key) ? pad(key) : key;
  return { ok: true, selector: { form: "qualified", kind, key: normalized } };
}

function pad(key: string): string {
  return key.padStart(3, "0");
}

function normalizeSlashes(path: string): string {
  return path.split("\\").join("/");
}

/** How the selector reads back to a person, verbatim in a rejection. */
export function selectorText(selector: TargetSelector): string {
  switch (selector.form) {
    case "qualified":
      return `${selector.kind}:${selector.key}`;
    case "bare":
      return selector.key;
    case "path":
      return selector.path;
    case "folder":
      return selector.folder;
  }
}
