import type { DesignArtifact } from "./artifact.js";
import { parseArtifactRef } from "./identity.js";
import type { CatalogEntry, DesignManifest } from "./manifest.js";
import type { DesignFailure } from "./validation.js";

/**
 * What a task actually consumes (AC-SEM-09).
 *
 * A package mixes maturities on purpose: ten screens in `outline` and three
 * promoted is the normal shape, not a defect. So "is this ready?" is never a
 * question about the package — it is a question about the exact roots a task
 * declares, and about what those roots reach.
 *
 * The closure is what makes that question answerable. From the roots it walks
 * flows to their nodes, screens to their flows, and both to the rules, tokens
 * and assets they depend on — and it stops. Everything it does not reach stays
 * exactly as it is: promoting a package because a task needed one screen would
 * make maturity meaningless.
 */

/** One artifact revision the closure reached, and why. */
export interface ClosureMember {
  /** `DES-001/SCR-001@r2`. */
  ref: string;
  kind: "flow" | "screen" | "rule" | "token" | "rendition";
  /** The state anchors required, for screens reached through an anchored ref. */
  states: string[];
  /** The root, or the member, that pulled it in. `null` for a declared root. */
  via: string | null;
}

export interface DesignClosure {
  members: ClosureMember[];
  /** Content digests reached through `dependencies.assets`. */
  assets: string[];
  failures: DesignFailure[];
}

/** How the closure reads a document it needs: by catalog path. */
export type ArtifactReader = (path: string) => DesignArtifact | null;

const KIND_OF_PREFIX: Record<string, ClosureMember["kind"]> = {
  FLW: "flow",
  SCR: "screen",
  RUL: "rule",
  TOK: "token",
  VIS: "rendition",
};

export function computeClosure(
  manifest: DesignManifest,
  roots: string[],
  read: ArtifactReader,
): DesignClosure {
  const members = new Map<string, ClosureMember>();
  const assets = new Set<string>();
  const failures: DesignFailure[] = [];
  const queue: Array<{ ref: string; via: string | null }> = roots.map((ref) => ({
    ref,
    via: null,
  }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const reached = visit(manifest, next, members, read);
    if ("failure" in reached) {
      failures.push(reached.failure);
      continue;
    }
    for (const ref of reached.refs) queue.push({ ref, via: reached.via });
    for (const digest of reached.assets) {
      // Un asset se alcanza solo si el package lo CUSTODIA: afirmar haber
      // llegado a bytes que no están es la clausura mintiendo sobre su alcance.
      if (manifest.catalog.assets.some((a) => a.digest === digest)) assets.add(digest);
      else failures.push(uncustodied(digest, manifest.id));
    }
  }

  return { members: [...members.values()], assets: [...assets], failures };
}

/**
 * Reaching the same revision twice can only WIDEN what is required.
 *
 * `states: []` means the whole revision, not "no states": a root written
 * without an anchor asked for all of it. So an anchor never narrows a member
 * that was already whole, and a whole reference swallows the anchors collected
 * so far — otherwise adding a MORE specific root would shrink the closure.
 */
function widen(member: ClosureMember, anchor: string | null): void {
  if (member.states.length === 0) return;
  if (anchor === null) {
    member.states.length = 0;
    return;
  }
  if (!member.states.includes(anchor)) member.states.push(anchor);
}

/** One step of the walk: admit the reference, or say why it does not resolve. */
function visit(
  manifest: DesignManifest,
  next: { ref: string; via: string | null },
  members: Map<string, ClosureMember>,
  read: ArtifactReader,
): { refs: string[]; assets: string[]; via: string | null } | { failure: DesignFailure } {
  const nothing = { refs: [], assets: [], via: null };
  const parsed = parseArtifactRef(next.ref);
  if (parsed === null || parsed.package !== manifest.id) {
    return { failure: foreignRoot(next.ref, manifest.id) };
  }
  const key = `${parsed.package}/${parsed.artifact}@r${parsed.revision}`;
  const anchor: string | null = parsed.state ?? null;

  const already = members.get(key);
  if (already !== undefined) {
    widen(already, anchor);
    return nothing;
  }

  const entry = findEntry(manifest, parsed.artifact, parsed.revision);
  const kind = KIND_OF_PREFIX[parsed.artifact.slice(0, 3)];
  if (entry === null || kind === undefined) {
    return { failure: unresolvable(next.ref, manifest.id) };
  }
  members.set(key, { ref: key, kind, states: anchor === null ? [] : [anchor], via: next.via });
  if (kind !== "flow" && kind !== "screen") return nothing;

  const document = read(entry.path);
  if (document === null) return { failure: unreadable(entry.path, key) };
  return { refs: reachableFrom(document), assets: assetsOf(document), via: key };
}

/**
 * Everything a document DEPENDS ON, in the closure's terms.
 *
 * `flow_refs` is deliberately absent. It records which flows visit a screen —
 * the INVERSE of `flow.nodes`, the screen's membership, not its needs. Walking
 * both directions turns the closure into the connected component of the graph:
 * one screen would drag in every flow that mentions it and every screen those
 * flows touch, and a task would be blocked by designs it never consumes.
 */
function reachableFrom(document: DesignArtifact): string[] {
  if (document.kind === "flow") {
    return [document.entry, ...document.nodes, ...document.dependencies];
  }
  return [...document.dependencies.rules, ...document.dependencies.tokens];
}

function assetsOf(document: DesignArtifact): string[] {
  return document.kind === "flow" ? [] : document.dependencies.assets;
}

function findEntry(manifest: DesignManifest, id: string, revision: number): CatalogEntry | null {
  for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
    const hit = manifest.catalog[key].find((e) => e.id === id && e.revision === revision);
    if (hit !== undefined) return hit;
  }
  return null;
}

function foreignRoot(ref: string, packageId: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_MISSING",
    artifact: ref,
    message: `'${ref}' no es una referencia resoluble dentro de ${packageId}`,
    action: "una clausura se calcula dentro de un package: usá DES-NNN/XXX-NNN@rN",
  };
}

function unresolvable(ref: string, packageId: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_MISSING",
    artifact: ref,
    message: `${packageId} no cataloga '${ref}'`,
    action: "revisá la revisión exacta: la clausura no adivina la vigente",
  };
}

function uncustodied(digest: string, packageId: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_MISSING",
    artifact: digest,
    message: `${packageId} no custodia el asset ${digest}`,
    action: "publicá el asset dentro del package: una clausura no alcanza bytes que no están",
  };
}

function unreadable(path: string, ref: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_FILE_MISSING",
    artifact: path,
    message: `'${path}' no se pudo leer para expandir ${ref}`,
    action: "el catálogo promete ese archivo: restauralo o corregí su ruta",
  };
}

/**
 * The maturity a set of roots demands.
 *
 * Consuming an `outline` revision is not an error in itself — a task may
 * legitimately reference a design that is still being shaped. What fails closed
 * is IMPLEMENTING against it, which is the question this answers: which members
 * of the closure are not yet `handoff`.
 */
export function notReadyForHandoff(
  manifest: DesignManifest,
  closure: DesignClosure,
): ClosureMember[] {
  return closure.members.filter((member) => {
    if (member.kind !== "flow" && member.kind !== "screen") return false;
    const key = member.kind === "flow" ? "flows" : "screens";
    const id = member.ref.split("/")[1]?.split("@")[0];
    const revision = Number(member.ref.split("@r")[1]);
    const entry = manifest.catalog[key].find((e) => e.id === id && e.revision === revision);
    return entry?.maturity !== "handoff";
  });
}
