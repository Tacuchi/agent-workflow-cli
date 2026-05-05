import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import {
  type ParsedProjectBlock,
  type ProjectBlockMarkers,
  parseProjectBlock,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { renderProjectBlock } from "./render/project-block.js";

export interface UpgradeHubModeInput {
  dryRun?: boolean;
}

export interface UpgradeHubModeOutput {
  applied: boolean;
  reason?: string;
  before_mode?: string;
  after_mode?: string;
  sources_count?: number;
  source_file?: string | null;
  results?: Array<{ file: string; action?: string; error?: string }>;
  hint?: string;
  dry_run?: boolean;
  eligible?: boolean;
  current_mode?: string;
  would_set_mode?: string;
}

export async function runUpgradeHubMode(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: UpgradeHubModeInput,
  runtime?: ResolvedRuntime,
): Promise<UpgradeHubModeOutput> {
  const cwd = env.cwd();
  const candidates = [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")];
  const markers = paths.blockMarkers();
  let block: ParsedProjectBlock | null = null;
  let sourceFile: string | null = null;
  for (const f of candidates) {
    if (!(await fs.exists(f))) continue;
    const parsed = parseProjectBlock(await fs.readText(f), markers);
    if (parsed) {
      block = parsed;
      sourceFile = f;
      break;
    }
  }

  const projectInitCmd =
    runtime?.slashCommands?.projectInit ?? "(run namespace-specific project-init command)";
  const hubInitCmd = runtime?.slashCommands?.hubInit ?? "(run namespace-specific hub-init command)";

  if (!block) {
    return {
      applied: false,
      reason: "no_qtc_project_block_found",
      hint: `Corre ${projectInitCmd} o ${hubInitCmd} primero.`,
    };
  }

  const eligible = isEligibleForHubUpgrade(block);
  const currentMode = block.mode || "project";
  const sourcesCount = block.fuentes.length;

  if (!eligible) {
    return {
      applied: false,
      reason: "not_eligible",
      current_mode: currentMode,
      sources_count: sourcesCount,
      hint: `El workspace ya está en hub mode o tiene <2 fuentes. Para promover manualmente, corre ${hubInitCmd}.`,
    };
  }

  if (input.dryRun === true) {
    return {
      applied: false,
      dry_run: true,
      eligible: true,
      current_mode: currentMode,
      sources_count: sourcesCount,
      would_set_mode: "hub",
    };
  }

  const newBlock = renderProjectBlock({
    proyecto: block.proyecto,
    fuentes: block.fuentes,
    stack: block.stack,
    sessions: block.sessions,
    ...(block.last_activity !== null ? { lastActivity: block.last_activity } : {}),
    mode: "hub",
    workingBranches: block.working_branches,
    markers,
  });

  const results: NonNullable<UpgradeHubModeOutput["results"]> = [];
  for (const f of candidates) {
    try {
      const action = await upsertProjectBlock(fs, f, newBlock, markers);
      const fname = f.split(/[\\/]/).pop() ?? f;
      results.push({ file: fname, action });
    } catch (err) {
      const fname = f.split(/[\\/]/).pop() ?? f;
      results.push({
        file: fname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    applied: true,
    before_mode: currentMode,
    after_mode: "hub",
    sources_count: sourcesCount,
    source_file: sourceFile,
    results,
  };
}

function isEligibleForHubUpgrade(block: ParsedProjectBlock): boolean {
  const currentMode = block.mode || "project";
  if (currentMode === "hub") return false;
  return block.fuentes.length >= 2;
}

async function upsertProjectBlock(
  fs: FileSystemPort,
  filePath: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<"created" | "updated" | "unchanged" | "appended"> {
  if (!(await fs.exists(filePath))) {
    await fs.writeText(filePath, `${block}\n`);
    return "created";
  }
  const text = await fs.readText(filePath);
  if (text.includes(markers.start) && text.includes(markers.end)) {
    const start = text.indexOf(markers.start);
    const end = text.indexOf(markers.end, start) + markers.end.length;
    const replaced = text.slice(0, start) + block + text.slice(end);
    if (replaced === text) return "unchanged";
    await fs.writeText(filePath, replaced);
    return "updated";
  }
  let appended = text;
  if (appended.length > 0 && !appended.endsWith("\n")) appended += "\n";
  if (appended.length > 0 && !appended.endsWith("\n\n")) appended += "\n";
  await fs.writeText(filePath, `${appended}${block}\n`);
  return "appended";
}
