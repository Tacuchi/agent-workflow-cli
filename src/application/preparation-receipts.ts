import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { acquireLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";

interface Receipt {
  digest: string;
  root: string;
  verb: string;
  at: number;
}
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function fileOf(paths: PathsService): string {
  return join(paths.userRoot(), "preparation-receipts.json");
}

async function readReceipts(paths: PathsService): Promise<Receipt[]> {
  try {
    const value: unknown = JSON.parse(await readFile(fileOf(paths), "utf8"));
    if (!Array.isArray(value)) throw new Error("formato desconocido");
    return value.filter(
      (r): r is Receipt =>
        r !== null &&
        typeof r === "object" &&
        typeof r.digest === "string" &&
        typeof r.root === "string" &&
        typeof r.verb === "string" &&
        typeof r.at === "number",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Recibos de preparación ilegibles: ${String(error)}`);
  }
}

export async function recordPreparation(
  fs: FileSystemPort,
  paths: PathsService,
  verb: string,
  digest: string,
): Promise<void> {
  const file = fileOf(paths);
  const lock = await acquireLock(`${file}.lock`, fs, { waitMs: 1000 });
  try {
    const now = Date.now();
    const receipts = (await readReceipts(paths)).filter(
      (r) =>
        now - r.at < MAX_AGE &&
        !(r.verb === verb && r.digest === digest && r.root === paths.hubDir()),
    );
    receipts.push({ verb, digest, root: paths.hubDir(), at: now });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(receipts)}\n`, { flag: "wx" });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  } finally {
    await lock.release();
  }
}

export async function preparationMismatch(
  paths: PathsService,
  verb: string,
  digest: string,
): Promise<string | null> {
  const receipts = (await readReceipts(paths)).filter(
    (r) => r.verb === verb && r.digest === digest,
  );
  if (receipts.some((r) => r.root === paths.hubDir())) return null;
  const receipt = receipts.at(-1);
  return receipt
    ? `HUB_MISMATCH: preparado en ${receipt.root}; hub actual ${paths.hubDir()}.`
    : null;
}
