/**
 * Parser for SKILL.md YAML frontmatter, aligned with the Agent Skills standard
 * (agentskills.io/specification).
 *
 * Handles what our skills actually use and what the standard defines:
 * - plain scalars (`name: foo`), optionally quoted
 * - block scalars (`description: >-`, `>`, `|`, with `-`/`+` chomping) — the common
 *   authoring form for long descriptions; a naive `^(\w+):\s*(.+)$` regex would
 *   capture the `>-` indicator as the value instead of the folded text
 * - hyphenated keys (`allowed-tools`)
 * - a one-level nested `metadata:` mapping (home of the optional `version`)
 *
 * Deliberately a focused parser over the closed set of frontmatter we author, not a
 * general YAML engine — no runtime YAML dependency is added to the CLI.
 */

const DELIMITER = "---";
const TOP_KEY = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const NESTED_KEY = /^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/;
const BLOCK_SCALAR = /^([|>])([+-]?)\s*$/;

export interface ParsedFrontmatter {
  /** Top-level scalar fields (block scalars folded), e.g. name, description, license, allowed-tools. */
  fields: Record<string, string>;
  /** The nested `metadata:` mapping, e.g. author, version. */
  metadata: Record<string, string>;
}

/** Parse SKILL.md frontmatter. Returns null when there is no closed `---` block. */
export function parseSkillFrontmatter(text: string): ParsedFrontmatter | null {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== DELIMITER) return null;
  const end = findClosingDelimiter(lines);
  if (end === -1) return null;

  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let i = 1;
  while (i < end) {
    i = consumeEntry(lines, i, end, fields, metadata);
  }
  return { fields, metadata };
}

function findClosingDelimiter(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === DELIMITER) return i;
  }
  return -1;
}

/** Consume one top-level entry starting at `i`; returns the next line index to process. */
function consumeEntry(
  lines: string[],
  i: number,
  end: number,
  fields: Record<string, string>,
  metadata: Record<string, string>,
): number {
  const line = lines[i] ?? "";
  if (line.trim() === "") return i + 1;
  const m = line.match(TOP_KEY);
  if (!m?.[1]) return i + 1;
  const key = m[1];
  const rest = (m[2] ?? "").trim();

  if (key === "metadata" && rest === "") {
    return readNestedMapping(lines, i + 1, end, metadata);
  }
  const block = rest.match(BLOCK_SCALAR);
  if (block?.[1]) {
    const parsed = readBlockScalar(lines, i + 1, end, block[1]);
    fields[key] = parsed.value;
    return parsed.nextIndex;
  }
  fields[key] = stripQuotes(rest);
  return i + 1;
}

/** Version per the standard lives under metadata.version; fall back to a legacy top-level version. */
export function getSkillVersion(fm: ParsedFrontmatter): string | null {
  return fm.metadata.version ?? fm.fields.version ?? null;
}

/** Read an indented `key: value` mapping until the first dedented line. Returns the next line index. */
function readNestedMapping(
  lines: string[],
  start: number,
  end: number,
  out: Record<string, string>,
): number {
  let i = start;
  for (; i < end; i++) {
    const sub = lines[i] ?? "";
    if (sub.trim() === "") continue;
    const m = sub.match(NESTED_KEY);
    if (!m?.[2]) break;
    out[m[2]] = stripQuotes((m[3] ?? "").trim());
  }
  return i;
}

/** Read a block scalar body (lines more indented than the key). Returns the folded/literal value. */
function readBlockScalar(
  lines: string[],
  start: number,
  end: number,
  style: string,
): { value: string; nextIndex: number } {
  const { raw, nextIndex } = collectBlockLines(lines, start, end);
  const stripped = dedent(raw);
  const value = style === "|" ? stripped.join("\n") : foldLines(stripped);
  return { value, nextIndex };
}

/** Gather lines belonging to the block (indented or blank) until the first dedented line. */
function collectBlockLines(
  lines: string[],
  start: number,
  end: number,
): { raw: string[]; nextIndex: number } {
  const raw: string[] = [];
  let i = start;
  for (; i < end; i++) {
    const l = lines[i] ?? "";
    if (l.trim() === "" || /^\s/.test(l)) {
      raw.push(l.trim() === "" ? "" : l);
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return { raw, nextIndex: i };
}

/** Strip the common leading indentation from non-empty lines. */
function dedent(raw: string[]): string[] {
  const indents = raw.filter((l) => l !== "").map((l) => (l.match(/^(\s*)/)?.[1] ?? "").length);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return raw.map((l) => (l === "" ? "" : l.slice(minIndent)));
}

/** Folded (">") style: join consecutive non-empty lines with spaces; a blank line is a break. */
function foldLines(stripped: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const l of stripped) {
    if (l === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(l);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1);
  }
  return s;
}
