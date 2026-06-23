import { describe, expect, it } from "vitest";
import { parseProjectBlock } from "../../src/application/parsers/project-block.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { parseFuentesSpecs } from "../../src/cli/parsers/fuentes.js";

// Regression guard for the Windows path-corruption report: a `C:\Source\…` path
// must survive `--source` parsing AND the Fuentes table render→parse round-trip
// with its backslashes intact. (Confirms the CLI itself never strips `\`; any
// corruption seen in the field entered before argv — e.g. shell escaping.)
const WIN = "C:\\Source\\core-frontend-miscuotas";

describe("Windows backslash paths — Fuentes round-trip", () => {
  it("parseFuentesSpecs keeps the backslashes and splits drive-colon vs rama-colon", () => {
    const r = parseFuentesSpecs([`miscuotas:${WIN}:feature/rrhh-colaboradores`]);
    expect("fuentes" in r).toBe(true);
    if ("fuentes" in r) {
      expect(r.fuentes[0]?.path).toBe(WIN);
      expect(r.fuentes[0]?.mainBranch).toBe("feature/rrhh-colaboradores");
    }
  });

  it("render → parse keeps the backslash path unchanged", () => {
    const block = renderProjectBlock({
      proyecto: "demo",
      fuentes: [{ alias: "miscuotas", path: WIN, main_branch: "main" }],
      stack: {},
      lastActivity: "2026-06-23 00:00",
    });
    expect(block).toContain(WIN);
    const parsed = parseProjectBlock(block);
    expect(parsed?.fuentes[0]?.path).toBe(WIN);
  });
});
