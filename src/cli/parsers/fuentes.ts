export interface FuenteSpec {
  alias: string;
  path: string;
  mainBranch?: string;
}

export function parseFuentesSpecs(specs: string[]): { fuentes: FuenteSpec[] } | { error: string } {
  const out: FuenteSpec[] = [];
  for (const raw of specs) {
    const parsed = parseOneFuente(raw);
    if ("error" in parsed) return parsed;
    out.push(parsed);
  }
  return { fuentes: out };
}

function parseOneFuente(raw: string): FuenteSpec | { error: string } {
  const trimmed = raw.trim();
  const firstColon = trimmed.indexOf(":");
  if (firstColon <= 0) {
    return {
      error: `--fuente formato inválido '${raw}': se esperaba 'alias:path[:rama-principal]'`,
    };
  }
  const alias = trimmed.slice(0, firstColon).trim();
  const rest = trimmed.slice(firstColon + 1);
  // A Windows drive path must keep a separator after the colon (`C:\` or `C:/`).
  // A drive letter glued to the path (`C:Source…`) means the backslashes were
  // lost — commonly the shell ate them when this was passed as an arg. Reject it
  // rather than store a corrupted path (which later wipes multiroot visibility).
  if (/^[A-Za-z]:[^\\/]/.test(rest)) {
    return {
      error: `--fuente path corrupto '${raw}': la unidad '${rest.slice(0, 2)}' no tiene separador tras el colon (backslashes perdidos, probablemente por el shell). En Windows pasá forward-slash: ${alias}:C:/Source/...`,
    };
  }
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
    return { error: `--fuente formato inválido '${raw}': alias y path son obligatorios` };
  }
  const entry: FuenteSpec = { alias, path };
  if (rama !== undefined) entry.mainBranch = rama;
  return entry;
}
