export interface ParsedDecision {
  id: string;
  title: string;
  preview: string | null;
  graduated: boolean;
  body?: string;
}

const DEC_HEADER_RE = /^##\s+(DEC-\d+)(?::\s*(.+))?$/gm;

export function parseDecisiones(text: string, includeFull = false): ParsedDecision[] {
  const headers: { id: string; title: string; start: number; bodyStart: number }[] = [];

  for (const m of text.matchAll(DEC_HEADER_RE)) {
    const id = m[1];
    if (!id) continue;
    const title = (m[2] ?? "").trim();
    const start = m.index ?? 0;
    headers.push({ id, title, start, bodyStart: start + m[0].length });
  }

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
