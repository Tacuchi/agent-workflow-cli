/**
 * `DESIGN.md` — the whole of a simple design's human authorship.
 *
 * One document, three sections that always earn their place, three more that
 * appear only when they say something. That is the entire contract, and its
 * shortness is the point: everything else a package carries — identity, revision,
 * digest, manifest, index entry, references — is DERIVED by the CLI from these
 * bytes, so nobody authoring a design has to administer any of it.
 *
 * The optional sections are optional in the strong sense: a heading with nothing
 * under it is refused rather than tolerated. A template filled with "N/A" is how a
 * document stops being read, and the fastest way to get there is to reward
 * printing every heading whether or not it has content.
 *
 * Heading vocabulary is CLOSED for the same reason the reference grammar is: a
 * seventh section invented per document is a format, and a format nobody declared
 * is one no consumer can project.
 */

import type { DesignFailure } from "./validation.js";

/** The one authored file of a simple design, at the package root. */
export const SIMPLE_DESIGN_FILE = "DESIGN.md";

/** Where a superseded revision's exact bytes are kept once a newer one lands. */
export const SIMPLE_REVISIONS_DIR = "revisions";

/** Package-relative path of the archived copy of revision `n`. */
export function archivedDesignPath(revision: number): string {
  return `${SIMPLE_REVISIONS_DIR}/DESIGN-r${String(revision).padStart(3, "0")}.md`;
}

/** Always present, always with content: without these there is no design. */
export const SIMPLE_CORE_SECTIONS = ["Objetivo", "Diseño propuesto", "Validación"] as const;

/** Present only when they add information — and then with real content. */
export const SIMPLE_OPTIONAL_SECTIONS = ["Recorrido", "Decisiones", "Abiertos"] as const;

/** The closed heading vocabulary, in the order a reader walks them. */
export const SIMPLE_SECTIONS: readonly string[] = [
  SIMPLE_CORE_SECTIONS[0],
  SIMPLE_CORE_SECTIONS[1],
  SIMPLE_OPTIONAL_SECTIONS[0],
  SIMPLE_OPTIONAL_SECTIONS[1],
  SIMPLE_CORE_SECTIONS[2],
  SIMPLE_OPTIONAL_SECTIONS[2],
];

export interface SimpleDesignSection {
  heading: string;
  body: string;
}

export interface SimpleDesign {
  /** The `# ` title line, which is what the manifest publishes as the title. */
  title: string;
  sections: SimpleDesignSection[];
}

export interface SimpleDesignValidation {
  ok: boolean;
  value: SimpleDesign | null;
  failures: DesignFailure[];
}

function fail(artifact: string, message: string, action: string): DesignFailure {
  return { code: "DESIGN_FIELD_INVALID", artifact, message, action };
}

/**
 * Read `DESIGN.md` and say whether it is one.
 *
 * Order is checked but only among the sections the document actually carries: a
 * design with no `Recorrido` must not be told its `Validación` is misplaced.
 */
export function validateSimpleDesign(markdown: string, artifact: string): SimpleDesignValidation {
  const lines = markdown.split(/\r?\n/);
  const titleLine = lines.find((l) => /^#\s+\S/.test(l));
  const sections = splitSections(lines);

  const failures: DesignFailure[] = [
    ...(titleLine === undefined
      ? [
          fail(
            artifact,
            "el documento no abre con un título '# '",
            "poné en la primera línea '# <nombre del diseño>': ese título es el que publica el manifest",
          ),
        ]
      : []),
    ...checkSections(sections, artifact),
    ...checkOrder(sections, artifact),
  ];

  if (failures.length > 0 || titleLine === undefined) {
    return { ok: false, value: null, failures };
  }
  return {
    ok: true,
    value: { title: titleLine.replace(/^#\s+/, "").trim(), sections },
    failures: [],
  };
}

/** `## Heading` lines and everything under each, in the order they were written. */
function splitSections(lines: readonly string[]): SimpleDesignSection[] {
  const sections: SimpleDesignSection[] = [];
  let current: SimpleDesignSection | null = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading === null) {
      if (current !== null) current.body += `${line}\n`;
      continue;
    }
    current = { heading: heading[1] as string, body: "" };
    sections.push(current);
  }
  return sections;
}

/** Each written section against the vocabulary, plus the core ones that are missing. */
function checkSections(sections: SimpleDesignSection[], artifact: string): DesignFailure[] {
  const failures: DesignFailure[] = [];
  const seen = new Set<string>();

  for (const { heading, body } of sections) {
    if (!SIMPLE_SECTIONS.includes(heading)) {
      failures.push(
        fail(
          artifact,
          `'## ${heading}' no es una sección de un diseño simple`,
          `las secciones son: ${SIMPLE_SECTIONS.join(", ")} — si el material no entra en ellas, el diseño ya no es simple`,
        ),
      );
      continue;
    }
    if (seen.has(heading)) {
      failures.push(
        fail(
          artifact,
          `'## ${heading}' aparece dos veces`,
          "una sección se escribe una sola vez: unificá su contenido",
        ),
      );
      continue;
    }
    seen.add(heading);
    if (body.trim().length === 0) failures.push(emptySection(heading, artifact));
  }

  for (const required of SIMPLE_CORE_SECTIONS) {
    if (seen.has(required)) continue;
    failures.push(
      fail(
        artifact,
        `falta '## ${required}'`,
        `un diseño simple lleva siempre ${SIMPLE_CORE_SECTIONS.join(", ")}`,
      ),
    );
  }
  return failures;
}

function isCore(heading: string): boolean {
  return SIMPLE_CORE_SECTIONS.includes(heading as (typeof SIMPLE_CORE_SECTIONS)[number]);
}

function emptySection(heading: string, artifact: string): DesignFailure {
  return fail(
    artifact,
    `'## ${heading}' está vacía`,
    isCore(heading)
      ? "escribí su contenido: es una de las tres secciones que un diseño simple siempre tiene"
      : "una sección opcional se escribe solo si dice algo: quitala o llenala",
  );
}

/** Order, judged only among the sections the document actually carries. */
function checkOrder(sections: SimpleDesignSection[], artifact: string): DesignFailure[] {
  const written = sections.map((s) => s.heading).filter((h) => SIMPLE_SECTIONS.includes(h));
  const expected = SIMPLE_SECTIONS.filter((h) => written.includes(h));
  if (written.join("|") === expected.join("|")) return [];
  return [
    fail(
      artifact,
      `las secciones están fuera de orden: ${written.join(", ")}`,
      `ordenalas como ${expected.join(", ")}`,
    ),
  ];
}

/**
 * `Alta de miembros y su ficha` → `alta-de-miembros-y-su-ficha`.
 *
 * Accent folding rather than dropping: `validación` has to become `validacion`
 * and not `validacin`, and the folder slug is the one thing about a package a
 * human reads before opening it.
 */
export function designSlug(title: string): string {
  const folded = title
    .normalize("NFD")
    // The Unicode property, not a code-point range: a range that starts at a
    // combining mark reads as "a base character OR a mark" and stops meaning
    // what it says. `\p{M}` is exactly "the marks NFD just separated out".
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "design";
}

/** `DES-007` — the next free identity, three digits until the line outgrows them. */
export function nextPackageId(existing: readonly (string | null)[]): string {
  const highest = existing.reduce((max, id) => {
    const match = id === null ? null : /^DES-(\d+)$/.exec(id);
    return match === null ? max : Math.max(max, Number(match[1]));
  }, 0);
  return `DES-${String(highest + 1).padStart(3, "0")}`;
}

/** `docs/designs/007-design-alta-de-miembros` — the folder a new package gets. */
export function designFolder(root: string, packageId: string, slug: string): string {
  const serial = /^DES-(\d+)$/.exec(packageId)?.[1] ?? "000";
  return `${root}/${serial}-design-${slug}`;
}
