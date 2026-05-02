export function parseMdValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*[-*]?\\s*\\*{0,2}${escaped}\\*{0,2}\\s*[:=]\\s*(.+)$`, "im");
  const match = text.match(re);
  if (!match || !match[1]) {
    return undefined;
  }
  const value = match[1].trim();
  return value.length > 0 ? value : undefined;
}

export function parseMdSection(text: string, heading: string): string | undefined {
  const target = heading.trim().toLowerCase();
  const lines = text.split("\n");
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;

  let captureFrom: number | null = null;
  let captureLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(headingRe);
    if (!match || !match[1] || !match[2]) continue;
    const level = match[1].length;
    const name = match[2].trim().toLowerCase();
    if (captureFrom === null) {
      if (name === target) {
        captureFrom = i + 1;
        captureLevel = level;
      }
    } else if (level <= captureLevel) {
      return joinTrim(lines.slice(captureFrom, i));
    }
  }

  if (captureFrom !== null) {
    return joinTrim(lines.slice(captureFrom));
  }
  return undefined;
}

export function firstNonEmptyLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return undefined;
}

function joinTrim(lines: string[]): string {
  return lines.join("\n").trim();
}
