import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

const KNOWN_FLOWS = ["core", "dev", "design", "analyze"] as const;
type KnownFlow = (typeof KNOWN_FLOWS)[number];

const ORIGEN_DELIVERABLE: Record<KnownFlow, string> = {
  core: "OBJETIVO.md",
  dev: "OBJETIVO.md",
  design: "ENTREGA.md",
  analyze: "CONCLUSIONES.md",
};

export interface ResolvedOrigen {
  folder: string;
  path: string;
  flow: string;
  code: string;
  deliverable_name: string;
  deliverable_exists: boolean;
  deliverable_rel: string;
  summary: string | null;
}

export interface OrigenError {
  error: string;
}

export async function resolveOrigen(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  flowCodeRaw: string | undefined | null,
): Promise<ResolvedOrigen | OrigenError> {
  void env;
  const parsed = parseFlowCode(flowCodeRaw);
  if ("error" in parsed) return parsed;

  const sessionsDir = paths.cwdSessionsDir();
  if (!(await fs.exists(sessionsDir))) {
    return { error: `${sessionsDir} no existe en el CWD` };
  }
  const candidate = await findCandidate(fs, sessionsDir, parsed.codeNorm, parsed.flow);
  if (!candidate) {
    return { error: `no se encontró session${parsed.codeNorm}-${parsed.flow}-* en ${sessionsDir}` };
  }

  const deliverableName = ORIGEN_DELIVERABLE[parsed.flow];
  const deliverablePath = join(candidate.path, deliverableName);
  const deliverableExists = await fs.exists(deliverablePath);
  const summary = deliverableExists ? await extractSummary(fs, deliverablePath) : null;

  return {
    folder: candidate.name,
    path: candidate.path,
    flow: parsed.flow,
    code: parsed.codeNorm,
    deliverable_name: deliverableName,
    deliverable_exists: deliverableExists,
    deliverable_rel: `../${candidate.name}/${deliverableName}`,
    summary,
  };
}

export function renderOrigenBlock(origen: ResolvedOrigen | OrigenError | null): string {
  if (!origen || "error" in origen) return "";
  const parts: string[] = ["", "## Origen", `Derivado de \`${origen.folder}\`.`];
  if (origen.summary) {
    parts.push("");
    parts.push(origen.summary);
  }
  parts.push("");
  if (origen.deliverable_exists) {
    parts.push(`Ver: [\`${origen.deliverable_name}\`](${origen.deliverable_rel})`);
  } else {
    parts.push(
      `(Entregable esperado: \`${origen.deliverable_name}\` — aún no existe en la sesión origen.)`,
    );
  }
  parts.push("");
  return `${parts.join("\n")}\n`;
}

interface ParsedFlowCode {
  flow: KnownFlow;
  codeNorm: string;
}

function parseFlowCode(flowCodeRaw: string | undefined | null): ParsedFlowCode | OrigenError {
  if (!flowCodeRaw || !flowCodeRaw.includes(":")) {
    return { error: `--from requiere formato <flow>:<code> (recibido: '${flowCodeRaw ?? ""}')` };
  }
  const [flowRaw, codeRaw] = flowCodeRaw.split(":", 2);
  const flow = (flowRaw ?? "").trim().toLowerCase();
  const code = (codeRaw ?? "").trim();
  if (!isKnownFlow(flow)) {
    return { error: `flow desconocido '${flow}'; esperado uno de [core,dev,design,analyze]` };
  }
  if (!/^\d+$/.test(code)) {
    return { error: `code inválido '${code}'; esperado número (ej. 45 o 045)` };
  }
  return { flow, codeNorm: code.padStart(3, "0") };
}

async function findCandidate(
  fs: FileSystemPort,
  sessionsDir: string,
  codeNorm: string,
  flow: string,
): Promise<{ name: string; path: string } | null> {
  const entries = await fs.list(sessionsDir);
  const re = new RegExp(`^session${codeNorm}-${flow}-`);
  return entries.find((e) => e.type === "dir" && re.test(e.name)) ?? null;
}

async function extractSummary(fs: FileSystemPort, path: string): Promise<string | null> {
  try {
    const text = await fs.readText(path);
    return firstSummaryLine(text);
  } catch {
    return null;
  }
}

function firstSummaryLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#") || stripped.startsWith("<!--")) continue;
    if (stripped.length < 30 && stripped.split(/\s+/).length < 5) continue;
    return stripped.slice(0, 200);
  }
  return null;
}

function isKnownFlow(value: string): value is KnownFlow {
  return (KNOWN_FLOWS as readonly string[]).includes(value);
}
