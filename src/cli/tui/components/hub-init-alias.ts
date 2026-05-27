// Inferencia de alias para el form de hub-init. Cross-platform a propósito:
// parte en `/` y `\` sin depender de `path.basename` (que en POSIX no separa por
// `\`, así que rompería con rutas Windows escritas en una máquina posix y en los
// tests). El alias es el nombre de la carpeta tal cual (sin transformar).

/** Alias de una fuente = nombre de su carpeta (último segmento del path). */
export function deriveAlias(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segment = trimmed.split(/[/\\]/).pop() ?? "";
  return segment || trimmed || path;
}

/** Sufija -2, -3, … si dos fuentes comparten nombre de carpeta. No muta `seen`. */
export function dedupeAlias(alias: string, seen: Set<string>): string {
  let candidate = alias;
  let n = 2;
  while (seen.has(candidate)) candidate = `${alias}-${n++}`;
  return candidate;
}
