import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkRecordPrecondition } from "../../src/application/design/design-record-service.js";
import { computeSourceDigest } from "../../src/domain/design/rendition.js";
import { MemFs } from "../helpers/mem-fs.js";

const WS = "/ws";
const PKG = `${WS}/docs/designs/001-design-alta`;
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

function packageWithRendition(): MemFs {
  const screen = fixture("SCR-001-r002-formulario-alta.md");
  const sha256 = `sha256:${createHash("sha256").update(screen).digest("hex")}`;
  const source = { ref: "DES-001/SCR-001@r1#default", sha256 };
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
  const rendition = JSON.parse(fixture("rendition-VIS-001-r001.json")) as Record<string, unknown>;
  rendition.sources = [source];
  rendition.source_digest = computeSourceDigest([source]);
  const fs = new MemFs();
  fs.file(`${PKG}/design-manifest.json`, JSON.stringify(manifest));
  fs.file(`${PKG}/screens/SCR-001-r001-formulario-alta.md`, screen);
  fs.file(
    `${PKG}/renditions/VIS-001-r001-formulario-alta/rendition.json`,
    JSON.stringify(rendition),
  );
  return fs;
}

describe("sonda T4.1 — record verifica renditions reales y referencias a estados", () => {
  it("una rendition vigente con ancla no está obsoleta", async () => {
    const result = await checkRecordPrecondition(packageWithRendition(), WS, "DES-001");
    expect(result.failures).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("alterar la pantalla después del corte vuelve obsoleta su rendition", async () => {
    const fs = packageWithRendition();
    fs.file(`${PKG}/screens/SCR-001-r001-formulario-alta.md`, "pantalla alterada\n");
    const result = await checkRecordPrecondition(fs, WS, "DES-001");
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual(["VIS-001"]);
    expect(result.failures[0]?.code).toBe("DESIGN_RENDITION_STALE");
  });
});
