import { basename, join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { findArtifact } from "../session-artifacts.js";
import {
  copyTree,
  extractDecisionBlock,
  nextNumberInDir,
  nextNumberInDirsByPrefix,
  parseSessionCode,
} from "./helpers.js";

export interface GraduateDecisionOutput {
  kind: "decision";
  session: string;
  source: string;
  target: string;
  next_number: string;
  dec_id: string;
  slug: string;
}

export interface GraduateManualOutput {
  kind: "manual";
  session: string;
  source: string;
  target: string;
  next_number: string;
  slug: string;
}

export interface GraduateScriptOutput {
  kind: "script";
  session: string;
  source: string;
  target: string;
  next_number: string;
  slug: string;
  files_copied: number;
}

export interface GraduateEspecificacionOutput {
  kind: "especificacion";
  session: string;
  source: string;
  target: string;
  next_number: string;
  slug: string;
}

export interface GraduateConclusionOutput {
  kind: "conclusion";
  session: string;
  source: string;
  target: string;
  next_number: string;
  slug: string;
}

export interface GraduateError {
  error: string;
}

export type GraduateOutput =
  | GraduateDecisionOutput
  | GraduateManualOutput
  | GraduateScriptOutput
  | GraduateEspecificacionOutput
  | GraduateConclusionOutput;
export type GraduateResult = GraduateOutput | GraduateError;

export interface GraduateContext {
  fs: FileSystemPort;
  workspaceRoot: string;
  sessionPath: string;
  folder: string;
  slug: string;
}

export async function graduateDecision(
  ctx: GraduateContext,
  decId: string | undefined,
): Promise<GraduateResult> {
  if (!decId) return { error: "--id (DEC-NNN) obligatorio para --kind decision" };
  const decFile = await findArtifact(ctx.sessionPath, "decisions", ctx.fs);
  if (!decFile) {
    return { error: "DECISIONES.md no existe en la sesión" };
  }
  const text = await ctx.fs.readText(decFile);
  const block = extractDecisionBlock(text, decId);
  if (!block) {
    return { error: `Bloque ${decId} no encontrado en DECISIONES.md` };
  }

  const destDir = join(ctx.workspaceRoot, "docs", "decisiones");
  await ctx.fs.mkdirp(destDir);
  const nnn = await nextNumberInDir(ctx.fs, destDir);
  const destFile = join(destDir, `${nnn}-${ctx.slug}.md`);
  await ctx.fs.writeText(destFile, `${block.header}\n\n${block.body}\n`);

  const pointer = `${block.header}\n→ docs/decisiones/${nnn}-${ctx.slug}.md\n\n`;
  const newText = text.slice(0, block.startIndex) + pointer + text.slice(block.endIndex);
  await ctx.fs.writeText(decFile, newText);

  return {
    kind: "decision",
    session: ctx.folder,
    source: decFile,
    target: destFile,
    next_number: nnn,
    dec_id: decId,
    slug: ctx.slug,
  };
}

export async function graduateManual(
  ctx: GraduateContext,
  sourceArg: string | undefined,
): Promise<GraduateResult> {
  const sourceRel = sourceArg && sourceArg.length > 0 ? sourceArg : "MANUAL.md";
  const sourceFile = join(ctx.sessionPath, sourceRel);
  if (!(await ctx.fs.exists(sourceFile))) {
    return { error: `Fuente no existe: ${sourceRel} en la sesión` };
  }
  const content = await ctx.fs.readText(sourceFile);
  const destDir = join(ctx.workspaceRoot, "docs", "manuales");
  await ctx.fs.mkdirp(destDir);
  const nnn = await nextNumberInDir(ctx.fs, destDir);
  const destFile = join(destDir, `${nnn}-${ctx.slug}.md`);
  await ctx.fs.writeText(destFile, content);

  return {
    kind: "manual",
    session: ctx.folder,
    source: sourceFile,
    target: destFile,
    next_number: nnn,
    slug: ctx.slug,
  };
}

export async function graduateScript(ctx: GraduateContext): Promise<GraduateResult> {
  const sessionCode = parseSessionCode(ctx.folder);
  if (!sessionCode) {
    return { error: `No se pudo extraer el código de sesión de '${ctx.folder}'` };
  }
  const scriptsDir = join(ctx.sessionPath, "scripts");
  const queriesDir = join(ctx.sessionPath, "queries");
  const hasScripts = await ctx.fs.exists(scriptsDir);
  const hasQueries = await ctx.fs.exists(queriesDir);
  if (!hasScripts && !hasQueries) {
    return {
      error: "La sesión no contiene 'scripts/' ni 'queries/' — nada para graduar.",
    };
  }

  const destRoot = join(ctx.workspaceRoot, "docs", "scripts");
  await ctx.fs.mkdirp(destRoot);
  const nnn = await nextNumberInDirsByPrefix(ctx.fs, destRoot);
  const bundleName = `${nnn}-session${sessionCode}-${ctx.slug}`;
  const destDir = join(destRoot, bundleName);
  await ctx.fs.mkdirp(destDir);

  let copied = 0;
  if (hasScripts) {
    copied += await copyTree(ctx.fs, scriptsDir, join(destDir, "scripts"));
  }
  if (hasQueries) {
    copied += await copyTree(ctx.fs, queriesDir, join(destDir, "queries"));
  }

  return {
    kind: "script",
    session: ctx.folder,
    source: hasScripts ? scriptsDir : queriesDir,
    target: destDir,
    next_number: nnn,
    slug: ctx.slug,
    files_copied: copied,
  };
}

export async function graduateEspecificacion(
  ctx: GraduateContext,
  sourceArg: string | undefined,
): Promise<GraduateResult> {
  let sourceFile: string;
  let sourceRel: string;
  if (sourceArg && sourceArg.length > 0) {
    sourceRel = sourceArg;
    sourceFile = join(ctx.sessionPath, sourceArg);
    if (!(await ctx.fs.exists(sourceFile))) {
      return { error: `Fuente no existe: ${sourceRel} en la sesión` };
    }
  } else {
    const found = await findArtifact(ctx.sessionPath, "delivery", ctx.fs);
    if (!found) {
      return { error: "Fuente no existe: ENTREGA.md en la sesión" };
    }
    sourceFile = found;
    sourceRel = basename(found);
  }
  const content = await ctx.fs.readText(sourceFile);
  const destRoot = join(ctx.workspaceRoot, "docs", "especificaciones");
  await ctx.fs.mkdirp(destRoot);
  const nnn = await nextNumberInDirsByPrefix(ctx.fs, destRoot);
  const destDir = join(destRoot, `${nnn}-${ctx.slug}`);
  await ctx.fs.mkdirp(destDir);
  const filename = basename(sourceRel);
  const destFile = join(destDir, filename);
  await ctx.fs.writeText(destFile, content);

  return {
    kind: "especificacion",
    session: ctx.folder,
    source: sourceFile,
    target: destFile,
    next_number: nnn,
    slug: ctx.slug,
  };
}

export async function graduateConclusion(ctx: GraduateContext): Promise<GraduateResult> {
  const sourceFile = await findArtifact(ctx.sessionPath, "conclusions", ctx.fs);
  if (!sourceFile) {
    return { error: "CONCLUSIONES.md no existe en la sesión" };
  }
  const content = await ctx.fs.readText(sourceFile);
  const destDir = join(ctx.workspaceRoot, "docs", "conclusiones");
  await ctx.fs.mkdirp(destDir);
  const nnn = await nextNumberInDir(ctx.fs, destDir);
  const destFile = join(destDir, `${nnn}-${ctx.slug}.md`);
  await ctx.fs.writeText(destFile, content);

  return {
    kind: "conclusion",
    session: ctx.folder,
    source: sourceFile,
    target: destFile,
    next_number: nnn,
    slug: ctx.slug,
  };
}
