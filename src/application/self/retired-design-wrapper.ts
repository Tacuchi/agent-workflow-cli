import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Byte fingerprints of the wrapper and descriptor shipped by 26.0.0. */
const OWNED_26 = {
  descriptor: "1b0334bfe8d1600dcccc0791e4bdafc8c746e580b55a3ac7892d3ad808d94244",
  wrappers: new Set([
    "581c7735b4183425f0395f22679f1fce400ff01a922ec0450c9f3706c51e7fbc",
    "6527c7b7014b37cc218c0fe351d8cf9dad332ccb581fa36cdf40c0ce99df1ae4",
    "e274b807cee7368f55a2b90e94f27d0cc3b96c23ee799a3aa0c4734d0f0d0c51",
    "5574427f54edf5938e93512556ece775b8b6c9b1705f7b717fa7d842b0e6f657",
    "7502ae99912196a4fe7533471791223b5d83d032eaf493c8f3e67bb8b0e0db78",
    "2e18d683d853d08058c320e0684ae232bb450c0a32140388b616fd92e9848a70",
    "503e9e5f7f0cf31ee5a930eded9a54c904499018d29daa09f10603442566dc06",
    "e7119456fa421d4e3672517040116c78093569d5cd3a76f4841445c2ed068703",
    "f4e1cf0ea3b06e989fb8a70bb6db9aeb9e12b070badd0dcca7ddeea3f4d3780c",
  ]),
};

interface KnownWrapperBytes {
  descriptor: string;
  wrappers: ReadonlySet<string>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Preserve an unknown or hand-edited skill, including extra files and symlinks. */
export async function removeRetiredDesignWrapper(
  root: string,
  known: KnownWrapperBytes = OWNED_26,
): Promise<{
  path: string;
  status: "absent" | "removed" | "preserved";
  reason?: string;
}> {
  const path = join(root, "design");
  try {
    if (!(await lstat(path)).isDirectory())
      return { path, status: "preserved", reason: "no es un directorio propio" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, status: "absent" };
    return {
      path,
      status: "preserved",
      reason: `no se pudo inspeccionar: ${(error as Error).message}`,
    };
  }
  try {
    const files = await readdir(path);
    if (
      files.length !== 2 ||
      !files.includes("SKILL.md") ||
      !files.includes("workline-capability.json")
    ) {
      return { path, status: "preserved", reason: "archivos adicionales o incompletos" };
    }
    const skillPath = join(path, "SKILL.md");
    const descriptorPath = join(path, "workline-capability.json");
    if (!(await lstat(skillPath)).isFile() || !(await lstat(descriptorPath)).isFile()) {
      return { path, status: "preserved", reason: "archivo enlazado o no regular" };
    }
    const [skill, descriptor] = await Promise.all([readFile(skillPath), readFile(descriptorPath)]);
    if (!known.wrappers.has(sha256(skill)) || sha256(descriptor) !== known.descriptor) {
      return { path, status: "preserved", reason: "contenido editado o propiedad no demostrada" };
    }
    await rm(path, { recursive: true });
    return { path, status: "removed" };
  } catch (error) {
    return {
      path,
      status: "preserved",
      reason: `no se pudo retirar con seguridad: ${(error as Error).message}`,
    };
  }
}
