import { join } from "node:path";

export function sealedPlanPath(sessionDir: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("digest del plan inválido");
  return join(sessionDir, ".plan-seals", `${digest}.md`);
}
