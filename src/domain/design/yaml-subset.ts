/**
 * The restricted YAML subset the design artifacts are authored in.
 *
 * Flow and Screen Specifications carry structure a flat frontmatter parser
 * cannot express — sequences of mappings (`nodes`, `edges`, `states`, `trace`),
 * nested mappings (`dependencies`, `not_applicable`) and flow style (`[]`,
 * `{}`) — and no YAML engine may be added to the CLI. So this is a parser for a
 * closed, documented subset, not a general one.
 *
 * The subset is deliberately small and everything outside it is REJECTED with a
 * line number, never guessed at:
 *
 *   accepted                          rejected
 *   ────────────────────────────      ─────────────────────────────
 *   key: value                        &anchor / *alias
 *   key:  (nested block below)        !tag
 *   - item        (block sequence)    | and > (block scalars)
 *   - key: value  (seq of mappings)   <<: (merge keys)
 *   [a, b] / []   (flow sequence)     ? (complex keys)
 *   {a: b} / {}   (flow mapping)      --- / ... (multi-document)
 *   "…" / '…' / plain scalars         tabs in the indentation
 *   null / ~ / true / false / 12
 *
 * A rejection is a better outcome than a silent misread: the author gets told
 * which line and which form to use instead.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export type YamlParse =
  | { ok: true; value: Record<string, YamlValue> }
  | { ok: false; line: number; why: string };

interface Line {
  /** 1-based, for the diagnostic. */
  n: number;
  indent: number;
  text: string;
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;
/** Canonical decimal only. `007`, `+2`, `1_000` and `0x10` stay strings, so a
 *  field that wanted a number fails loudly instead of being coerced in silence. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const INTEGER = /^-?(0|[1-9]\d*)$/;

class Rejected extends Error {
  constructor(
    readonly line: number,
    readonly why: string,
  ) {
    super(why);
  }
}

/** Guards against pathological input: a recursive parser must diagnose, not crash. */
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 1500;
const MAX_DEPTH = 8;

export function parseYamlSubset(source: string): YamlParse {
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES) {
    return { ok: false, line: 1, why: `el frontmatter supera ${MAX_BYTES} bytes` };
  }
  let lines: Line[];
  try {
    lines = scan(source);
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, line: err.line, why: err.why };
    throw err;
  }
  if (lines.length > MAX_LINES) {
    return { ok: false, line: MAX_LINES, why: `el frontmatter supera ${MAX_LINES} líneas` };
  }
  if (lines.length === 0) return { ok: true, value: {} };

  try {
    const first = lines[0] as Line;
    if (first.indent !== 0) {
      throw new Rejected(first.n, "el documento arranca indentado");
    }
    const [value, next] = parseMapping(lines, 0, 0);
    if (next < lines.length) {
      throw new Rejected(
        (lines[next] as Line).n,
        "indentación inesperada: la clave no cierra su bloque",
      );
    }
    return { ok: true, value };
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, line: err.line, why: err.why };
    throw err;
  }
}

/** Drop blanks and comments, measure indentation, and reject what the subset excludes. */
function scan(source: string): Line[] {
  const out: Line[] = [];
  // Editors add a BOM without asking. It changes no value, so it is stripped
  // rather than rejected — punishing an author for their editor helps nobody.
  const raw = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] as string;
    const n = i + 1;
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    if (line.includes("\t")) throw new Rejected(n, "usa tabulaciones; indentá con espacios");
    // An invisible C0 character inside a normative field is bytes that look like
    // one value and are another. The contract exists to remove that class of
    // ambiguity, so it is a rejection, not a silent pass-through.
    if (CONTROL_CHAR.test(line)) {
      throw new Rejected(n, "contiene un carácter de control invisible");
    }

    const text = stripComment(line).trimEnd();
    if (text.trim().length === 0) continue;

    const indent = text.length - text.trimStart().length;
    const body = text.trimStart();
    rejectUnsupported(body, n);
    out.push({ n, indent, text: body });
  }
  return out;
}

/**
 * A `#` only opens a comment at the start or after whitespace, and never inside
 * quotes. `entry: DES-001/SCR-001@r2#default` has to survive intact — the state
 * anchor is the single most referenced form in the whole contract.
 */
function stripComment(raw: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    // A quote only OPENS a string where a scalar could start. Otherwise `it's a
    // form  # nota` would look quoted from the apostrophe on, and the comment
    // would survive into the value.
    const opens = i === 0 || /[\s:,[{-]/.test(raw[i - 1] as string);
    if (c === "'" && !double && (single || opens)) single = !single;
    else if (c === '"' && !single && (double || opens)) double = !double;
    else if (c === "#" && !single && !double && (i === 0 || /\s/.test(raw[i - 1] as string))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function rejectUnsupported(body: string, n: number): void {
  if (body === "---" || body === "...") {
    throw new Rejected(
      n,
      "el frontmatter es un único documento: no admite '---' ni '...' internos",
    );
  }
  if (body.startsWith("? ")) throw new Rejected(n, "no admite claves complejas ('? ')");
  if (body.startsWith("<<:")) throw new Rejected(n, "no admite merge keys ('<<:')");

  const value = KEY.exec(body)?.[2] ?? (body.startsWith("- ") ? body.slice(2).trim() : null);
  if (value === null || value.length === 0) return;
  if (value === "|" || value === ">" || /^[|>][+-]?$/.test(value)) {
    throw new Rejected(
      n,
      "no admite block scalars ('|', '>'): escribí el texto en una línea o en el cuerpo",
    );
  }
  if (value.startsWith("&")) throw new Rejected(n, "no admite anclas YAML ('&')");
  if (value.startsWith("*")) throw new Rejected(n, "no admite alias YAML ('*')");
  if (value.startsWith("!")) throw new Rejected(n, "no admite tags YAML ('!')");
}

/** Parse consecutive `key: …` lines at `indent`. Returns the mapping and the next index. */
function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): [Record<string, YamlValue>, number] {
  // Null prototype on purpose: with a plain object a key called `__proto__`
  // would REWRITE the prototype instead of becoming a property, and
  // `constructor`/`toString` would read as duplicates of something nobody wrote.
  const out: Record<string, YamlValue> = Object.create(null);
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new Rejected(line.n, "indentación inesperada dentro de un mapping");
    }
    const match = KEY.exec(line.text);
    if (match === null) {
      throw new Rejected(line.n, `se esperaba 'clave: valor' y llegó '${line.text}'`);
    }
    const key = match[1] as string;
    if (key in out) throw new Rejected(line.n, `la clave '${key}' está repetida`);

    const inline = (match[2] ?? "").trim();
    if (inline.length > 0) {
      out[key] = parseScalarOrFlow(inline, line.n);
      i += 1;
      continue;
    }
    if (indent > MAX_DEPTH * 2) {
      throw new Rejected(line.n, `anidamiento mayor a ${MAX_DEPTH} niveles`);
    }
    const [value, next] = parseNested(lines, i + 1, indent);
    out[key] = value;
    i = next;
  }
  return [out, i];
}

/** The block that belongs to a `key:` with no inline value. */
function parseNested(lines: Line[], start: number, parentIndent: number): [YamlValue, number] {
  const next = lines[start];
  // A key with nothing under it is an explicit null, not an error: `unknowns:`
  // and `unknowns: []` have to mean the same thing to an author.
  if (next === undefined || next.indent < parentIndent) return [null, start];

  // YAML lets a sequence sit at its parent key's own indentation.
  if (next.text.startsWith("- ") || next.text === "-") {
    return parseSequence(lines, start, next.indent);
  }
  // A sibling key at the same indentation means the value was simply empty.
  if (next.indent === parentIndent) return [null, start];
  return parseMapping(lines, start, next.indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent < indent) break;
    // A sequence may sit at its own key's indentation, so the next sibling key
    // arrives at exactly this column. That ENDS the sequence — it is not an
    // error. Anything else at this column is.
    if (!isSequenceItem(line)) {
      if (line.indent === indent && KEY.test(line.text)) break;
      throw new Rejected(line.n, "se esperaba un ítem de secuencia ('- …')");
    }
    if (line.indent > indent) {
      throw new Rejected(line.n, "se esperaba un ítem de secuencia ('- …')");
    }
    if (line.text === "-") {
      throw new Rejected(line.n, "ítem de secuencia vacío: escribí el valor en la misma línea");
    }

    const content = line.text.slice(2).trimStart();
    const offset = line.indent + line.text.length - content.length;
    if (KEY.exec(content) === null) {
      out.push(parseScalarOrFlow(content, line.n));
      i += 1;
      continue;
    }
    // `- id: x` starts a mapping whose indentation is where `id` begins. Rewriting
    // the dash as spaces makes it an ordinary mapping block, which is exactly
    // what it is — and keeps one code path for `- k: v` and its continuation lines.
    const rewritten: Line[] = [...lines];
    rewritten[i] = { n: line.n, indent: offset, text: content };
    const [value, next] = parseMapping(rewritten, i, offset);
    out.push(value);
    i = next;
  }
  return [out, i];
}

function isSequenceItem(line: Line): boolean {
  return line.text.startsWith("- ") || line.text === "-";
}

function parseScalarOrFlow(raw: string, n: number): YamlValue {
  const text = raw.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    const [value, rest] = parseFlow(text, n, 0);
    if (rest.trim().length > 0) {
      throw new Rejected(n, `sobra contenido después del valor: '${rest.trim()}'`);
    }
    return value;
  }
  return parseScalar(text, n);
}

/** Flow style — returns the value plus whatever is left of the string. */
function parseFlow(text: string, n: number, depth: number): [YamlValue, string] {
  if (depth > MAX_DEPTH) {
    throw new Rejected(n, `anidamiento mayor a ${MAX_DEPTH} niveles`);
  }
  if (text.startsWith("[")) return parseFlowSeq(text.slice(1), n, depth + 1);
  if (text.startsWith("{")) return parseFlowMap(text.slice(1), n, depth + 1);
  const [token, rest] = takeFlowToken(text, n);
  return [parseScalar(token, n), rest];
}

function parseFlowSeq(input: string, n: number, depth: number): [YamlValue[], string] {
  const out: YamlValue[] = [];
  let rest = input.trimStart();
  if (rest.startsWith("]")) return [out, rest.slice(1)];
  for (;;) {
    // `[a, ]` and `[,]` used to yield a null nobody wrote. An empty slot is a
    // typo, and the diagnostic belongs here — not three layers up as a type error.
    if (rest.startsWith(",") || rest.startsWith("]")) {
      throw new Rejected(n, "ítem vacío en una secuencia de flow style");
    }
    const [value, after] = parseFlow(rest.trimStart(), n, depth);
    out.push(value);
    rest = after.trimStart();
    if (rest.startsWith(",")) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    if (rest.startsWith("]")) return [out, rest.slice(1)];
    throw new Rejected(n, "secuencia en flow style sin cerrar: falta ',' o ']'");
  }
}

function parseFlowMap(
  input: string,
  n: number,
  depth: number,
): [Record<string, YamlValue>, string] {
  const out: Record<string, YamlValue> = Object.create(null);
  let rest = input.trimStart();
  if (rest.startsWith("}")) return [out, rest.slice(1)];
  for (;;) {
    const colon = findFlowColon(rest, n);
    const key = parseScalar(rest.slice(0, colon).trim(), n);
    if (typeof key !== "string" || key.length === 0) {
      throw new Rejected(n, "clave de mapping en flow style vacía o no textual");
    }
    if (key in out) throw new Rejected(n, `la clave '${key}' está repetida`);
    const [value, after] = parseFlow(rest.slice(colon + 1).trimStart(), n, depth);
    out[key] = value;
    rest = after.trimStart();
    if (rest.startsWith(",")) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    if (rest.startsWith("}")) return [out, rest.slice(1)];
    throw new Rejected(n, "mapping en flow style sin cerrar: falta ',' o '}'");
  }
}

function findFlowColon(text: string, n: number): number {
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === ":" && !single && !double) return i;
  }
  throw new Rejected(n, "mapping en flow style sin ':' entre clave y valor");
}

/** A scalar inside flow style ends at the first unquoted `,`, `]` or `}`. */
function takeFlowToken(text: string, n: number): [string, string] {
  if (text.startsWith('"') || text.startsWith("'")) return takeQuoted(text, n);
  const end = text.search(/[,\]}]/);
  if (end === -1) return [text, ""];
  return [text.slice(0, end), text.slice(end)];
}

/** A quoted scalar ends at its closing quote — `\"` and `''` do not close it. */
function takeQuoted(text: string, n: number): [string, string] {
  const quote = text[0] as string;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\" && quote === '"') {
      i += 1;
      continue;
    }
    if (text[i] !== quote) continue;
    if (quote === "'" && text[i + 1] === "'") {
      i += 1;
      continue;
    }
    return [text.slice(0, i + 1), text.slice(i + 1)];
  }
  throw new Rejected(n, "comilla sin cerrar");
}

function parseScalar(text: string, n: number): YamlValue {
  if (text.length === 0 || text === "null" || text === "~") return null;
  // The single place every scalar passes through, so the node-level YAML
  // constructs are rejected HERE — a line-level check missed them inside
  // sequence items and flow style, where they read as ordinary text.
  const marker = { "&": "anclas YAML ('&')", "*": "alias YAML ('*')", "!": "tags YAML ('!')" }[
    text[0] as string
  ];
  if (marker !== undefined) throw new Rejected(n, `no admite ${marker}`);
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Rejected(n, "comilla doble sin cerrar");
    return text.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Rejected(n, "comilla simple sin cerrar");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (INTEGER.test(text)) return Number(text);
  return text;
}
