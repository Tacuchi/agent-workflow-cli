/**
 * Reader of the `### Contrato` sections of `CHANGELOG.md`: what each version
 * declares about the contracts it changes, and which versions a jump crosses.
 */

export const CONTRACT_SECTION_HEADING = "### Contrato";
/** The last version cut before the convention: every later one must declare its section. */
export const CONTRACT_CONVENTION_AFTER = "25.6.1";
export const CONTRACT_NONE_LINE = "Ninguno.";
export const CONTRACT_LABELS = {
  stops: "**Deja de valer:**",
  replacedBy: "**Lo reemplaza:**",
  action: "**Qué hacer:**",
} as const;

export interface ContractChange {
  readonly stops: string;
  readonly replacedBy: string;
  readonly action: string;
}

/**
 * `undeclared` and `malformed` are kept apart from `none` on purpose: a version
 * that forgot its section, or wrote it wrong, says nothing about its contracts,
 * and reading it as "no changes" is the one answer that would be a lie.
 */
export type ContractDeclaration =
  | { readonly kind: "changes"; readonly changes: readonly ContractChange[] }
  | { readonly kind: "none" }
  | { readonly kind: "undeclared" }
  | { readonly kind: "malformed"; readonly problem: string };

export interface ChangelogEntry {
  readonly version: string;
  readonly contract: ContractDeclaration;
}

export type ContractRange =
  | { readonly kind: "range"; readonly entries: readonly ChangelogEntry[] }
  | {
      readonly kind: "unknown-version";
      readonly role: "installed" | "target";
      readonly value: string;
    };

type Version = readonly [number, number, number];

const ENTRY_HEADING = /^## \[(\d+\.\d+\.\d+)\]/;
const SUBSECTION_HEADING = /^### /;
const BULLET = /^- /;
const CONTINUATION = /^\s+\S/;

export function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Every `## [X.Y.Z]` entry of the changelog with its contract declaration. */
export function parseChangelogContracts(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let version: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (version !== null) entries.push({ version, contract: readDeclaration(body) });
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      flush();
      version = ENTRY_HEADING.exec(line)?.[1] ?? null;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return entries;
}

/**
 * The entries a jump from `installed` to `target` crosses: installed excluded,
 * target included, in ascending order. A target the changelog does not list is
 * reported as undeclared rather than dropped.
 */
export function contractsBetween(
  entries: readonly ChangelogEntry[],
  installed: string,
  target: string,
): ContractRange {
  const from = parseVersion(installed);
  if (from === null) return { kind: "unknown-version", role: "installed", value: installed };
  const to = parseVersion(target);
  if (to === null) return { kind: "unknown-version", role: "target", value: target };
  if (compareVersions(to, from) <= 0) return { kind: "range", entries: [] };

  const inRange = entries.filter((entry) => {
    const v = parseVersion(entry.version);
    return v !== null && compareVersions(v, from) > 0 && compareVersions(v, to) <= 0;
  });
  const hasTarget = inRange.some((entry) => entry.version === target);
  const withTarget = hasTarget
    ? inRange
    : [...inRange, { version: target, contract: { kind: "undeclared" } as const }];
  return { kind: "range", entries: sortAscending(withTarget) };
}

/**
 * Why the changelog cannot ship `version`: its entry, when the version is newer
 * than the last one cut before the convention, has no readable contract
 * section; and any section present, in any entry, breaks the form.
 */
export function contractGuardProblems(text: string, version: string): string[] {
  const entries = parseChangelogContracts(text);
  const problems = entries.flatMap((entry) =>
    entry.contract.kind === "malformed" ? [`${entry.version}: ${entry.contract.problem}`] : [],
  );
  const current = parseVersion(version);
  const floor = parseVersion(CONTRACT_CONVENTION_AFTER);
  if (current === null || floor === null) return [...problems, `versión ilegible: ${version}`];
  if (compareVersions(current, floor) <= 0) return problems;

  const entry = entries.find((candidate) => candidate.version === version);
  if (entry === undefined) return [...problems, `${version}: el changelog no tiene su entrada`];
  if (entry.contract.kind === "undeclared") {
    return [...problems, `${version}: la entrada no declara ${CONTRACT_SECTION_HEADING}`];
  }
  return problems;
}

function sortAscending(entries: readonly ChangelogEntry[]): ChangelogEntry[] {
  return [...entries].sort((a, b) => {
    const va = parseVersion(a.version);
    const vb = parseVersion(b.version);
    return va !== null && vb !== null ? compareVersions(va, vb) : 0;
  });
}

function readDeclaration(body: readonly string[]): ContractDeclaration {
  const starts = body.flatMap((line, i) => (line.trim() === CONTRACT_SECTION_HEADING ? [i] : []));
  if (starts.length === 0) return { kind: "undeclared" };
  if (starts.length > 1) {
    return { kind: "malformed", problem: `la entrada trae ${starts.length} secciones de contrato` };
  }
  const start = (starts[0] ?? 0) + 1;
  const rest = body.slice(start);
  const end = rest.findIndex((line) => SUBSECTION_HEADING.test(line));
  const lines = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== "");
  return readSection(lines);
}

function readSection(lines: readonly string[]): ContractDeclaration {
  if (lines.length === 0) return { kind: "malformed", problem: "la sección está vacía" };
  if (lines.length === 1 && lines[0]?.trim() === CONTRACT_NONE_LINE) return { kind: "none" };

  const bullets: string[] = [];
  for (const line of lines) {
    if (BULLET.test(line)) {
      bullets.push(line.slice(2).trim());
    } else if (CONTINUATION.test(line) && bullets.length > 0) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line.trim()}`;
    } else {
      return {
        kind: "malformed",
        problem: `línea fuera de la forma de la sección: «${line.trim()}»`,
      };
    }
  }

  const changes: ContractChange[] = [];
  for (const [index, bullet] of bullets.entries()) {
    const change = readChange(bullet);
    if (typeof change === "string") {
      return { kind: "malformed", problem: `cambio ${index + 1}: ${change}` };
    }
    changes.push(change);
  }
  return { kind: "changes", changes };
}

/** The three labeled parts of one bullet, in order, or the reason it has none. */
function readChange(bullet: string): ContractChange | string {
  const { stops, replacedBy, action } = CONTRACT_LABELS;
  const at = [stops, replacedBy, action].map((label) => bullet.indexOf(label));
  const [iStops, iReplaced, iAction] = at as [number, number, number];
  if (iStops !== 0) return `no empieza con ${stops}`;
  if (iReplaced === -1) return `le falta ${replacedBy}`;
  if (iAction === -1) return `le falta ${action}`;
  if (!(iStops < iReplaced && iReplaced < iAction)) return "las tres partes no van en orden";

  const parts = {
    stops: bullet.slice(stops.length, iReplaced).trim(),
    replacedBy: bullet.slice(iReplaced + replacedBy.length, iAction).trim(),
    action: bullet.slice(iAction + action.length).trim(),
  };
  const empty = (Object.keys(parts) as (keyof typeof parts)[]).find((key) => parts[key] === "");
  if (empty !== undefined) return `${CONTRACT_LABELS[empty]} está vacío`;
  return parts;
}
