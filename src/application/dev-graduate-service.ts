import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import { resolveSession } from "./session-resolver.js";

export interface GraduateInput {
  kind?: string;
  session?: string;
  decId?: string;
  slug?: string;
}

export interface GraduateDecisionOutput {
  kind: "decision";
  session: string;
  source: string;
  target: string;
  next_number: string;
  dec_id: string;
  slug: string;
}

export interface GraduatePlanOutput {
  kind: "plan";
  session: string;
  source: string;
  target: string;
  next_number: string;
  slug: string;
}

export interface GraduateError {
  error: string;
}

export type GraduateOutput = GraduateDecisionOutput | GraduatePlanOutput;
export type GraduateResult = GraduateOutput | GraduateError;

export async function runGraduate(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: GraduateInput,
): Promise<GraduateResult> {
  if (input.kind !== "decision" && input.kind !== "plan") {
    return { error: "--kind debe ser 'decision' o 'plan'" };
  }
  if (!input.session || !input.slug) {
    return { error: "--session y --slug son obligatorios" };
  }
  if (input.kind === "decision" && !input.decId) {
    return { error: "--id (DEC-NNN) obligatorio para --kind decision" };
  }

  const session = await resolveSession(fs, env, paths, input.session, true);
  if (!session) return { error: `Sesión no encontrada: ${input.session}` };
  const sessionPath = session.path;

  if (input.kind === "decision") {
    return graduateDecision(
      fs,
      env.cwd(),
      sessionPath,
      session.folder,
      input.decId ?? "",
      input.slug,
    );
  }
  return graduatePlan(fs, env.cwd(), sessionPath, session.folder, input.slug);
}

async function graduateDecision(
  fs: FileSystemPort,
  cwd: string,
  sessionPath: string,
  folder: string,
  decId: string,
  slug: string,
): Promise<GraduateResult> {
  const decFile = join(sessionPath, "DECISIONES.md");
  if (!(await fs.exists(decFile))) {
    return { error: "DECISIONES.md no existe en la sesión" };
  }
  const text = await fs.readText(decFile);
  // Mirror Python regex: (^##\s+{decId}[^\n]*\n)(.*?)(?=^##\s+|\Z) — JS no soporta \Z, line-by-line parser.
  const block = extractDecisionBlock(text, decId);
  if (!block) {
    return { error: `Bloque ${decId} no encontrado en DECISIONES.md` };
  }

  const destDir = join(cwd, "docs", "decisiones");
  await fs.mkdirp(destDir);
  const nnn = await nextNumberInDir(fs, destDir);
  const destFile = join(destDir, `${nnn}-${slug}.md`);
  await fs.writeText(destFile, `${block.header}\n\n${block.body}\n`);

  const pointer = `${block.header}\n→ docs/decisiones/${nnn}-${slug}.md\n\n`;
  const newText = text.slice(0, block.startIndex) + pointer + text.slice(block.endIndex);
  await fs.writeText(decFile, newText);

  return {
    kind: "decision",
    session: folder,
    source: decFile,
    target: destFile,
    next_number: nnn,
    dec_id: decId,
    slug,
  };
}

async function graduatePlan(
  fs: FileSystemPort,
  cwd: string,
  sessionPath: string,
  folder: string,
  slug: string,
): Promise<GraduateResult> {
  const tasksFile = join(sessionPath, "TASKS.md");
  if (!(await fs.exists(tasksFile))) {
    return { error: "TASKS.md no existe en la sesión" };
  }
  const content = await fs.readText(tasksFile);
  const destDir = join(cwd, "docs", "planes");
  await fs.mkdirp(destDir);
  const nnn = await nextNumberInDir(fs, destDir);
  const destFile = join(destDir, `${nnn}-${slug}.md`);
  await fs.writeText(destFile, content);

  const pointer = `# Tareas — ${folder}\n\n→ docs/planes/${nnn}-${slug}.md\n`;
  await fs.writeText(tasksFile, pointer);

  return {
    kind: "plan",
    session: folder,
    source: tasksFile,
    target: destFile,
    next_number: nnn,
    slug,
  };
}

interface DecisionBlock {
  header: string;
  body: string;
  startIndex: number;
  endIndex: number;
}

function extractDecisionBlock(text: string, decId: string): DecisionBlock | null {
  const headerRe = new RegExp(`^##\\s+${escapeRegex(decId)}[^\\n]*$`, "m");
  const m = text.match(headerRe);
  if (!m || m.index === undefined) return null;

  const headerStart = m.index;
  const headerLine = m[0];
  const headerEnd = headerStart + headerLine.length;
  // Body: after header newline until next `## ` or EOF.
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

async function nextNumberInDir(fs: FileSystemPort, dir: string): Promise<string> {
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
