import { checkSafeRelativePath } from "../safe-path.js";
import {
  type ArtifactRef,
  type BaselineRef,
  isDigest,
  parseArtifactRef,
  parseBaselineRef,
} from "./identity.js";
import type { DesignFailure } from "./validation.js";

/**
 * How a SPEC and a PLAN cite a design, and why only the exact form counts.
 *
 * A published reference names an identity, a revision and a digest. It never
 * names `latest`, a slug, a folder or a title — because every one of those
 * answers a different question next year than it does today, and the whole
 * point of the package is that a task can be re-read a year later and still be
 * about the same design.
 *
 * The path travels along as a HINT. It helps a human open the file and it lets
 * the resolver skip a search; it is never the identity, and losing it never
 * loses the reference.
 */

/** The block a SPEC keeps under `## Design references`. */
export interface SpecDesignReference {
  /** `DES-001@r4` — the exact baseline the spec closed on. */
  baseline: BaselineRef;
  /** Workspace-relative path where that baseline lived when it was written. */
  baseline_hint: string;
  digest: string;
}

/** What a PLAN phase or task adds: the exact artifacts it will implement. */
export interface TaskDesignReference {
  baseline: BaselineRef;
  artifact: ArtifactRef;
  /** The literal text, so a diagnostic can quote what the author wrote. */
  raw: string;
}

const SPEC_SECTION = "## Design references";

/**
 * Forms that look like a reference and are not. Each one is recognized on
 * purpose: telling an author "'latest' no fija una revisión" is worth far more
 * than telling them the value did not match a pattern.
 */
const APPROXIMATE: Array<{ test: RegExp; why: string; action: string }> = [
  {
    test: /@latest\b/i,
    why: "'latest' no fija ninguna revisión: mañana señala otra cosa",
    action: "escribí la revisión exacta, por ejemplo DES-001@r4",
  },
  {
    test: /@(head|current|latest|último|ultimo)\b/i,
    why: "es un alias móvil, no una revisión",
    action: "escribí la revisión exacta, por ejemplo DES-001@r4",
  },
  {
    test: /^docs\/designs\//,
    why: "es un path, y el path es un hint de ubicación, nunca la identidad",
    action: "referenciá el package por su id y revisión, por ejemplo DES-001@r4",
  },
  {
    test: /^\d{3}-design-/,
    why: "es el slug de una carpeta, y la identidad no deriva del slug",
    action: "referenciá el package por su id y revisión, por ejemplo DES-001@r4",
  },
  {
    test: /^DES-\d{3,}$/,
    why: "nombra el package pero no fija la revisión",
    action: "agregá la revisión, por ejemplo DES-001@r4",
  },
];

function approximate(value: string, artifact: string, field: string): DesignFailure | null {
  for (const form of APPROXIMATE) {
    if (!form.test.test(value)) continue;
    return {
      code: "DESIGN_REFERENCE_APPROXIMATE",
      artifact,
      message: `${field}: '${value}' ${form.why}`,
      action: form.action,
    };
  }
  return null;
}

export interface SpecReferenceParse {
  references: SpecDesignReference[];
  failures: DesignFailure[];
}

/**
 * Read the `## Design references` section of a spec. Absent section = no
 * references, which is the normal state of a spec without UI — not an error.
 */
export function parseSpecDesignReferences(markdown: string, artifact: string): SpecReferenceParse {
  const references: SpecDesignReference[] = [];
  const failures: DesignFailure[] = [];
  const section = sectionBody(markdown, SPEC_SECTION);
  if (section === null) return { references, failures };

  const blocks = splitBlocks(section);
  // The section exists and says nothing parseable. Returning silently would let
  // a spec claim it references a design while referencing none — the failure
  // mode this whole contract removes.
  if (blocks.length === 0) {
    if (section.trim().length > 0) {
      failures.push({
        code: "DESIGN_REFERENCE_INCOMPLETE",
        artifact,
        message: `'${SPEC_SECTION}' tiene contenido y ninguna referencia legible`,
        action:
          "escribí un bloque con 'package:', 'baseline_hint:' y 'digest:', o quitá la sección",
      });
    }
    return { references, failures };
  }

  for (const block of blocks) {
    const parsed = readSpecReference(block, artifact);
    if ("code" in parsed) failures.push(parsed);
    else references.push(parsed);
  }
  return { references, failures };
}

function readSpecReference(
  fields: Map<string, string>,
  artifact: string,
): SpecDesignReference | DesignFailure {
  const raw = fields.get("package") ?? "";
  const missing = (field: string): DesignFailure => ({
    code: "DESIGN_REFERENCE_INCOMPLETE",
    artifact,
    message: `la referencia de diseño no declara '${field}'`,
    action: "una referencia publicada lleva package, baseline_hint y digest",
  });
  if (raw.length === 0) return missing("package");

  const near = approximate(raw, artifact, "package");
  if (near !== null) return near;

  const baseline = parseBaselineRef(raw);
  if (baseline === null) {
    return {
      code: "DESIGN_REFERENCE_APPROXIMATE",
      artifact,
      message: `package: '${raw}' no es una referencia exacta`,
      action: "usá la forma DES-NNN@rN",
    };
  }

  const hint = fields.get("baseline_hint") ?? "";
  if (hint.length === 0) return missing("baseline_hint");
  const safe = checkSafeRelativePath(hint);
  if (!safe.ok) {
    return {
      code: "DESIGN_PATH_UNSAFE",
      artifact,
      message: `baseline_hint: '${hint}' ${safe.why}`,
      action: "el hint es un path relativo al workspace, bajo docs/designs/",
    };
  }

  const digest = fields.get("digest") ?? "";
  if (digest.length === 0) return missing("digest");
  if (!isDigest(digest)) {
    return {
      code: "DESIGN_REFERENCE_INCOMPLETE",
      artifact,
      message: `digest: '${digest}' no es 'sha256:' + 64 hex`,
      action: "copiá el digest del baseline que estás fijando",
    };
  }

  return { baseline, baseline_hint: safe.path, digest };
}

/**
 * The shape of a task reference, matched LOOSELY on purpose: anything that
 * looks like the two-part form is captured here and then judged. Matching only
 * the canonical form would make `DES-001@latest / SCR-002@r2` invisible — and a
 * reference that is silently ignored is worse than one that is rejected.
 */
const TASK_REFERENCE_SHAPE =
  /(DES-[0-9]+(?:@[A-Za-z0-9]+)?)\s*\/\s*((?:FLW|SCR|RUL|TOK|VIS)-[0-9]+(?:@[A-Za-z0-9]+)?(?:#[A-Za-z0-9][A-Za-z0-9_-]*)?)/g;

export interface TaskReferenceParse {
  references: TaskDesignReference[];
  failures: DesignFailure[];
}

/**
 * Read the design references a plan phase or task declares. Only the exact
 * two-part form resolves; anything shaped like one but written approximately is
 * REPORTED, never skipped.
 */
export function parseTaskDesignReferences(text: string, artifact: string): TaskReferenceParse {
  const references: TaskDesignReference[] = [];
  const failures: DesignFailure[] = [];
  const seen = new Set<string>();
  const pinned = new Set<string>();

  for (const match of text.matchAll(TASK_REFERENCE_SHAPE)) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);

    const left = match[1] as string;
    const right = match[2] as string;
    const baseline = parseBaselineRef(left);
    if (baseline === null) {
      const near = approximate(left, artifact, `referencia de tarea '${raw}'`);
      failures.push(near ?? malformed(raw, left, artifact));
      continue;
    }
    const artifactRef = parseArtifactRef(`${baseline.package}/${right}`);
    if (artifactRef === null) {
      failures.push(malformed(raw, right, artifact));
      continue;
    }
    pinned.add(baseline.package);
    references.push({ baseline, artifact: artifactRef, raw });
  }

  // A package named without being pinned is the exact failure this contract
  // removes — unless the same text pins it, where the bare mention is just prose.
  for (const match of text.matchAll(/DES-[0-9]+(?:@[A-Za-z]+)?(?![@/\w-])/g)) {
    const value = match[0];
    const id = value.split("@")[0] as string;
    if (pinned.has(id)) continue;
    const near = approximate(value, artifact, "referencia de tarea");
    failures.push(near ?? malformed(value, value, artifact));
  }
  return { references, failures };
}

function malformed(raw: string, part: string, artifact: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_APPROXIMATE",
    artifact,
    message: `referencia de tarea '${raw}': '${part}' no es una referencia exacta`,
    action: "usá la forma DES-NNN@rN / XXX-NNN@rN[#estado], con la revisión sin ceros de más",
  };
}

/** Body of a `## Heading` section, or null when the section is absent. */
function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * One block per reference, and a block STARTS at `package:`.
 *
 * Two reasons. A contiguous list of three-line references is the natural way to
 * write several, and splitting only on blank lines silently kept the last. And
 * prose in the section — "nota: ver el paquete de abajo" — parses as a
 * `key: value` line, so anything before the first `package:` is commentary and
 * must not become a half-built reference nobody wrote.
 */
function splitBlocks(section: string): Array<Map<string, string>> {
  const blocks: Array<Map<string, string>> = [];
  let current: Map<string, string> | null = null;

  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*([a-z_]+):\s*(.+?)\s*$/.exec(line);
    if (match === null) {
      if (line.trim().length === 0) current = null;
      continue;
    }
    const key = match[1] as string;
    const value = (match[2] as string).replace(/^`|`$/g, "");
    if (key === "package") {
      current = new Map();
      blocks.push(current);
    }
    if (current === null) continue; // prosa antes de la primera referencia
    if (current.has(key)) {
      current = new Map([[key, value]]);
      blocks.push(current);
      continue;
    }
    current.set(key, value);
  }
  return blocks;
}
