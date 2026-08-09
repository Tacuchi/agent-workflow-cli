/**
 * The two shapes a DECISION.md is written in, read by one parser.
 *
 * `## DEC-001: título` is the older, numbered form. The chassis' own convention is
 * the other one — a decision announced in bold and tagged by the phase or task it
 * came from (`**Origin: T2 (F1) — …**`) with its reasoning underneath — and until
 * this parser learned it, every session written that way reported ZERO decisions
 * while its file was full of them. Two shapes, one reader: a second parser is how
 * the count and the narrative would end up disagreeing about the same file.
 *
 * A bold span has to be the WHOLE line to count. Bold used mid-paragraph for
 * emphasis is not a decision announcing itself, and treating it as one turns a
 * sentence fragment into a titled decision nobody made.
 */
export interface ParsedDecision {
  id: string;
  title: string;
  preview: string | null;
  graduated: boolean;
  body?: string;
}

const DEC_HEADER_RE = /^##\s+(DEC-\d+)(?::\s*(.+))?$/gm;

/** A decision announced in bold, alone on its line. */
const DEC_BOLD_RE = /^\*\*(.+?)\*\*[ \t]*$/gm;

export function parseDecisiones(text: string, includeFull = false): ParsedDecision[] {
  const headers: { id: string; title: string; start: number; bodyStart: number }[] = [];

  for (const m of text.matchAll(DEC_HEADER_RE)) {
    const id = m[1];
    if (!id) continue;
    const title = (m[2] ?? "").trim();
    const start = m.index ?? 0;
    headers.push({ id, title, start, bodyStart: start + m[0].length });
  }
  for (const m of text.matchAll(DEC_BOLD_RE)) {
    const title = (m[1] ?? "").trim();
    if (title.length === 0) continue;
    const start = m.index ?? 0;
    headers.push({ id: title, title, start, bodyStart: start + m[0].length });
  }
  // Both shapes can coexist in one file, so the bodies are cut in document order:
  // sorting after collecting is what keeps a body from running past the next
  // decision just because the other shape found it first.
  headers.sort((a, b) => a.start - b.start);

  // Each body runs from its own header's end to the next header's start.
  return headers.map((h, i) => {
    const body = text.slice(h.bodyStart, headers[i + 1]?.start ?? text.length).trim();
    const preview = firstNonEmpty(body);
    const graduated = preview?.startsWith("→ docs/") === true;
    const item: ParsedDecision = {
      id: h.id,
      title: h.title,
      preview,
      graduated,
    };
    if (includeFull) {
      item.body = body;
    }
    return item;
  });
}

function firstNonEmpty(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return null;
}
