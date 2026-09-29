import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readPackageVersion } from "../../runtime/version.js";
import { digestOf } from "../byte-digest.js";

export const DIST_MANIFEST = "dist-manifest.json";
const CATEGORY = "installation-hosts" as const;

/** The compiled module is dist/application/doctor/dist-integrity.js. */
export function installedDistRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

interface Manifest {
  version: string;
  files: { path: string; sha256: string }[];
}

function validManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<Manifest>;
  if (typeof manifest.version !== "string" || !Array.isArray(manifest.files)) return false;
  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== "string" || typeof item.sha256 !== "string") return false;
    const segments = item.path.split("/");
    if (
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      !/^[\w./-]+$/.test(item.path) ||
      item.path === DIST_MANIFEST ||
      !/^sha256:[a-f0-9]{64}$/.test(item.sha256) ||
      seen.has(item.path)
    )
      return false;
    seen.add(item.path);
  }
  return true;
}

async function actualFiles(fs: FileSystemPort, root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.list(dir)) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === "dir") await walk(join(dir, entry.name), name);
      else if (entry.type === "file" && name !== DIST_MANIFEST) files.push(name);
    }
  }
  await walk(root, "");
  return files.sort();
}

function finding(
  root: string,
  state: DoctorFinding["state"],
  summary: string,
  evidence: string[],
): DoctorFinding {
  return {
    id: doctorFindingId("workspace", CATEGORY, "dist-integrity"),
    host: "workspace",
    category: CATEGORY,
    resource: { kind: "dist", name: "integridad del CLI", locator: root },
    state,
    summary,
    impact: "los archivos instalados pueden diferir de los de esta versión",
    evidence,
    ownership: "ours",
    remediation: { kind: "none", action: null, guidance: [] },
  };
}

/** Local byte comparison; an absent or foreign reference is never a patch claim. */
export async function checkDistIntegrity(fs: FileSystemPort, root: string): Promise<DoctorFinding> {
  const manifestPath = join(root, DIST_MANIFEST);
  if (!(await fs.exists(manifestPath))) {
    return finding(root, "unverified", "integridad del dist/ sin verificar: falta el manifiesto", [
      manifestPath,
    ]);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readText(manifestPath));
  } catch {
    return finding(root, "unverified", "integridad del dist/ sin verificar: manifiesto ilegible", [
      manifestPath,
    ]);
  }
  if (!validManifest(manifest)) {
    return finding(root, "unverified", "integridad del dist/ sin verificar: manifiesto inválido", [
      manifestPath,
    ]);
  }
  const version = readPackageVersion();
  if (manifest.version !== version) {
    return finding(
      root,
      "unverified",
      "integridad del dist/ sin verificar: manifiesto de otra versión",
      [`manifiesto ${manifest.version}; paquete ${version}`],
    );
  }
  try {
    const actual = await actualFiles(fs, root);
    const observed = new Set(actual);
    const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    const changed: string[] = [];
    for (const path of actual) {
      if (
        expected.has(path) &&
        digestOf(await fs.readBytes(join(root, path))) !== expected.get(path)
      ) {
        changed.push(`editado: ${path}`);
      }
    }
    const missing = [...expected.keys()]
      .filter((path) => !observed.has(path))
      .map((path) => `borrado: ${path}`);
    const added = actual.filter((path) => !expected.has(path)).map((path) => `agregado: ${path}`);
    const differences = [...changed, ...missing, ...added];
    return differences.length > 0
      ? finding(root, "warning", "dist/ no coincide con el publicado", differences)
      : finding(root, "healthy", "dist/ coincide con el manifiesto de esta versión", [
          `${actual.length} archivos verificados`,
        ]);
  } catch {
    return finding(
      root,
      "unverified",
      "integridad del dist/ sin verificar: no se pudieron leer sus archivos",
      [root],
    );
  }
}
