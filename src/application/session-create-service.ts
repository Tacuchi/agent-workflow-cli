import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ResolvedOrigen, renderOrigenBlock, resolveOrigen } from "./handoff.js";
import { buildRow, upsertRow } from "./history-table.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";
import { renderRefs } from "./render/history-row.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { getObjetivoTemplate, renderTemplate } from "./templates/objetivo.js";

const TIPO_ALIASES: Record<string, string> = {
  proyecto: "project",
  project: "project",
  sistema: "system",
  system: "system",
};
const VALID_TIPOS_DESIGN = ["project", "system"] as const;
const TIPO_LEGACY_ACCEPTED = ["proyecto", "sistema"] as const;

const MODALIDAD_ALIASES: Record<string, string> = {
  tecnica: "technical",
  technical: "technical",
  datos: "data",
  data: "data",
  incidente: "incident",
  incident: "incident",
};
const VALID_MODALIDADES_ANALYZE = ["technical", "data", "incident"] as const;
const MODALIDAD_LEGACY_ACCEPTED = ["tecnica", "datos", "incidente"] as const;

function normalizeTipo(raw: string): string {
  return TIPO_ALIASES[raw.trim().toLowerCase()] ?? raw;
}

function normalizeModalidad(raw: string): string {
  return MODALIDAD_ALIASES[raw.trim().toLowerCase()] ?? raw;
}

type SessionFlow = "dev" | "design" | "analyze";

export interface SessionCreateInput {
  flow?: string;
  name?: string;
  objetivo?: string;
  branchesRaw?: string;
  origenRaw?: string;
  tipo?: string;
  modalidad?: string;
}

export interface SessionCreateRecordOutput {
  code: string;
  folder: string;
  path: string;
  phase: string | null;
  branches: string[];
  objective_path: string;
  history_updated: boolean;
  origen: { flow: string; code: string; folder: string } | null;
  flow: string;
  tipo?: string;
  modalidad?: string;
}

export interface SessionCreateFullOutput {
  projectMd: ProjectMdUpsertOutput;
  sessionCreate: SessionCreateRecordOutput;
}

export interface SessionCreateError {
  error: string;
  expected?: string[];
}

export async function runSessionCreate(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionCreateInput,
): Promise<SessionCreateFullOutput | SessionCreateError> {
  const validated = validateInput(input);
  if ("error" in validated) return validated;
  const { flow } = validated;

  const origen = await resolveOrigenIfPresent(fs, env, paths, input.origenRaw);
  if (origen && "error" in origen) return origen;

  const folderInfo = await prepareSessionFolder(fs, paths, flow, input.name ?? "");
  if ("error" in folderInfo) return folderInfo;

  await writeObjetivo(fs, folderInfo, flow, input, origen);
  const historyResult = await withCwdLock(fs, paths, () =>
    writeHistoryRow(fs, paths, folderInfo.code, flow, input, origen),
  );
  if (historyResult && typeof historyResult === "object" && "error" in historyResult) {
    return { error: historyResult.error };
  }
  const projectMd = await registerInProjectBlock(
    fs,
    env,
    paths,
    folderInfo.folder,
    input.branchesRaw,
  );
  if ("error" in projectMd) return { error: projectMd.error };

  const branches = parseBranches(input.branchesRaw);
  const recordOutput = composeRecord(folderInfo, flow, input, branches, origen);
  return { projectMd, sessionCreate: recordOutput };
}

interface ValidatedInput {
  flow: SessionFlow;
}

function validateInput(input: SessionCreateInput): ValidatedInput | SessionCreateError {
  const flow = input.flow?.trim();
  if (!flow) {
    return {
      error:
        "flow no resuelto. Pasá --flow <dev|design|analyze> o invocá el comando desde un plugin de flow (qtc-dev/design/analyze).",
      expected: ["dev", "design", "analyze"],
    };
  }
  if (flow !== "dev" && flow !== "design" && flow !== "analyze") {
    return { error: `flow inválido '${flow}'; esperado dev|design|analyze` };
  }
  const flowGuard = validateFlowSpecifics(flow, input);
  if (flowGuard) return flowGuard;
  if (!input.name) return { error: "--name es obligatorio (slug-kebab)" };
  if (!input.objetivo) return { error: "--objetivo es obligatorio" };
  return { flow };
}

async function resolveOrigenIfPresent(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  origenRaw: string | undefined,
): Promise<ResolvedOrigen | SessionCreateError | null> {
  if (!origenRaw) return null;
  const resolved = await resolveOrigen(fs, env, paths, origenRaw);
  if ("error" in resolved) {
    return { error: `--from inválido: ${resolved.error}` };
  }
  return resolved;
}

interface FolderInfo {
  code: string;
  folder: string;
  sessionPath: string;
  qtcDir: string;
}

async function prepareSessionFolder(
  fs: FileSystemPort,
  paths: PathsService,
  flow: SessionFlow,
  name: string,
): Promise<FolderInfo | SessionCreateError> {
  const qtcDir = paths.cwdSessionsDir();
  await fs.mkdirp(qtcDir);
  const code = await nextCode(fs, qtcDir);
  const folder = `session${code}-${flow}-${name}`;
  const sessionPath = join(qtcDir, folder);
  if (await fs.exists(sessionPath)) {
    return { error: `Ya existe ${sessionPath}` };
  }
  await fs.mkdirp(sessionPath);
  return { code, folder, sessionPath, qtcDir };
}

async function nextCode(fs: FileSystemPort, qtcDir: string): Promise<string> {
  const entries = await fs.list(qtcDir);
  const numbers = entries
    .filter((e) => e.type === "dir")
    .map((e) => e.name.match(/^session(\d{3})-/))
    .filter((m): m is RegExpMatchArray => m !== null && m[1] !== undefined)
    .map((m) => Number.parseInt(m[1] ?? "0", 10));
  const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return String(nextNum).padStart(3, "0");
}

async function writeObjetivo(
  fs: FileSystemPort,
  folderInfo: FolderInfo,
  flow: SessionFlow,
  input: SessionCreateInput,
  origen: ResolvedOrigen | null,
): Promise<void> {
  const template = getObjetivoTemplate(flow);
  const values: Record<string, string> = {
    folder: folderInfo.folder,
    objetivo: input.objetivo ?? "",
    origen_block: renderOrigenBlock(origen),
  };
  if (flow === "design" && input.tipo) values.tipo = input.tipo;
  if (flow === "analyze" && input.modalidad) values.modalidad = input.modalidad;
  await fs.writeText(
    canonicalArtifactPath(folderInfo.sessionPath, "objective"),
    renderTemplate(template, values),
  );
}

async function writeHistoryRow(
  fs: FileSystemPort,
  paths: PathsService,
  code: string,
  flow: SessionFlow,
  input: SessionCreateInput,
  origen: ResolvedOrigen | null,
): Promise<void> {
  const today = formatToday();
  const objetivo = input.objetivo ?? "";
  const summary = objetivo.length <= 100 ? objetivo : `${objetivo.slice(0, 97)}...`;
  const refsParts: string[] = [];
  if (origen) refsParts.push(`origen:${origen.flow}-${origen.code}`);
  const initialRefs = refsParts.length > 0 ? renderRefs(refsParts.join(",")) : "—";

  await upsertRow(fs, paths.cwdHistoryFile(), code, (hasFlow) =>
    buildRow({
      code,
      flow,
      sesionName: input.name ?? "",
      date: today,
      state: "active",
      summary,
      refs: initialRefs,
      hasFlow,
    }),
  );
}

async function registerInProjectBlock(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  folder: string,
  branchesRaw: string | undefined,
): Promise<ProjectMdUpsertOutput | { error: string }> {
  const branches = parseBranches(branchesRaw);
  const projectInput: Parameters<typeof runProjectMdUpsertWrite>[3] = {
    op: "add-session",
    sessionFolder: folder,
    phase: "planning",
  };
  if (branches.length > 0) projectInput.branches = branches;
  return runProjectMdUpsertWrite(fs, env, paths, projectInput);
}

function composeRecord(
  folderInfo: FolderInfo,
  flow: SessionFlow,
  input: SessionCreateInput,
  branches: string[],
  origen: ResolvedOrigen | null,
): SessionCreateRecordOutput {
  return {
    code: folderInfo.code,
    folder: folderInfo.folder,
    path: folderInfo.sessionPath,
    phase: "planning",
    branches,
    objective_path: canonicalArtifactPath(folderInfo.sessionPath, "objective"),
    history_updated: true,
    origen: origen ? { flow: origen.flow, code: origen.code, folder: origen.folder } : null,
    ...(flow === "design" && input.tipo ? { tipo: input.tipo } : {}),
    ...(flow === "analyze" && input.modalidad ? { modalidad: input.modalidad } : {}),
    flow,
  };
}

function validateFlowSpecifics(
  flow: SessionFlow,
  input: SessionCreateInput,
): SessionCreateError | null {
  if (flow === "design") return validateDesignArgs(input);
  if (flow === "analyze") return validateAnalyzeArgs(input);
  return validateDevArgs(input);
}

function validateDesignArgs(input: SessionCreateInput): SessionCreateError | null {
  if (!input.tipo) {
    return {
      error: "--type es obligatorio para flow=design",
      expected: [...VALID_TIPOS_DESIGN],
    };
  }
  const normalized = normalizeTipo(input.tipo);
  if (!(VALID_TIPOS_DESIGN as readonly string[]).includes(normalized)) {
    return {
      error: `--type inválido: '${input.tipo}'`,
      expected: [...VALID_TIPOS_DESIGN, ...TIPO_LEGACY_ACCEPTED],
    };
  }
  input.tipo = normalized;
  if (input.modalidad) return { error: "--modality sólo aplica a flow=analyze" };
  return null;
}

function validateAnalyzeArgs(input: SessionCreateInput): SessionCreateError | null {
  if (!input.modalidad) {
    return {
      error: "--modality es obligatorio para flow=analyze",
      expected: [...VALID_MODALIDADES_ANALYZE],
    };
  }
  const normalized = normalizeModalidad(input.modalidad);
  if (!(VALID_MODALIDADES_ANALYZE as readonly string[]).includes(normalized)) {
    return {
      error: `--modality inválido: '${input.modalidad}'`,
      expected: [...VALID_MODALIDADES_ANALYZE, ...MODALIDAD_LEGACY_ACCEPTED],
    };
  }
  input.modalidad = normalized;
  if (input.tipo) return { error: "--type sólo aplica a flow=design" };
  return null;
}

function validateDevArgs(input: SessionCreateInput): SessionCreateError | null {
  if (input.tipo) {
    return { error: "--type sólo aplica a flow=design (flow actual: 'dev')" };
  }
  if (input.modalidad) {
    return { error: "--modality sólo aplica a flow=analyze (flow actual: 'dev')" };
  }
  return null;
}

function parseBranches(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function formatToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
