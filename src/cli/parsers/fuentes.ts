export interface FuenteSpec {
  alias: string;
  path: string;
  mainBranch?: string;
}

export function parseFuentesSpecs(specs: string[]): { fuentes: FuenteSpec[] } | { error: string } {
  const out: FuenteSpec[] = [];
  for (const raw of specs) {
    const trimmed = raw.trim();
    const firstColon = trimmed.indexOf(":");
    if (firstColon <= 0) {
      return {
        error: `--fuente formato inválido '${raw}': se esperaba 'alias:path[:rama-principal]'`,
      };
    }
    const alias = trimmed.slice(0, firstColon).trim();
    const rest = trimmed.slice(firstColon + 1);
    // En Windows el path arranca con un prefijo de unidad (`C:\`, `\\?\C:\`). Ese
    // colon de unidad NO es el separador de rama: hay que ignorarlo al buscar el
    // colon que parte `path:rama`, si no `C:\Source\foo` colapsa a path="C".
    const driveMatch = rest.match(/^(?:\\\\\?\\)?[A-Za-z]:[\\/]/);
    const driveColon = driveMatch ? driveMatch[0].indexOf(":") : -1;
    const lastColon = rest.lastIndexOf(":");
    let path: string;
    let rama: string | undefined;
    if (lastColon < 0 || lastColon === driveColon) {
      path = rest.trim();
    } else {
      path = rest.slice(0, lastColon).trim();
      const ramaCandidate = rest.slice(lastColon + 1).trim();
      if (ramaCandidate.length > 0) rama = ramaCandidate;
    }
    if (!alias || !path) {
      return {
        error: `--fuente formato inválido '${raw}': alias y path son obligatorios`,
      };
    }
    const entry: FuenteSpec = { alias, path };
    if (rama !== undefined) entry.mainBranch = rama;
    out.push(entry);
  }
  return { fuentes: out };
}
