import { join } from "node:path";
import { validateDesignArtifact } from "../../domain/design/artifact.js";
import type { ArtifactRef } from "../../domain/design/identity.js";
import type { BaselineEntry, CatalogEntry, DesignFailure } from "../../domain/design/manifest.js";
import type { SpecDesignReference, TaskDesignReference } from "../../domain/design/reference.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { DesignIndex, DesignPackageEntry } from "./design-index-service.js";

/**
 * Resolving a published reference.
 *
 * Identity resolves; the path only helps. The order matters and is the spec's:
 * check the hint first, and if the dossier moved, look under `docs/designs/`
 * for the single package/revision/digest that matches. One exact match keeps
 * the reference valid and reports the hint as stale so it can be repaired;
 * zero or several fail.
 *
 * That asymmetry is the whole design: renaming a folder must never break a
 * task written a year ago, and a digest that no longer matches must never
 * resolve quietly.
 */

export type HintState = "valid" | "stale";

export interface ResolvedBaseline {
  hint: HintState;
  package_id: string;
  /** Where the package lives RIGHT NOW, workspace-relative. */
  package_path: string;
  revision: number;
  digest: string;
  /** Workspace-relative path of the baseline file, as it stands today. */
  path: string;
  /** What the reference declared, when it no longer points at the baseline. */
  declared_hint?: string;
}

export interface ResolvedArtifact extends ResolvedBaseline {
  /**
   * Null when the reference pins the design by its ROOT — the whole shape of a
   * simple design, which has no catalog to point into.
   */
  artifact_id: string | null;
  artifact_revision: number | null;
  /** Workspace-relative path of the flow or screen document; null on a root pin. */
  artifact_path: string | null;
  /** The state anchor the reference names, when it names one. */
  state?: string;
}

export type Resolution<T> = { ok: true; value: T } | { ok: false; failure: DesignFailure };

function fail(
  code: string,
  artifact: string,
  message: string,
  action: string,
): {
  ok: false;
  failure: DesignFailure;
} {
  return { ok: false, failure: { code, artifact, message, action } };
}

/**
 * Resolve `package: DES-001@r4` + its hint + its digest against the workspace.
 * `artifact` names the DOCUMENT that carries the reference, so a diagnostic
 * points at the spec or plan to fix, not at the package.
 */
export function resolveBaselineReference(
  index: DesignIndex,
  reference: SpecDesignReference,
  artifact: string,
): Resolution<ResolvedBaseline> {
  const id = reference.baseline.package;
  const revision = reference.baseline.revision;

  // The lookup key is the TRIPLE — package, revision and digest — not the id.
  // The spec is explicit about it, and it matters: a workspace where two folders
  // claim one identity but only one of them published this exact revision still
  // has a single answer, and a reference written a year ago deserves it.
  const claiming = index.packages.filter((p) => p.id === id);
  const matching = claiming.filter((p) => findBaseline(p, revision)?.digest === reference.digest);

  if (matching.length > 1) {
    return fail(
      "DESIGN_REFERENCE_AMBIGUOUS",
      artifact,
      `${id}@r${revision} con ese digest aparece en ${matching.length} packages (${matching.map((p) => p.path).join(", ")})`,
      "una identidad pertenece a un solo package: corregí el id de los demás",
    );
  }

  if (matching.length === 1) {
    const pkg = matching[0] as DesignPackageEntry;
    const found = findBaseline(pkg, revision) as BaselineEntry;
    const path = `${pkg.path}/${found.path}`;
    const stale = path !== reference.baseline_hint;
    return {
      ok: true,
      value: {
        hint: stale ? "stale" : "valid",
        package_id: id,
        package_path: pkg.path,
        revision,
        digest: found.digest,
        path,
        ...(stale ? { declared_hint: reference.baseline_hint } : {}),
      },
    };
  }

  return explainNoMatch(index, claiming, reference, artifact);
}

/** Nothing matched the triple. Say WHICH of the four reasons it was. */
function explainNoMatch(
  index: DesignIndex,
  claiming: DesignPackageEntry[],
  reference: SpecDesignReference,
  artifact: string,
): { ok: false; failure: DesignFailure } {
  const id = reference.baseline.package;
  const revision = reference.baseline.revision;

  if (claiming.length > 1) {
    return fail(
      "DESIGN_REFERENCE_AMBIGUOUS",
      artifact,
      `${id} está declarado por ${claiming.length} packages (${claiming.map((p) => p.path).join(", ")}) y ninguno publicó r${revision} con ese digest`,
      "una identidad pertenece a un solo package: corregí el id de los demás",
    );
  }

  if (claiming.length === 0) {
    // A folder that CLAIMS the identity but does not validate is a broken
    // package, not an absent one — and the fix is completely different.
    const broken = index.packages.find((p) => p.declared_id === id);
    if (broken !== undefined) {
      return fail(
        "DESIGN_REFERENCE_PACKAGE_INVALID",
        artifact,
        `'${broken.path}' declara ${id} y su manifest no valida: ${broken.failures[0]?.message ?? "sin detalle"}`,
        broken.failures[0]?.action ?? "reparalo y volvé a resolver",
      );
    }
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `no existe ningún package ${id} bajo ${index.root}/`,
      "revisá 'aw designs': el package pudo no haberse publicado todavía, o su manifest no valida",
    );
  }

  const pkg = claiming[0] as DesignPackageEntry;
  const found = findBaseline(pkg, revision);
  if (found === null) {
    const published = (pkg.manifest?.baselines ?? []).map((b) => `r${b.revision}`);
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `${id} no publicó la revisión r${revision}`,
      `las publicadas son: ${published.join(", ") || "(ninguna)"}`,
    );
  }
  return fail(
    "DESIGN_REFERENCE_DIGEST_MISMATCH",
    artifact,
    `${id}@r${revision} tiene digest ${found.digest} y la referencia fija ${reference.digest}`,
    "no edites una revisión publicada: creá la siguiente y reapuntá esta referencia a ella",
  );
}

/**
 * Resolve `DES-001@r4 / SCR-002@r2#empty`. The baseline resolves first: an
 * artifact is only meaningful inside the revision of the package that selects
 * it.
 */
export function resolveTaskReference(
  index: DesignIndex,
  reference: TaskDesignReference,
  hints: SpecDesignReference[],
  artifact: string,
): Resolution<ResolvedArtifact> {
  // A plan may pin more than one package, so the hint is chosen by identity AND
  // revision: the task's own `DES-001@r4` is what it fixed, and resolving
  // against a different revision of the same package would answer a question
  // nobody asked.
  const hint = hints.find(
    (h) =>
      h.baseline.package === reference.baseline.package &&
      h.baseline.revision === reference.baseline.revision,
  );
  if (hint === undefined) {
    const declared = hints.map((h) => `${h.baseline.package}@r${h.baseline.revision}`);
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `la tarea fija ${reference.baseline.package}@r${reference.baseline.revision} y las referencias declaradas son: ${declared.join(", ") || "(ninguna)"}`,
      "declará ese baseline en '## Design references', o corregí la referencia de la tarea",
    );
  }
  const baseline = resolveBaselineReference(index, hint, artifact);
  if (!baseline.ok) return baseline;

  const pkg = index.packages.find((p) => p.id === reference.baseline.package) as DesignPackageEntry;

  // A ROOT pin consumes the revision itself. It is the only legal form for a
  // simple design and a legitimate one for a package — "this task implements the
  // whole revision" — so it resolves as soon as the baseline does.
  if (reference.artifact === null) {
    return {
      ok: true,
      value: { ...baseline.value, artifact_id: null, artifact_revision: null, artifact_path: null },
    };
  }

  // The asymmetry is the point: a simple design does not have this artifact
  // MISSING, it has no catalog at all, and telling the author to "publish the
  // one that is missing" would send them to build the package the route exists
  // to avoid.
  if (pkg.mode === "simple") {
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `${reference.raw}: ${pkg.id} es un diseño simple y no cataloga artefactos`,
      `referencialo por su raíz, '${reference.baseline.package}@r${reference.baseline.revision}': todo su contenido es un solo DESIGN.md`,
    );
  }

  const entry = findCatalogEntry(pkg, reference.artifact);
  if (entry === null) {
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `${reference.raw}: el catálogo de ${pkg.id} no contiene ${reference.artifact.artifact}@r${reference.artifact.revision}`,
      "referenciá una revisión catalogada, o publicá la que falta",
    );
  }

  return {
    ok: true,
    value: {
      ...baseline.value,
      artifact_id: entry.id,
      artifact_revision: entry.revision,
      artifact_path: `${pkg.path}/${entry.path}`,
      ...(reference.artifact.state !== undefined ? { state: reference.artifact.state } : {}),
    },
  };
}

/**
 * The resolution above is pure: it answers from the index and never touches the
 * disk. That is the right default — but a reference that resolves "valid" to a
 * file nobody can open is a fail-open, so whoever is about to USE the baseline
 * confirms it is there.
 */
export async function resolveBaselineOnDisk(
  fs: FileSystemPort,
  workspace: string,
  resolved: ResolvedBaseline,
  artifact: string,
): Promise<Resolution<ResolvedBaseline>> {
  if (await fs.exists(join(workspace, resolved.path))) return { ok: true, value: resolved };
  return fail(
    "DESIGN_REFERENCE_FILE_MISSING",
    artifact,
    `el manifest de ${resolved.package_id} dice que r${resolved.revision} vive en '${resolved.path}' y ese archivo no está`,
    "restaurá el baseline o corregí su path en el manifest del package",
  );
}

/**
 * A state resolves only if the screen revision that owns it declares the
 * anchor. This is the one resolution step that has to read a file: the anchors
 * live in the screen's frontmatter, which is exactly where F2 put them.
 */
export async function resolveStateAnchor(
  fs: FileSystemPort,
  workspace: string,
  resolved: ResolvedArtifact,
  artifact: string,
): Promise<Resolution<ResolvedArtifact>> {
  if (resolved.state === undefined || resolved.artifact_path === null) {
    return { ok: true, value: resolved };
  }

  const absolute = join(workspace, resolved.artifact_path);
  if (!(await fs.exists(absolute))) {
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `'${resolved.artifact_path}' no existe, y el catálogo dice que ahí vive ${resolved.artifact_id}@r${resolved.artifact_revision}`,
      "restaurá el archivo o corregí el path en el manifest del package",
    );
  }

  const document = validateDesignArtifact(
    await fs.readText(absolute),
    "screen",
    resolved.artifact_path,
  );
  if (!document.ok || document.value === null || document.value.kind !== "screen") {
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `no se puede resolver el estado '#${resolved.state}': '${resolved.artifact_path}' no valida como screen`,
      `corré la validación del package y reparalo: ${document.failures[0]?.message ?? "sin detalle"}`,
    );
  }

  const anchors = document.value.states.map((s) => s.anchor);
  if (!anchors.includes(resolved.state)) {
    return fail(
      "DESIGN_REFERENCE_MISSING",
      artifact,
      `${resolved.artifact_id}@r${resolved.artifact_revision} no declara el estado '#${resolved.state}'`,
      `los estados de esa revisión son: ${anchors.join(", ") || "(ninguno)"}`,
    );
  }
  return { ok: true, value: resolved };
}

function findBaseline(pkg: DesignPackageEntry, revision: number): BaselineEntry | null {
  return pkg.manifest?.baselines.find((b) => b.revision === revision) ?? null;
}

function findCatalogEntry(pkg: DesignPackageEntry, ref: ArtifactRef): CatalogEntry | null {
  if (pkg.manifest === null) return null;
  for (const list of Object.values(pkg.manifest.catalog)) {
    for (const entry of list) {
      if ("id" in entry && entry.id === ref.artifact && entry.revision === ref.revision) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * The stale hint as a REPORT. AC-REF-07 asks for the reference to keep its
 * validity *and* for the stale hint to be reported — this is the second half,
 * kept out of the failure list on purpose: a repaired hint is not a rejection.
 */
export function staleHintNotice(
  resolved: ResolvedBaseline,
  artifact: string,
): DesignFailure | null {
  if (resolved.hint !== "stale" || resolved.declared_hint === undefined) return null;
  return {
    code: "DESIGN_HINT_STALE",
    artifact,
    message: `baseline_hint apunta a '${resolved.declared_hint}' y ${resolved.package_id}@r${resolved.revision} vive en '${resolved.path}'`,
    action: `actualizá el hint a '${resolved.path}': la referencia sigue siendo válida, el path quedó viejo`,
  };
}
