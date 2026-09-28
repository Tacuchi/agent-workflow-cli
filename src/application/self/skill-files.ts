import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Copy the owned bundle without following links into files outside its source. */
export async function copyDir(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    const source = join(src, entry.name);
    const target = join(dest, entry.name);
    if (entry.isDirectory()) count += await copyDir(source, target);
    else {
      await copyFile(source, target);
      count += 1;
    }
  }
  return count;
}

export function hasValidFrontmatter(content: string): boolean {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  const block = match[1] ?? "";
  return /^name:\s*\S/m.test(block) && /^description:\s*\S/m.test(block);
}
