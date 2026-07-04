const BUILTIN_RENDERERS: Record<string, (val: string) => string> = {
  dec: (val) => `[DEC](../docs/decisiones/${val}.md)`,
  decision: (val) => `[DEC](../docs/decisiones/${val}.md)`,
  plan: (val) => `[PLAN](../docs/planes/${val}.md)`,
  sql: (val) => `[SQL](../docs/scripts/${val}/)`,
  script: (val) => `[SQL](../docs/scripts/${val}/)`,
  scripts: (val) => `[SQL](../docs/scripts/${val}/)`,
  conclusion: (val) => `[CONCLUSION](../docs/conclusiones/${val}.md)`,
  conclusions: (val) => `[CONCLUSION](../docs/conclusiones/${val}.md)`,
  manual: (val) => `[MANUAL](../docs/manuales/${val}.md)`,
  manuales: (val) => `[MANUAL](../docs/manuales/${val}.md)`,
  especificacion: (val) => `[ESPECIFICACION](../docs/especificaciones/${val}/)`,
  especificaciones: (val) => `[ESPECIFICACION](../docs/especificaciones/${val}/)`,
  release: (val) => `[RELEASE](../docs/release/${val}.md)`,
};

export function renderRefs(refsRaw: string | undefined | null): string {
  if (!refsRaw) return "—";
  const parts: string[] = [];
  for (const itemRaw of refsRaw.split(",")) {
    const item = itemRaw.trim();
    if (!item) continue;
    if (!item.includes(":") || /^[a-z][a-z0-9+.-]*:\/\//i.test(item)) {
      // Free-form ref (no kind) or a URL — keep it as plain text instead of
      // mangling it through the kind:val split ("https://x" ≠ kind "https").
      parts.push(item);
      continue;
    }
    const colon = item.indexOf(":");
    const kind = item.slice(0, colon).trim().toLowerCase();
    const val = item.slice(colon + 1).trim();
    const rendered = renderItem(kind, val);
    if (rendered !== null) {
      parts.push(rendered);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "—";
}

function renderItem(kind: string, val: string): string | null {
  const builtin = BUILTIN_RENDERERS[kind];
  if (builtin) return builtin(val);
  return `[${kind.toUpperCase()}](${val})`;
}
