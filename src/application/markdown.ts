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
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^#{1,6}\\s+${escaped}\\s*$([\\s\\S]*?)(?=^#{1,6}\\s|\\Z)`, "im");
  const match = text.match(re);
  if (!match || !match[1]) {
    return undefined;
  }
  return match[1].trim();
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
