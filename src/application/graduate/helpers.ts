import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";

export interface DecisionBlock {
  header: string;
  body: string;
  startIndex: number;
  endIndex: number;
}

export function extractDecisionBlock(text: string, decId: string): DecisionBlock | null {
  const headerRe = new RegExp(`^##\\s+${escapeRegex(decId)}[^\\n]*$`, "m");
  const m = text.match(headerRe);
  if (!m || m.index === undefined) return null;

  const headerStart = m.index;
  const headerLine = m[0];
  const headerEnd = headerStart + headerLine.length;
  const afterHeader = text.indexOf("\n", headerEnd);
  const bodyStart = afterHeader === -1 ? text.length : afterHeader + 1;
  let bodyEnd = text.length;
  const nextHeaderRe = /^##\s+/m;
  const slice = text.slice(bodyStart);
  const next = slice.match(nextHeaderRe);
  if (next?.index !== undefined) {
    bodyEnd = bodyStart + next.index;
  }
  return {
    header: headerLine.replace(/\s+$/, ""),
    body: text.slice(bodyStart, bodyEnd).replace(/\s+$/, ""),
    startIndex: headerStart,
    endIndex: bodyEnd,
  };
}

export async function nextNumberInDir(fs: FileSystemPort, dir: string): Promise<string> {
  if (!(await fs.exists(dir))) return "001";
  const entries = await fs.list(dir);
  const numbers: number[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const m = entry.name.match(/^(\d{3})-.*\.md$/);
    if (m?.[1]) numbers.push(Number.parseInt(m[1], 10));
  }
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return String(max + 1).padStart(3, "0");
}

export async function nextNumberInDirsByPrefix(fs: FileSystemPort, dir: string): Promise<string> {
  if (!(await fs.exists(dir))) return "001";
  const entries = await fs.list(dir);
  const numbers: number[] = [];
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    const m = entry.name.match(/^(\d{3})-/);
    if (m?.[1]) numbers.push(Number.parseInt(m[1], 10));
  }
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return String(max + 1).padStart(3, "0");
}

export async function copyTree(
  fs: FileSystemPort,
  srcDir: string,
  destDir: string,
): Promise<number> {
  if (!(await fs.exists(srcDir))) return 0;
  await fs.mkdirp(destDir);
  let count = 0;
  const entries = await fs.list(srcDir);
  for (const entry of entries) {
    const target = join(destDir, entry.name);
    if (entry.type === "dir") {
      count += await copyTree(fs, entry.path, target);
    } else if (entry.type === "file") {
      const content = await fs.readText(entry.path);
      await fs.writeText(target, content);
      count += 1;
    }
  }
  return count;
}

export function parseSessionCode(folder: string): string | null {
  const m = folder.match(/^session(\d{3})-/);
  return m?.[1] ?? null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
