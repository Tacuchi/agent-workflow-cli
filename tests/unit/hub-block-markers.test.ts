import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_BLOCK_MARKERS,
  type HubBlockMarkers,
  parseHubBlock,
} from "../../src/application/parsers/hub-block.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";

describe("project-block markers — parametric", () => {
  const customMarkers: HubBlockMarkers = {
    start: "<!-- AGENT-WORKFLOW-HUB-START -->",
    end: "<!-- AGENT-WORKFLOW-HUB-END -->",
  };

  it("parser returns null when markers do not match", () => {
    const text = [
      customMarkers.start,
      "## Hub",
      "foo",
      "",
      "## Fuentes",
      "",
      "| a | /p | b |",
      customMarkers.end,
    ].join("\n");
    expect(parseHubBlock(text)).toBeNull();
  });

  it("parser succeeds with explicitly supplied markers", () => {
    const text = [
      customMarkers.start,
      "## Hub",
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
    const parsed = parseHubBlock(text, customMarkers);
    expect(parsed?.proyecto).toBe("foo");
  });

  it("render uses the neutral default markers when none are supplied", () => {
    const out = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    expect(out.startsWith(DEFAULT_HUB_BLOCK_MARKERS.start)).toBe(true);
    expect(out.endsWith(DEFAULT_HUB_BLOCK_MARKERS.end)).toBe(true);
    expect(out).not.toContain("- Histórico:");
    expect(out).not.toContain("Última actividad:");
  });

  it("render and parse keep caller-provided markers", () => {
    const out = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      markers: customMarkers,
      historicoPath: ".agent-workflow/HISTORY.md",
    });
    expect(parseHubBlock(out, customMarkers)?.proyecto).toBe("X");
  });
});
