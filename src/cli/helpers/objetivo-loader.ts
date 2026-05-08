import { readFile } from "node:fs/promises";
import type { ParsedArgs } from "../parser.js";

export async function readObjetivoIfPresent(args: ParsedArgs): Promise<string | undefined> {
  const inline = args.values.get("objetivo");
  if (inline !== undefined) return inline;
  const file = args.values.get("objetivo-file");
  if (file !== undefined) {
    try {
      return await readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}
