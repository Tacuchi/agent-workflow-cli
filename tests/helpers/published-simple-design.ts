import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import {
  buildSimpleProposal,
  resolveSimpleTarget,
} from "../../src/application/design/design-simple-service.js";
import { MemFs } from "./mem-fs.js";

export const SIMPLE_WS = "/ws";
export const SIMPLE_FOLDER = "docs/designs/001-design-alta";

/** Publish three revisions through the production proposal builder. */
export async function publishedSimpleDesign(): Promise<{ fs: MemFs; r1Digest: string }> {
  const fs = new MemFs({ lenient: true });
  let r1Digest = "";
  for (const revision of [1, 2, 3]) {
    const target = resolveSimpleTarget(
      await readDesignIndex(fs, SIMPLE_WS),
      revision === 1 ? "create" : "update",
      {
        title: revision === 1 ? "Alta" : null,
        packageId: revision === 1 ? null : "DES-001",
      },
    );
    if (!target.ok) throw new Error(target.failure.message);
    const built = await buildSimpleProposal(fs, SIMPLE_WS, {
      target: target.value,
      document: `# Alta\n\n## Objetivo\n\nRevisión ${revision}.\n\n## Diseño propuesto\n\nFormulario ${revision}.\n\n## Validación\n\nAlta visible.\n`,
      published: `2026-08-0${revision}`,
    });
    if (!built.ok) throw new Error(built.failures[0]?.message);
    if (revision === 1) r1Digest = built.value.digest;
    for (const artifact of built.value.artifacts)
      fs.file(`${SIMPLE_WS}/${artifact.path}`, artifact.content);
  }
  return { fs, r1Digest };
}
