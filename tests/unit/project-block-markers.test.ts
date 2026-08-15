import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_BLOCK_MARKERS,
  type ProjectBlockMarkers,
  parseProjectBlock,
} from "../../src/application/parsers/project-block.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";

describe("project-block markers — parametric", () => {
  const customMarkers: ProjectBlockMarkers = {
    start: "<!-- AGENT-WORKFLOW-PROJECT-START -->",
    end: "<!-- AGENT-WORKFLOW-PROJECT-END -->",
  };

  it("parser returns null when markers do not match", () => {
    const text = [
      customMarkers.start,
      "## Proyecto",
      "foo",
      "",
      "## Fuentes",
      "",
      "| a | /p | b |",
      customMarkers.end,
    ].join("\n");
    expect(parseProjectBlock(text)).toBeNull();
  });

  it("parser succeeds with explicitly supplied markers", () => {
    const text = [
      customMarkers.start,
      "## Proyecto",
      "foo",
      "",
      "## Fuentes",
      "",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      "| a | /p | b |",
      "",
      "## Stack",
      "",
      "_Stack sin detectar._",
      "",
      "## Status",
      "",
      "- Última actividad: 2026-01-01 00:00",
      "- Histórico: `.agent-workflow/HISTORY.md`",
      customMarkers.end,
    ].join("\n");
    const parsed = parseProjectBlock(text, customMarkers);
    expect(parsed?.proyecto).toBe("foo");
  });

  it("render uses the neutral default markers when none are supplied", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    expect(out.startsWith(DEFAULT_PROJECT_BLOCK_MARKERS.start)).toBe(true);
    expect(out.endsWith(DEFAULT_PROJECT_BLOCK_MARKERS.end)).toBe(true);
    expect(out).toContain("- Histórico: `.workflow/HISTORY.md`");
  });

  it("render and parse keep caller-provided markers", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      markers: customMarkers,
      historicoPath: ".agent-workflow/HISTORY.md",
    });
    expect(parseProjectBlock(out, customMarkers)?.proyecto).toBe("X");
  });
});
