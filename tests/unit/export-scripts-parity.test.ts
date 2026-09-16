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
const AUTHORING_MANUAL = fileURLToPath(
  new URL("../../skills/w/exports/export-scripts/EXPORT.md", import.meta.url),
);
/** Documented for a long time, accepted by the CLI never. */
const NEVER_EXISTED = ["--skip-standalone", "--dry-run"];

describe("export-scripts — paridad entre guía directa y contrato generado", () => {
  it("mantiene los anclajes del estado final neto en ambas superficies", async () => {
    const guide = await readFile(DIRECT_GUIDE, "utf8");
    for (const anchor of SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS) {
      expect(SCRIPTS_FINAL_STATE_CONTRACT, anchor).toContain(anchor);
      expect(guide, anchor).toContain(anchor);
    }
  });

  // The reconciliation between bundles is the one anchor whose whole job is to
  // be followed while composing, so the manual that is read while composing has
  // to carry it too — a contract the author never sees is a contract nobody applies.
  it("la reconciliación entre bundles también está en el manual de autoría", async () => {
    const manual = await readFile(AUTHORING_MANUAL, "utf8");
    expect(manual).toContain("MATERIAL A RECONCILIAR");
  });

  /**
   * The drift this guards against was real: the manual documented
   * `--skip-standalone` and `--dry-run` for versions, and the CLI accepted
   * neither. A flag that only the doctrine believes in costs whoever follows it
   * a failed invocation, and there is no test that would have caught it.
   */
  it("la doctrina no documenta argumentos que el comando no acepta", async () => {
    const guide = await readFile(DIRECT_GUIDE, "utf8");
    const manual = await readFile(AUTHORING_MANUAL, "utf8");
    const usage = /```\n(\/w:export-scripts[\s\S]*?)```/.exec(manual)?.[1];

    expect(usage, "el manual publica su bloque de uso").toBeDefined();
    for (const flag of NEVER_EXISTED) {
      expect(usage, flag).not.toContain(flag);
      expect(guide, flag).not.toContain(flag);
    }
  });
});
