import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type DoctorFinding, isRecord } from "./common.js";

export interface ManifestsResult {
  manifestsInfo: Record<string, string | null>;
  canonicalVersion: string | null;
  manifestPluginName: string | null;
  manifestContractVersion: string | null;
  findings: DoctorFinding[];
}

export async function parseManifests(
  pluginRoot: string,
  fs: FileSystemPort,
  inputPluginVersion: string | null,
): Promise<ManifestsResult> {
  const findings: DoctorFinding[] = [];
  const manifestsInfo: Record<string, string | null> = {};
  let canonicalVersion: string | null = inputPluginVersion;
  let manifestPluginName: string | null = null;
  let manifestContractVersion: string | null = null;
  for (const relPath of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const parsed = await parseManifestFile(join(pluginRoot, relPath), relPath, fs);
    manifestsInfo[relPath] = parsed.version;
    findings.push(...parsed.findings);
    if (parsed.parseError) continue;
    if (manifestPluginName === null && parsed.name !== null) {
      manifestPluginName = parsed.name;
    }
    if (canonicalVersion === null && parsed.version !== null) {
      canonicalVersion = parsed.version;
    } else if (
      canonicalVersion !== null &&
      parsed.version !== null &&
      parsed.version !== canonicalVersion
    ) {
      findings.push({
        level: "error",
        file: relPath,
        msg: `version drift: manifest=${parsed.version} vs declared=${canonicalVersion}`,
      });
    }
    if (manifestContractVersion === null && parsed.contractVersion !== null) {
      manifestContractVersion = parsed.contractVersion;
    }
  }
  return {
    manifestsInfo,
    canonicalVersion,
    manifestPluginName,
    manifestContractVersion,
    findings,
  };
}

interface ParsedManifest {
  version: string | null;
  name: string | null;
  contractVersion: string | null;
  parseError: boolean;
  findings: DoctorFinding[];
}

async function parseManifestFile(
  manifestPath: string,
  relPath: string,
  fs: FileSystemPort,
): Promise<ParsedManifest> {
  const findings: DoctorFinding[] = [];
  if (!(await fs.exists(manifestPath))) {
    findings.push({ level: "warn", file: relPath, msg: "manifest missing" });
    return { version: null, name: null, contractVersion: null, parseError: true, findings };
  }
  let raw: string;
  try {
    raw = await fs.readText(manifestPath);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { version: null, name: null, contractVersion: null, parseError: true, findings };
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
    return { version: null, name: null, contractVersion: null, parseError: true, findings };
  }
  if (!isRecord(data)) {
    return { version: null, name: null, contractVersion: null, parseError: false, findings };
  }
  return {
    version: typeof data.version === "string" ? data.version : null,
    name: typeof data.name === "string" && data.name.length > 0 ? data.name : null,
    contractVersion: typeof data.contractVersion === "string" ? data.contractVersion : null,
    parseError: false,
    findings,
  };
}
