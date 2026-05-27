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
  // Tag de clasificación (no es un link a doc): se preserva como literal `kind:<val>`.
  // Consumido por readPatchCodesFromHistory para colapsar /patch (kind:patch) en exports.
  kind: (val) => `kind:${val}`,
};

export interface OrigenLookup {
  /**
   * Returns the session folder name for `<flow>-<code>` if it exists in the
   * sessions directory, or undefined when no match. The renderer falls back
   * to a plain `origen:<flow>-<code>` string in the latter case.
   */
  resolveFolder(flow: string, code: string): string | undefined;
}

export function renderRefs(refsRaw: string | undefined | null, lookup?: OrigenLookup): string {
  if (!refsRaw) return "—";
  const parts: string[] = [];
  for (const itemRaw of refsRaw.split(",")) {
    const item = itemRaw.trim();
    if (!item || !item.includes(":")) continue;
    const colon = item.indexOf(":");
    const kind = item.slice(0, colon).trim().toLowerCase();
    const val = item.slice(colon + 1).trim();
    const rendered = renderItem(kind, val, lookup);
    if (rendered !== null) {
      parts.push(rendered);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "—";
}

function renderItem(kind: string, val: string, lookup?: OrigenLookup): string | null {
  if (kind === "origen") return renderOrigen(val, lookup);
  const builtin = BUILTIN_RENDERERS[kind];
  if (builtin) return builtin(val);
  return `[${kind.toUpperCase()}](${val})`;
}

function renderOrigen(val: string, lookup?: OrigenLookup): string {
  const m = val.match(/^(dev|design|analyze)-(\d{3})$/);
  if (!m || !m[1] || !m[2]) return `origen:${val}`;
  const flow = m[1];
  const code = m[2];
  const folder = lookup?.resolveFolder(flow, code);
  if (folder) {
    return `[origen:${flow}-${code}](sessions/${folder}/)`;
  }
  return `origen:${flow}-${code}`;
}
