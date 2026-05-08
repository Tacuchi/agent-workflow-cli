// Graduation routing check — detecta artefactos graduados a fuentes (docs/manuales|rfcs|post-mortems|analisis)
// sin breadcrumb correspondiente en el hub. Aplica solo en hub mode.
//
// Lee CLAUDE.md del cwd (hub workspace), parsea bloque `## Fuentes` para
// obtener alias + path, y walkea docs/<categoria>/ en cada fuente. Por cada
// archivo NNN-<slug>.md encontrado en una fuente, busca breadcrumb correspondiente
// en `<hub>/docs/<categoria>/000-INDEX.md` (regex sobre el filename).
//
// Output: lista de findings con level (error/warn/ok) por categoría.
//
// Origen: session005-dev-fix-graduacion-docs-hub-fuente, Phase 3.
import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";

const CATEGORIAS = ["manuales", "rfcs", "post-mortems", "analisis", "refactors"] as const;
type Categoria = (typeof CATEGORIAS)[number];

export interface GraduationCheckFinding {
  level: "warn" | "ok";
  fuente: string;
  categoria: string;
  file: string;
  msg: string;
}

export interface GraduationCheckOutput {
  status: "ok" | "warn" | "skipped";
  hub_mode: boolean;
  hub_path: string;
  fuentes_count: number;
  findings: GraduationCheckFinding[];
  reason?: string;
}

interface FuenteEntry {
  alias: string;
  path: string;
}

export async function runGraduationCheck(
  fs: FileSystemPort,
  env: EnvPort,
): Promise<GraduationCheckOutput> {
  const hubPath = env.cwd();
  const claudeMd = await readClaudeMd(fs, hubPath);
  if (!claudeMd) {
    return {
      status: "skipped",
      hub_mode: false,
      hub_path: hubPath,
      fuentes_count: 0,
      findings: [],
      reason: "CLAUDE.md no encontrado en cwd",
    };
  }
  if (!isHubMode(claudeMd)) {
    return {
      status: "skipped",
      hub_mode: false,
      hub_path: hubPath,
      fuentes_count: 0,
      findings: [],
      reason: "workspace no está en Mode: hub",
    };
  }
  const fuentes = parseFuentes(claudeMd);
  if (fuentes.length === 0) {
    return {
      status: "skipped",
      hub_mode: true,
      hub_path: hubPath,
      fuentes_count: 0,
      findings: [],
      reason: "no se encontraron fuentes en CLAUDE.md",
    };
  }

  const findings: GraduationCheckFinding[] = [];
  for (const fuente of fuentes) {
    for (const categoria of CATEGORIAS) {
      const f = await checkFuenteCategoria(fs, hubPath, fuente, categoria);
      findings.push(...f);
    }
  }
  const status = findings.some((f) => f.level === "warn") ? "warn" : "ok";
  return {
    status,
    hub_mode: true,
    hub_path: hubPath,
    fuentes_count: fuentes.length,
    findings,
  };
}

async function readClaudeMd(fs: FileSystemPort, hubPath: string): Promise<string | null> {
  const claudePath = join(hubPath, "CLAUDE.md");
  if (!(await fs.exists(claudePath))) {
    const agentsPath = join(hubPath, "AGENTS.md");
    if (!(await fs.exists(agentsPath))) return null;
    return fs.readText(agentsPath);
  }
  return fs.readText(claudePath);
}

function isHubMode(text: string): boolean {
  return /^\s*Mode:\s*hub\s*$/m.test(text);
}

function parseFuentes(text: string): FuenteEntry[] {
  const lines = text.split(/\r?\n/);
  const out: FuenteEntry[] = [];
  let inFuentes = false;
  for (const line of lines) {
    if (/^##\s+Fuentes\s*$/i.test(line)) {
      inFuentes = true;
      continue;
    }
    if (inFuentes && /^##\s+/.test(line)) break;
    if (!inFuentes) continue;
    const m = line.match(/^\|\s*([\w-]+)\s*\|\s*([^\s|]+)\s*\|/);
    if (m?.[1] && m[2] && m[1] !== "Alias" && !m[1].startsWith("---")) {
      out.push({ alias: m[1], path: m[2] });
    }
  }
  return out;
}

async function checkFuenteCategoria(
  fs: FileSystemPort,
  hubPath: string,
  fuente: FuenteEntry,
  categoria: Categoria,
): Promise<GraduationCheckFinding[]> {
  const fuenteDir = join(fuente.path, "docs", categoria);
  if (!(await fs.exists(fuenteDir))) return [];
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(fuenteDir);
  } catch {
    return [];
  }
  const orphans: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (!/^\d{3}-.*\.md$/.test(entry.name)) continue;
    if (entry.name === "000-INDEX.md") continue;
    orphans.push(entry.name);
  }
  if (orphans.length === 0) return [];

  const indexFile = join(hubPath, "docs", categoria, "000-INDEX.md");
  const indexText = (await fs.exists(indexFile)) ? await fs.readText(indexFile) : "";
  const findings: GraduationCheckFinding[] = [];
  for (const orphan of orphans) {
    if (indexText.includes(orphan)) {
      findings.push({
        level: "ok",
        fuente: fuente.alias,
        categoria,
        file: `${fuente.path}/docs/${categoria}/${orphan}`,
        msg: "breadcrumb encontrado en hub",
      });
    } else {
      findings.push({
        level: "warn",
        fuente: fuente.alias,
        categoria,
        file: `${fuente.path}/docs/${categoria}/${orphan}`,
        msg: `falta breadcrumb en <hub>/docs/${categoria}/000-INDEX.md (debe mencionar '${orphan}')`,
      });
    }
  }
  return findings;
}
