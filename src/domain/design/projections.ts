import type { CatalogEntry, DesignManifest } from "./manifest.js";
import { PROJECTIONS } from "./naming.js";
import type { DesignFailure } from "./validation.js";

/**
 * `PACKAGE.md` and `design-system/DESIGN.md` — the two regenerable projections.
 *
 * Neither is normative and neither is ever sealed: a baseline that selected one
 * would make a published revision depend on something derived, so re-rendering
 * the landing page would rewrite history. They exist because a human opening a
 * dossier needs a way in, and because Stitch-style handoff reads `DESIGN.md`.
 *
 * The rule that keeps them honest: a projection **repeats no normative
 * content**. It points at where things live and says which revision it was
 * rendered from. Anything a projection asserted on its own would be a second
 * source of truth for a fact the manifest or the artifact already owns.
 */

/** Marker line that ties a rendered projection to the revision it came from. */
const SOURCE_MARK = "<!-- workline:projection source=";

export function sourceMark(packageId: string, revision: number): string {
  // `@r0` no existe: una proyección de un package sin publicar declara eso y no
  // una revisión que nadie puede resolver.
  return `${SOURCE_MARK}${sourceSuffix(packageId, revision)} -->`;
}

/** How a source revision is written inside a projection mark. */
function sourceSuffix(packageId: string, revision: number): string {
  return revision === 0 ? `${packageId}@sin-publicar` : `${packageId}@r${revision}`;
}

/** The revision a projection declares it was rendered from, or null. */
export function declaredSource(text: string): string | null {
  const match = new RegExp(`${SOURCE_MARK}(\\S+) -->`).exec(text);
  return match === null ? null : (match[1] as string);
}

/**
 * The human landing page. Locations and identities only: a reader finds a flow,
 * a screen, its states and its renditions, and then opens the artifact — which
 * is where the design actually lives.
 */
export function renderPackageMd(manifest: DesignManifest): string {
  const current = manifest.current_baseline;
  const lines: string[] = [
    `# ${manifest.title}`,
    "",
    sourceMark(manifest.id, current?.revision ?? 0),
    "",
    "> Página regenerable. No es normativa y no forma parte de ningún digest:",
    "> el manifest y los baselines son la autoridad.",
    "",
    `- **Identidad:** \`${manifest.id}\``,
    `- **Baseline vigente:** ${current === null ? "sin publicar" : `\`${manifest.id}@r${current.revision}\``}`,
    `- **Creado:** ${manifest.created}`,
  ];
  if (manifest.derived_from !== null) {
    lines.push(`- **Derivado de:** \`${manifest.derived_from}\``);
  }

  for (const [heading, entries] of [
    ["Flows", manifest.catalog.flows],
    ["Screens", manifest.catalog.screens],
    ["Reglas", manifest.catalog.rules],
    ["Tokens", manifest.catalog.tokens],
    ["Renditions", manifest.catalog.renditions],
  ] as Array<[string, CatalogEntry[]]>) {
    if (entries.length === 0) continue;
    lines.push("", `## ${heading}`, "");
    for (const entry of currentRevisions(entries)) {
      const maturity = entry.maturity === undefined ? "" : ` · ${entry.maturity}`;
      lines.push(
        `- \`${entry.id}@r${entry.revision}\`${maturity} — [\`${entry.path}\`](${entry.path})`,
      );
      // Un estado se localiza por su referencia completa; lo que ese estado DICE
      // sigue viviendo solo en el documento.
      for (const anchor of entry.states ?? []) {
        lines.push(
          `  - \`${manifest.id}/${entry.id}@r${entry.revision}#${anchor}\` — [\`${entry.path}\`](${entry.path})`,
        );
      }
    }
  }

  if (manifest.catalog.assets.length > 0) {
    lines.push(
      "",
      "## Assets",
      "",
      `${manifest.catalog.assets.length} content-addressed bajo \`assets/\`.`,
    );
  }

  const consumers = [...manifest.relations.specs, ...manifest.relations.plans];
  if (consumers.length > 0) {
    lines.push("", "## Consumido por", "");
    // Ruta relativa al workspace, no un enlace: el dossier puede vivir en una
    // subcarpeta de `docs/designs/`, y un `../../../` fijo apuntaría a la nada.
    for (const path of consumers) lines.push(`- \`${path}\``);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The agent-friendly ruleset. It lists the rules in force and where they live;
 * it never restates what a rule SAYS, because the rule file owns that.
 */
export function renderDesignMd(manifest: DesignManifest): string {
  const current = manifest.current_baseline;
  const rules = currentRevisions(manifest.catalog.rules);
  const lines: string[] = [
    `# Design rules — ${manifest.title}`,
    "",
    sourceMark(manifest.id, current?.revision ?? 0),
    "",
    "> Proyección regenerable del ruleset vigente, fuera del digest normativo.",
    "> Cada regla es autoridad de su propio contenido: acá solo se listan.",
    "",
  ];
  if (rules.length === 0) {
    lines.push("Este package no declara reglas de design system.");
  } else {
    for (const rule of rules) {
      lines.push(`- \`${rule.id}@r${rule.revision}\` — [\`${rule.path}\`](../${rule.path})`);
    }
  }
  const tokens = currentRevisions(manifest.catalog.tokens);
  if (tokens.length > 0) {
    lines.push("", "## Tokens", "");
    for (const token of tokens) {
      lines.push(`- \`${token.id}@r${token.revision}\` — [\`${token.path}\`](../${token.path})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface ProjectionCheck {
  path: string;
  failures: DesignFailure[];
}

/**
 * A projection is checkable against the manifest: regenerate it and compare.
 * A drifted one is reported rather than trusted — it is the only thing a reader
 * sees first, and a stale landing page sends them to a file that moved.
 */
export function checkProjection(
  path: string,
  actual: string,
  manifest: DesignManifest,
): DesignFailure[] {
  if (!PROJECTIONS.includes(path)) {
    return [
      {
        code: "DESIGN_FIELD_INVALID",
        artifact: path,
        message: `'${path}' no es una proyección del contrato`,
        action: `las proyecciones son: ${PROJECTIONS.join(", ")}`,
      },
    ];
  }
  const expected = path === "PACKAGE.md" ? renderPackageMd(manifest) : renderDesignMd(manifest);
  // Un checkout con `core.autocrlf` deja CRLF en disco. Comparar fines de línea
  // reportaría stale una proyección correcta, y culpando a la revisión.
  if (actual.replace(/\r\n/g, "\n") === expected) return [];

  const declared = declaredSource(actual);
  const current = manifest.current_baseline;
  const now = sourceSuffix(manifest.id, current?.revision ?? 0);
  return [
    {
      code: "DESIGN_PROJECTION_STALE",
      artifact: path,
      message:
        declared === now
          ? `'${path}' dice venir de ${now} y no coincide con lo que el manifest describe`
          : `'${path}' fue renderizada desde ${declared ?? "una revisión que no declara"} y la vigente es ${now}`,
      action: "regeneralá desde el manifest: es una proyección, no una fuente",
    },
  ];
}

/** Highest revision per id — what the package IS right now. */
function currentRevisions(entries: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    const seen = byId.get(entry.id);
    if (seen === undefined || entry.revision > seen.revision) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export { currentRevisions };
