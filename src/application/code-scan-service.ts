// Mirror de qtc_core/code_scan.py.
import { readFileSync, realpathSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";

const DEFAULT_EXCLUDES = [
  "node_modules",
  "target",
  "dist",
  "build",
  ".qtc",
  "docs",
  "tests",
  "test",
  ".git",
  "__pycache__",
  ".idea",
  ".vscode",
];

const DEFAULT_EXTENSIONS = [
  ".java",
  ".ts",
  ".js",
  ".py",
  ".go",
  ".rb",
  ".php",
  ".cs",
  ".kt",
  ".scala",
  ".vue",
  ".tsx",
  ".jsx",
  ".properties",
  ".yml",
  ".yaml",
  ".json",
  ".xml",
  ".sql",
];

export interface ScanPattern {
  id: string;
  regex: string;
  severity: string;
  recommendation: string;
}

export interface ScanMatch {
  pattern_id: string;
  severity: string;
  file: string;
  line: number;
  snippet: string;
  recommendation: string;
}

const BUILTIN_PATTERNS: ScanPattern[] = [
  {
    id: "localhost",
    regex: "https?://localhost(:\\d+)?",
    severity: "media",
    recommendation: "Reemplazar por variable de entorno (ej. APP_API_URL).",
  },
  {
    id: "ip-address",
    regex: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
    severity: "media",
    recommendation: "Mover IPs a configuración externa.",
  },
  {
    id: "todo-fixme",
    regex: "\\b(?:TODO|FIXME|XXX|HACK)\\b",
    severity: "baja",
    recommendation: "Resolver o documentar antes de release.",
  },
  {
    id: "hardcoded-secret",
    regex: "(?i)(password|api[_-]?key|secret|token)\\s*[:=]\\s*['\"][^'\"]{8,}['\"]",
    severity: "alta",
    recommendation: "Rotar credenciales + mover a gestor de secretos.",
  },
  {
    id: "console-log",
    regex: "console\\.(log|debug|info)\\(",
    severity: "baja",
    recommendation: "Eliminar logs de debug antes de prod.",
  },
];

export interface CodeScanInput {
  root?: string;
  patternsFile?: string;
  inlinePatterns?: ScanPattern[];
  extOverride?: string[];
  excludeOverride?: string[];
  maxPerPattern?: number;
}

export interface CodeScanOutput {
  matches: ScanMatch[];
  counts: Record<string, number>;
  by_severity: { alta: number; media: number; baja: number };
  root: string;
  patterns_used: string[];
  total_matches: number;
}

export interface CodeScanError {
  error: string;
  root?: string;
  file?: string;
}

export async function runCodeScan(
  fs: FileSystemPort,
  env: EnvPort,
  input: CodeScanInput,
): Promise<CodeScanOutput | CodeScanError> {
  const rootArg = input.root ?? ".";
  const cwd = env.cwd();
  const absolute = resolve(rootArg.startsWith("/") ? rootArg : join(cwd, rootArg));
  let rootPath = absolute;
  try {
    rootPath = realpathSync(absolute);
  } catch {
    // Mirror Python Path.resolve(): if the path doesn't exist, keep the absolute form.
  }
  if (!(await fs.exists(rootPath))) {
    return { error: "root_not_found", root: rootPath };
  }

  let patterns: ScanPattern[];
  if (input.inlinePatterns && input.inlinePatterns.length > 0) {
    patterns = input.inlinePatterns;
  } else if (input.patternsFile) {
    const loaded = loadPatternsFromFile(input.patternsFile);
    if (!loaded || loaded.length === 0) {
      return { error: "patterns_file_invalid_or_empty", file: input.patternsFile };
    }
    patterns = loaded;
  } else {
    patterns = BUILTIN_PATTERNS;
  }

  const extensions = (input.extOverride ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());
  const excludes = (input.excludeOverride ?? DEFAULT_EXCLUDES).map((e) => e.toLowerCase());
  const maxPerPattern = input.maxPerPattern ?? 200;

  const result = await scanFiles(fs, rootPath, patterns, extensions, excludes, maxPerPattern);
  return {
    ...result,
    root: rootPath,
    patterns_used: patterns.map((p) => p.id),
    total_matches: result.matches.length,
  };
}

function loadPatternsFromFile(path: string): ScanPattern[] | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as ScanPattern[];
  } catch {
    return null;
  }
}

interface ScanResult {
  matches: ScanMatch[];
  counts: Record<string, number>;
  by_severity: { alta: number; media: number; baja: number };
}

async function scanFiles(
  fs: FileSystemPort,
  root: string,
  patterns: ScanPattern[],
  extensions: string[],
  excludes: string[],
  maxPerPattern: number,
): Promise<ScanResult> {
  const compiled = patterns.map((p) => {
    try {
      return { pattern: p, regex: compilePattern(p.regex) };
    } catch {
      return { pattern: p, regex: null };
    }
  });

  const matches: ScanMatch[] = [];
  const counts: Record<string, number> = {};
  for (const p of patterns) counts[p.id] = 0;

  for await (const filePath of walkFiles(fs, root, extensions, excludes)) {
    let text: string;
    try {
      text = await fs.readText(filePath);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    // Mirror Python str.splitlines() — drop trailing empty.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const { pattern, regex } of compiled) {
        if (!regex) continue;
        if ((counts[pattern.id] ?? 0) >= maxPerPattern) continue;
        if (regex.test(line)) {
          counts[pattern.id] = (counts[pattern.id] ?? 0) + 1;
          matches.push({
            pattern_id: pattern.id,
            severity: pattern.severity,
            file: filePath,
            line: i + 1,
            snippet: line.trim().slice(0, 200),
            recommendation: pattern.recommendation,
          });
        }
      }
    }
  }

  const bySeverity = { alta: 0, media: 0, baja: 0 };
  for (const m of matches) {
    if (m.severity === "alta" || m.severity === "media" || m.severity === "baja") {
      bySeverity[m.severity] += 1;
    }
  }

  return { matches, counts, by_severity: bySeverity };
}

function compilePattern(regex: string): RegExp {
  // Mirror Python `(?i)` flag prefix → JS `i` flag.
  if (regex.startsWith("(?i)")) {
    return new RegExp(regex.slice(4), "i");
  }
  return new RegExp(regex);
}

async function* walkFiles(
  fs: FileSystemPort,
  root: string,
  extensions: string[],
  excludes: string[],
): AsyncGenerator<string> {
  const stack: string[] = [root];
  const exSet = new Set(excludes);
  const extSet = new Set(extensions);
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
    try {
      entries = await fs.list(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.type === "dir") {
        if (!exSet.has(entry.name.toLowerCase())) {
          stack.push(entry.path);
        }
      } else if (entry.type === "file") {
        const ext = extname(entry.name).toLowerCase();
        if (extSet.has(ext)) {
          yield entry.path;
        }
      }
    }
  }
}
