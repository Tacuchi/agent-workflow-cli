import type { ScreenArtifact, ScreenTraceEntry } from "./artifact.js";
import type { CatalogEntry } from "./manifest.js";
import type { DesignRendition, RenditionFormat } from "./rendition.js";
import type { DesignFailure } from "./validation.js";

/**
 * The other half of the elevated `handoff` gate: does the evidence a screen
 * CITES actually show what the screen says it shows?
 *
 * `maturity.ts` judges the document alone — every criterion classified, the base
 * state enumerated with a rendition. That is all one file can prove. But a
 * reference to `DES-001/VIS-003@r1` is a claim about another document, and the
 * whole point of requiring visual evidence is defeated if the reference is enough
 * on its own: a screen could cite a rendition of a different screen, of an older
 * revision, or one that covers nothing at all, and pass.
 *
 * So this crosses the two directions of the same matrix. The screen says *this
 * criterion is shown here*; the rendition says *I cover these criteria and these
 * states, and I came out of these revisions*. Both have to agree, and the
 * rendition is the one that has to back the claim up.
 *
 * It lives in the domain and takes a reader, so the caller decides how documents
 * are loaded — and it is called from the publication path, where a revision is
 * about to be sealed and there is still time to refuse.
 */

/** Formats a person can open with no provider, no account and no network. */
const STATIC_PREVIEW_FORMATS: readonly RenditionFormat[] = ["svg", "png", "jpeg", "webp", "pdf"];

/** How the caller loads a rendition it finds in the catalog. */
export type RenditionReader = (path: string) => DesignRendition | null;

/**
 * Cross the screen's classification matrix against the renditions it cites.
 *
 * Only for a screen claiming `handoff`: an `outline` may cite a rendition that is
 * still being drawn, and refusing that would make the early profile unusable.
 */
export function crossVisualEvidence(
  catalog: readonly CatalogEntry[],
  screen: ScreenArtifact,
  file: string,
  readRendition: RenditionReader,
): DesignFailure[] {
  if (screen.maturity !== "handoff") return [];

  const failures: DesignFailure[] = [];
  const loaded = new Map<string, DesignRendition>();
  let cited = 0;

  for (const entry of screen.trace) {
    if (entry.classification === null || entry.classification === "not_visual") continue;
    for (const ref of entry.renditions) {
      cited += 1;
      const rendition = resolve(catalog, ref, file, readRendition, loaded, failures);
      if (rendition === null) continue;
      failures.push(...checkBacksClaim(screen, entry, ref, rendition, file));
    }
    if (entry.classification === "interaction") {
      failures.push(...checkInteractionEvidence(entry, loaded, file));
    }
  }

  // Si NINGUNA cita se pudo cargar, la causa ya está dicha: agregar «no hay
  // preview estática» sería un segundo diagnóstico del mismo problema, y el
  // primero es el que se arregla.
  if (cited > 0 && loaded.size === 0) return failures;
  failures.push(...checkStaticPreview(screen, loaded, file));
  return failures;
}

/** Load a cited rendition once, reporting the two ways a citation can dangle. */
function resolve(
  catalog: readonly CatalogEntry[],
  ref: string,
  file: string,
  readRendition: RenditionReader,
  loaded: Map<string, DesignRendition>,
  failures: DesignFailure[],
): DesignRendition | null {
  const cached = loaded.get(ref);
  if (cached !== undefined) return cached;

  const [, tail] = ref.split("/");
  const [id, revision] = (tail ?? "").split("@r");
  const entry = catalog.find((e) => e.id === id && e.revision === Number(revision));
  if (entry === undefined) {
    failures.push({
      code: "DESIGN_REFERENCE_MISSING",
      artifact: file,
      message: `cita ${ref} como evidencia y el catálogo no la contiene`,
      action: "publicá esa rendition dentro del package, o citá una que exista",
    });
    return null;
  }
  const rendition = readRendition(entry.path);
  if (rendition === null) {
    failures.push({
      code: "DESIGN_REFERENCE_FILE_MISSING",
      artifact: file,
      message: `cita ${ref} y su '${entry.path}' no se pudo leer como una rendition válida`,
      action: "reparalo: una evidencia que no se puede abrir no evidencia nada",
    });
    return null;
  }
  loaded.set(ref, rendition);
  return rendition;
}

/** The three ways a cited rendition can fail to back the claim made about it. */
function checkBacksClaim(
  screen: ScreenArtifact,
  entry: ScreenTraceEntry,
  ref: string,
  rendition: DesignRendition,
  file: string,
): DesignFailure[] {
  const insufficient = (message: string, action: string): DesignFailure => ({
    code: "DESIGN_VISUAL_EVIDENCE_REQUIRED",
    artifact: file,
    message: `trace['${entry.criterion}'] cita ${ref}, que ${message}`,
    action,
  });
  const failures: DesignFailure[] = [];

  // Que salió de ESTA revisión, no de otra que se le parece: una preview de r1
  // presentada como evidencia de r2 es precisamente el snapshot confundido con
  // algo más reciente que AC-REN-07 nombra.
  const mine = `${screen.id}@r${screen.revision}`;
  if (!rendition.sources.some((s) => s.ref === mine || s.ref.startsWith(`${mine}#`))) {
    failures.push(
      insufficient(
        `no salió de ${mine} (declara ${rendition.sources.map((s) => s.ref).join(", ")})`,
        "regenerá la rendition sobre esta revisión, o citá la que sí salió de ella",
      ),
    );
  }
  if (!rendition.coverage.criteria.includes(entry.criterion)) {
    failures.push(
      insufficient(
        `no declara cubrir '${entry.criterion}'`,
        "agregá el criterio a 'coverage.criteria' de la rendition, o citá otra que lo muestre",
      ),
    );
  }
  const uncovered = entry.states.filter((s) => !rendition.coverage.states.includes(s));
  if (uncovered.length > 0 && rendition.coverage.states.length > 0) {
    failures.push(
      insufficient(
        `no cubre ${uncovered.join(", ")}`,
        "cubrí esos estados en la rendition, o citá una adicional para ellos",
      ),
    );
  }
  return failures;
}

/**
 * AC-REN-02, last clause: an `interaction` entry evidences trigger, transition
 * and outcome. A picture of the end state is not that, so at least one of the
 * renditions it cites has to be the prototype or storyboard that shows it.
 */
function checkInteractionEvidence(
  entry: ScreenTraceEntry,
  loaded: Map<string, DesignRendition>,
  file: string,
): DesignFailure[] {
  const cited = entry.renditions.map((ref) => loaded.get(ref)).filter((r) => r !== undefined);
  if (cited.length === 0) return []; // ya reportado como cita colgante
  if (cited.some((r) => r.interaction_evidence !== null)) return [];
  return [
    {
      code: "DESIGN_VISUAL_EVIDENCE_REQUIRED",
      artifact: file,
      message: `trace['${entry.criterion}'] es 'interaction' y ninguna de sus renditions evidencia trigger, transición y outcome`,
      action:
        "agregá un prototipo o un storyboard estático con 'interaction_evidence', o reclasificá el criterio como 'visual'",
    },
  ];
}

/**
 * AC-REN-01: the base state survives without the provider.
 *
 * The document-level gate already demanded that some criterion enumerate
 * `default_state` with a rendition. What it could not check is whether that
 * rendition is one a person can OPEN — an `interactive_html` behind a private
 * Figma link is a citation, not a preview.
 */
function checkStaticPreview(
  screen: ScreenArtifact,
  loaded: Map<string, DesignRendition>,
  file: string,
): DesignFailure[] {
  const covering = [...loaded.values()].filter(
    (r) =>
      r.coverage.states.includes(screen.default_state) &&
      STATIC_PREVIEW_FORMATS.includes(r.format) &&
      r.files.length > 0,
  );
  if (covering.length > 0) return [];
  return [
    {
      code: "DESIGN_VISUAL_EVIDENCE_REQUIRED",
      artifact: file,
      message: `ninguna rendition citada conserva una preview estática local de '${screen.default_state}'`,
      action: `el gate 'handoff' pasó a exigir evidencia visual local: publicá una preview en ${STATIC_PREVIEW_FORMATS.join(", ")} que cubra el estado base y citala, o bajá la screen a 'outline'`,
    },
  ];
}
