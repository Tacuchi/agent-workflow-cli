import { isAbsolute, join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

const PLAN_FOLDER = "docs/planes";

export type PlanState = "draft" | "active" | "done" | "archived";

export interface PlanFrontmatter {
  state: PlanState;
  sessions: string[];
  created: string;
  slug: string;
  state_changes: PlanStateChange[];
  raw: Record<string, unknown>;
}

export interface PlanStateChange {
  from: string | null;
  to: PlanState;
  when: string;
  trigger: string;
}

export interface ResolvedPlan {
  path: string;
  relpath: string;
  filename: string;
  frontmatter: PlanFrontmatter;
  body: string;
  resumen: string | null;
}

export type FromPlanErrorCode =
  | "PLAN_NOT_FOUND"
  | "PLAN_INVALID_FRONTMATTER"
  | "PLAN_ARCHIVED"
  | "INVALID_INPUT";

export interface FromPlanError {
  code: FromPlanErrorCode;
  message: string;
}

export async function resolveFromPlan(
  fs: FileSystemPort,
  paths: PathsService,
  cwd: string,
  fromPlanRaw: string,
): Promise<ResolvedPlan | FromPlanError> {
  const trimmed = fromPlanRaw.trim();
  if (trimmed.length === 0) {
    return { code: "INVALID_INPUT", message: "--from-plan vacío" };
  }
  void paths;
  const planPath = await resolvePlanPath(fs, cwd, trimmed);
  if (planPath === null) {
    return {
      code: "PLAN_NOT_FOUND",
      message: `--from-plan: no se encontró plan para '${trimmed}'`,
    };
  }
  const text = await fs.readText(planPath);
  const parsed = parsePlanFile(text);
  if ("code" in parsed) return parsed;

  if (parsed.frontmatter.state === "archived") {
    return {
      code: "PLAN_ARCHIVED",
      message: `--from-plan: el plan '${trimmed}' está archivado; generá uno nuevo con /qtc:export-plan`,
    };
  }

  const relpath = planPath.startsWith(cwd) ? planPath.slice(cwd.length + 1) : planPath;
  const filename = planPath.slice(planPath.lastIndexOf("/") + 1);

  return {
    path: planPath,
    relpath,
    filename,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    resumen: extractResumen(parsed.body),
  };
}

async function resolvePlanPath(
  fs: FileSystemPort,
  cwd: string,
  raw: string,
): Promise<string | null> {
  // Path absoluto o relativo con extensión .md.
  if (raw.endsWith(".md")) {
    const abs = isAbsolute(raw) ? raw : join(cwd, raw);
    return (await fs.exists(abs)) ? abs : null;
  }
  // NNN: buscar en docs/planes/.
  const nnnMatch = raw.match(/^\d{1,3}$/);
  if (!nnnMatch) return null;
  const padded = raw.padStart(3, "0");
  const planesDir = join(cwd, PLAN_FOLDER);
  if (!(await fs.exists(planesDir))) return null;
  const entries = await fs.list(planesDir);
  const re = new RegExp(`^${padded}-.+\\.md$`);
  for (const e of entries) {
    if (e.type === "file" && re.test(e.name)) {
      return e.path;
    }
  }
  return null;
}

interface ParseSuccess {
  frontmatter: PlanFrontmatter;
  body: string;
}

function parsePlanFile(text: string): ParseSuccess | FromPlanError {
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch || !fmMatch[1] || fmMatch[2] === undefined) {
    return {
      code: "PLAN_INVALID_FRONTMATTER",
      message: "--from-plan: plan sin frontmatter YAML válido (--- bloque ---)",
    };
  }
  const yaml = parseSimpleYaml(fmMatch[1]);
  const stateRaw = String(yaml.state ?? "");
  if (!isPlanState(stateRaw)) {
    return {
      code: "PLAN_INVALID_FRONTMATTER",
      message: `--from-plan: state inválido '${stateRaw}' (esperado: draft|active|done|archived)`,
    };
  }
  const sessions = toStringArray(yaml.sessions ?? []);
  const created = String(yaml.created ?? "");
  const slug = String(yaml.slug ?? "");
  const stateChanges = parseStateChanges(yaml.state_changes);
  return {
    frontmatter: {
      state: stateRaw,
      sessions,
      created,
      slug,
      state_changes: stateChanges,
      raw: yaml,
    },
    body: fmMatch[2],
  };
}

function isPlanState(s: string): s is PlanState {
  return s === "draft" || s === "active" || s === "done" || s === "archived";
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function parseStateChanges(v: unknown): PlanStateChange[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => ({
      from: x.from === null || x.from === undefined ? null : String(x.from),
      to: (isPlanState(String(x.to)) ? String(x.to) : "draft") as PlanState,
      when: String(x.when ?? ""),
      trigger: String(x.trigger ?? ""),
    }));
}

function extractResumen(body: string): string | null {
  const m = body.match(/^##\s+Resumen\s*\n+([\s\S]*?)(?:\n##\s|$)/m);
  if (!m || !m[1]) return null;
  const text = m[1].trim();
  return text.length > 0 ? text : null;
}

/**
 * Parser YAML minimal-flat: solo soporta scalars + arrays inline + arrays multi-línea de objetos plana.
 * Pensado para los frontmatter generados por export-plan; no es un parser YAML general.
 */
function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let rest = trimmed.slice(colonIdx + 1).trim();
    if (rest === "") {
      // collect block array of inline objects (`  - {...}`).
      const items: unknown[] = [];
      while (i < lines.length) {
        const peek = lines[i] ?? "";
        const peekTrim = peek.trim();
        if (peekTrim.startsWith("- ")) {
          const itemRaw = peekTrim.slice(2).trim();
          items.push(parseInlineValue(itemRaw));
          i++;
        } else if (peekTrim === "" || peekTrim.startsWith("#")) {
          i++;
        } else {
          break;
        }
      }
      out[key] = items;
      continue;
    }
    rest = stripQuotes(rest);
    out[key] = parseInlineValue(rest);
  }
  return out;
}

function parseInlineValue(raw: string): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseInlineScalar(stripQuotes(s.trim())));
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const inner = raw.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (inner === "") return obj;
    for (const part of splitTopLevel(inner)) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      const v = stripQuotes(part.slice(idx + 1).trim());
      obj[k] = parseInlineScalar(v);
    }
    return obj;
  }
  return parseInlineScalar(raw);
}

function parseInlineScalar(v: string): unknown {
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  // Preserve strings con leading zeros (ej: "055"). Solo convertir si NO tiene leading zero (o es solo "0").
  if (/^-?[1-9]\d*$/.test(v) || v === "0") return Number.parseInt(v, 10);
  return v;
}

function stripQuotes(v: string): string {
  if (
    v.length >= 2 &&
    ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

/**
 * Actualiza state de un plan en disco: transiciona `from` → `to`, appendea entry
 * a `state_changes[]`. Idempotente: si state ya es `to`, no escribe.
 */
export async function transitionPlanState(
  fs: FileSystemPort,
  resolved: ResolvedPlan,
  to: PlanState,
  trigger: string,
): Promise<{ wrote: boolean; from: PlanState }> {
  const from = resolved.frontmatter.state;
  if (from === to) return { wrote: false, from };
  const text = await fs.readText(resolved.path);
  const updated = applyStateTransition(text, from, to, trigger);
  await fs.writeText(resolved.path, updated);
  return { wrote: true, from };
}

function applyStateTransition(
  text: string,
  from: PlanState,
  to: PlanState,
  trigger: string,
): string {
  // Replace state line.
  const stateLineRe = /^state:\s*.+$/m;
  let next = text.replace(stateLineRe, `state: ${to}`);
  // Append entry to state_changes block.
  const entry = `  - {from: ${from}, to: ${to}, when: '${new Date().toISOString()}', trigger: '${trigger}'}`;
  const stateChangesRe = /^state_changes:\s*\n((?: {2}- .+\n)+)/m;
  if (stateChangesRe.test(next)) {
    next = next.replace(stateChangesRe, (_match, items) => {
      return `state_changes:\n${items}${entry}\n`;
    });
  } else {
    // No block previo: agregar al final del frontmatter.
    next = next.replace(
      /^---\r?\n([\s\S]*?)\r?\n---/,
      (_match, body) => `---\n${body}\nstate_changes:\n${entry}\n---`,
    );
  }
  return next;
}
