/**
 * The ASCII-only projection of text meant for a person (`--ascii`, `AW_ASCII=1`).
 *
 * It works per grapheme, not per code point, so a decomposed accent, an emoji
 * with its variation selector or a ZWJ sequence is one character to a person and
 * one replacement here. The glyphs the human output uses are mapped to their
 * closest ASCII reading; accents and compatibility forms are dropped by
 * decomposing (NFKD) and removing the combining marks; and whatever is left
 * outside ASCII becomes one `?`, so the result never carries a byte above 127.
 * It is applied to text already rendered for a person, never to JSON or to a
 * file the CLI writes: there a `—` is content, not output.
 */
const GLYPHS: ReadonlyMap<string, string> = new Map([
  ["·", "-"],
  ["—", "-"],
  ["–", "-"],
  ["«", '"'],
  ["»", '"'],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["✓", "OK"],
  ["❯", ">"],
  ["●", "*"],
  ["✔", "OK"],
  ["✗", "X"],
  ["✘", "X"],
  ["→", "->"],
  ["←", "<-"],
  ["↔", "<->"],
  ["⇒", "=>"],
  ["⊆", "<="],
  ["⊘", "(/)"],
  ["⏸", "||"],
  ["⏎", "Enter"],
  ["›", ">"],
  ["‹", "<"],
  ["×", "x"],
  ["≥", ">="],
  ["≤", "<="],
  ["≠", "!="],
  ["§", "S"],
  ["−", "-"],
  ["•", "*"],
  ["▸", ">"],
  ["⚠", "!"],
  ["¿", "?"],
  ["¡", "!"],
]);

/** Box drawing (U+2500–U+257F): lines become `-` and `|`, every joint `+`. */
function boxDrawing(char: string): string | undefined {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x2500 || code > 0x257f) return undefined;
  if ("─━┄┅┈┉╌╍═".includes(char)) return "-";
  if ("│┃┆┇┊┋╎╏║".includes(char)) return "|";
  return "+";
}

const COMBINING_MARKS = /\p{Mn}/gu;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isAscii(text: string): boolean {
  for (const char of text) if ((char.codePointAt(0) ?? 0x80) >= 0x80) return false;
  return true;
}

function asciiOf(grapheme: string): string {
  if (isAscii(grapheme)) return grapheme;
  const base = [...grapheme][0] ?? "";
  const mapped = GLYPHS.get(grapheme) ?? GLYPHS.get(base) ?? boxDrawing(base);
  if (mapped !== undefined) return mapped;
  const stripped = grapheme.normalize("NFKD").replace(COMBINING_MARKS, "");
  return stripped.length > 0 && isAscii(stripped) ? stripped : "?";
}

export function toAscii(text: string): string {
  let out = "";
  for (const { segment } of GRAPHEMES.segment(text)) out += asciiOf(segment);
  return out;
}
