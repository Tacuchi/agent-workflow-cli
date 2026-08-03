/**
 * Where each normative artifact lives, and what its file is called.
 *
 * This is what makes immutability CHECKABLE rather than promised: the revision
 * is part of the file name, so publishing `@r2` writes a new file and cannot
 * overwrite `@r1` — not by policy, but because they are different paths. An
 * asset goes further and carries its own digest, so different bytes can never
 * occupy the same name.
 *
 * The directory layout is contract too (spec § *Package unit and durable
 * location*): `flows/`, `screens/`, `baselines/` and `governance/` always
 * exist; `design-system/`, `renditions/`, `tokens/` and `assets/` appear when
 * the content requires them.
 */

export interface NamingRule {
  /** Directory the artifact lives in, relative to the package root. */
  dir: string;
  /** Build the expected file-name prefix for an id and revision. */
  prefix: (id: string, revision: number) => string;
  /** Suffix the file name must end with. */
  suffix: string;
}

/** `2` → `r002`. Three digits so a directory listing sorts the way a human reads it. */
export function revisionSegment(revision: number): string {
  return `r${String(revision).padStart(3, "0")}`;
}

export const NAMING: Record<"flow" | "screen" | "rule" | "token" | "rendition", NamingRule> = {
  flow: {
    dir: "flows",
    prefix: (id, revision) => `${id}-${revisionSegment(revision)}-`,
    suffix: ".md",
  },
  screen: {
    dir: "screens",
    prefix: (id, revision) => `${id}-${revisionSegment(revision)}-`,
    suffix: ".md",
  },
  rule: {
    dir: "design-system/rules",
    prefix: (id, revision) => `${id}-${revisionSegment(revision)}-`,
    suffix: ".md",
  },
  token: {
    dir: "tokens",
    prefix: (id, revision) => `${id}-${revisionSegment(revision)}-`,
    suffix: ".tokens.json",
  },
  rendition: {
    dir: "renditions",
    prefix: (id, revision) => `${id}-${revisionSegment(revision)}-`,
    suffix: "/rendition.json",
  },
};

/** `baselines/DES-001-r004.json` — no slug: a baseline seals a revision, not a name. */
export function baselinePath(packageId: string, revision: number): string {
  return `baselines/${packageId}-${revisionSegment(revision)}.json`;
}

/**
 * Regenerable projections. They are NOT normative and never appear in the
 * catalog: a baseline that selected them would make its digest depend on
 * something derived, and re-rendering the landing page would rewrite history.
 */
export const PROJECTIONS = ["PACKAGE.md", "design-system/DESIGN.md"];

/**
 * Where each governance record lives (T7.1).
 *
 * Separate from `NAMING` on purpose: a record is not a normative artifact, is
 * never selected by a baseline, and has no revision of its own — it decides ON
 * one. Folding it into the same table would hand it a revision segment it must
 * not have.
 */
export const GOVERNANCE_NAMING: Record<"review" | "revocation", { dir: string; prefix: string }> = {
  review: { dir: "governance/reviews", prefix: "REV-" },
  revocation: { dir: "governance/revocations", prefix: "RVK-" },
};

/** `governance/reviews/REV-001.json`, or why the path does not honor the rule. */
export function checkGovernanceNaming(
  kind: "review" | "revocation",
  path: string,
  id: string,
): NamingCheck {
  const rule = GOVERNANCE_NAMING[kind];
  const expected = `${rule.dir}/${id}.json`;
  if (path === expected) return { ok: true };
  return {
    ok: false,
    why: `'${path}' no es la ubicación de ${id}`,
    expected,
  };
}

export type NamedKind = keyof typeof NAMING;

export interface NamingCheck {
  ok: boolean;
  /** Why the path does not honor the rule, ready to be put in a diagnostic. */
  why?: string;
  expected?: string;
}

/** Does `path` name revision `revision` of artifact `id`, in the right place? */
export function checkNaming(
  kind: NamedKind,
  path: string,
  id: string,
  revision: number,
): NamingCheck {
  const rule = NAMING[kind];
  const expected = `${rule.dir}/${rule.prefix(id, revision)}<slug>${rule.suffix}`;

  if (PROJECTIONS.includes(path)) {
    return {
      ok: false,
      why: `'${path}' es una proyección regenerable y no puede catalogarse como artefacto normativo`,
      expected,
    };
  }
  if (!path.startsWith(`${rule.dir}/`)) {
    return { ok: false, why: `'${path}' no vive en '${rule.dir}/'`, expected };
  }
  const rest = path.slice(rule.dir.length + 1);
  if (!rest.startsWith(rule.prefix(id, revision))) {
    // The revision in the name is the whole point: without it, publishing the
    // next revision would write over the one already referenced.
    return {
      ok: false,
      why: `'${path}' no lleva '${rule.prefix(id, revision)}' en el nombre, así que su revisión no está en el path`,
      expected,
    };
  }
  if (!rest.endsWith(rule.suffix)) {
    return { ok: false, why: `'${path}' no termina en '${rule.suffix}'`, expected };
  }
  const slug = rest.slice(
    rule.prefix(id, revision).length,
    rest.length - (rule.suffix?.length ?? 0),
  );
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return {
      ok: false,
      why: `'${slug}' no es un slug: solo minúsculas, números y guiones`,
      expected,
    };
  }
  return { ok: true };
}
