import { join } from "node:path";
import { HARNESSES } from "../../domain/harnesses.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type DoctorFinding, type HooksInfoValue, isRecord } from "./common.js";

export interface HooksResult {
  hooksInfo: Record<string, HooksInfoValue>;
  findings: DoctorFinding[];
}

export async function parseHooks(pluginRoot: string, fs: FileSystemPort): Promise<HooksResult> {
  const findings: DoctorFinding[] = [];
  const hooksInfo: Record<string, HooksInfoValue> = {};
  const hookRelPaths = HARNESSES.filter((h) => h.pluginHooksDir !== null).map(
    (h) => `${h.pluginHooksDir}/hooks.json`,
  );
  for (const relPath of hookRelPaths) {
    const result = await parseHookFile(join(pluginRoot, relPath), relPath, fs);
    hooksInfo[relPath] = result.value;
    findings.push(...result.findings);
  }
  return { hooksInfo, findings };
}

async function parseHookFile(
  hookPath: string,
  relPath: string,
  fs: FileSystemPort,
): Promise<{ value: HooksInfoValue; findings: DoctorFinding[] }> {
  const findings: DoctorFinding[] = [];
  if (!(await fs.exists(hookPath))) {
    findings.push({ level: "warn", file: relPath, msg: "hooks file missing" });
    return { value: null, findings };
  }
  let raw: string;
  try {
    raw = await fs.readText(hookPath);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { value: null, findings };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { value: null, findings };
  }
  if (!isRecord(data) || !("hooks" in data) || !isRecord(data.hooks)) {
    findings.push({
      level: "warn",
      file: relPath,
      msg: "hooks JSON missing top-level 'hooks' key",
    });
    return { value: "invalid-structure", findings };
  }
  return { value: Object.keys(data.hooks).sort(), findings };
}
