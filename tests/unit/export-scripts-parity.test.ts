import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCRIPTS_FINAL_STATE_CONTRACT,
  SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS,
} from "../../src/application/export-service.js";

const DIRECT_GUIDE = fileURLToPath(
  new URL("../../skills/w/commands/export-scripts.md", import.meta.url),
);

describe("export-scripts — paridad entre guía directa y contrato generado", () => {
  it("mantiene los anclajes del estado final neto en ambas superficies", async () => {
    const guide = await readFile(DIRECT_GUIDE, "utf8");
    for (const anchor of SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS) {
      expect(SCRIPTS_FINAL_STATE_CONTRACT, anchor).toContain(anchor);
      expect(guide, anchor).toContain(anchor);
    }
  });
});
