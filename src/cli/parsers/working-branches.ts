export function parseWorkingBranches(specs: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of specs) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const alias = raw.slice(0, idx).trim();
    const branch = raw.slice(idx + 1).trim();
    if (alias && branch) out[alias] = branch;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
