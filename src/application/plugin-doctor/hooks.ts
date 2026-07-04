import { join } from "node:path";
import { HARNESSES } from "../../domain/harnesses.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type DoctorFinding, type HooksInfoValue, isRecord, readJson } from "./common.js";

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
  const parsed = await readJson(fs, hookPath);
  if ("error" in parsed) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${parsed.error}`,
    });
    return { value: null, findings };
  }
  const data = parsed.data;
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
