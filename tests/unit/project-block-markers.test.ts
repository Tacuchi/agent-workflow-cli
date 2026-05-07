import { describe, expect, it } from "vitest";
import {
  LEGACY_QTC_MARKERS,
  type ProjectBlockMarkers,
  parseProjectBlock,
} from "../../src/application/parsers/project-block.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";

describe("project-block markers — parametric", () => {
  const customMarkers: ProjectBlockMarkers = {
    start: "<!-- AGENT-WORKFLOW-PROJECT-START -->",
    end: "<!-- AGENT-WORKFLOW-PROJECT-END -->",
  };

  it("parser returns null when default markers are used but text has custom", () => {
    const text = `${customMarkers.start}\n## Proyecto\nfoo\n\n## Fuentes\n\n| a | /p | b |\n${customMarkers.end}`;
    expect(parseProjectBlock(text)).toBeNull(); // default = LEGACY_QTC_MARKERS
  });

  it("parser succeeds with custom markers when passed", () => {
    const text = `${customMarkers.start}\n## Proyecto\nfoo\n\n## Fuentes\n\n| Alias | Path | Rama principal |\n|---|---|---|\n| a | /p | b |\n\n## Stack\n\n_Stack sin detectar._\n\n## Status\n\n- Sesiones activas: _ninguna_\n- Última actividad: 2026-01-01 00:00\n- Histórico: \`.x/HISTORY.md\`\n${customMarkers.end}`;
    const parsed = parseProjectBlock(text, customMarkers);
    expect(parsed).not.toBeNull();
    expect(parsed?.proyecto).toBe("foo");
  });

  it("render uses default LEGACY_QTC_MARKERS when no markers provided", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      sessions: [],
      lastActivity: "2026-01-01 00:00",
    });
    expect(out.startsWith(LEGACY_QTC_MARKERS.start)).toBe(true);
    expect(out.endsWith(LEGACY_QTC_MARKERS.end)).toBe(true);
    expect(out).toContain("- Histórico: `.workflow/HISTORY.md`");
  });

  it("render uses custom markers + historicoPath when provided", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      sessions: [],
      lastActivity: "2026-01-01 00:00",
      markers: customMarkers,
      historicoPath: ".agent-workflow/HISTORY.md",
    });
    expect(out.startsWith(customMarkers.start)).toBe(true);
    expect(out.endsWith(customMarkers.end)).toBe(true);
    expect(out).toContain("- Histórico: `.agent-workflow/HISTORY.md`");
  });

  it("back-compat read: parses legacy QTC-PROJECT markers when current namespace markers passed", () => {
    const workflowMarkers: ProjectBlockMarkers = {
      start: "<!-- WORKFLOW-PROJECT-START -->",
      end: "<!-- WORKFLOW-PROJECT-END -->",
    };
    const text = `${LEGACY_QTC_MARKERS.start}\n## Proyecto\nlegacy-test\n\n## Fuentes\n\n| Alias | Path | Rama principal |\n|---|---|---|\n| a | /p | b |\n\n## Stack\n\n_Stack sin detectar._\n\n## Status\n\n- Sesiones activas: _ninguna_\n- Última actividad: 2026-01-01 00:00\n- Histórico: \`.qtc/HISTORY.md\`\n${LEGACY_QTC_MARKERS.end}`;
    const parsed = parseProjectBlock(text, workflowMarkers);
    expect(parsed).not.toBeNull();
    expect(parsed?.proyecto).toBe("legacy-test");
    expect(parsed?.fuentes).toHaveLength(1);
  });

  it("back-compat read: still returns null when neither set of markers matches", () => {
    const workflowMarkers: ProjectBlockMarkers = {
      start: "<!-- WORKFLOW-PROJECT-START -->",
      end: "<!-- WORKFLOW-PROJECT-END -->",
    };
    const text = `${customMarkers.start}\n## Proyecto\nfoo\n${customMarkers.end}`;
    const parsed = parseProjectBlock(text, workflowMarkers);
    expect(parsed).toBeNull();
  });

  it("back-compat read: current markers take precedence over legacy when both present in text", () => {
    const workflowMarkers: ProjectBlockMarkers = {
      start: "<!-- WORKFLOW-PROJECT-START -->",
      end: "<!-- WORKFLOW-PROJECT-END -->",
    };
    const text = `${workflowMarkers.start}\n## Proyecto\ncurrent\n\n## Fuentes\n\n| Alias | Path | Rama principal |\n|---|---|---|\n| w | /pw | bw |\n\n## Stack\n\n_Stack sin detectar._\n\n## Status\n\n- Sesiones activas: _ninguna_\n- Histórico: \`.workflow/HISTORY.md\`\n${workflowMarkers.end}\n\n${LEGACY_QTC_MARKERS.start}\n## Proyecto\nlegacy\n${LEGACY_QTC_MARKERS.end}`;
    const parsed = parseProjectBlock(text, workflowMarkers);
    expect(parsed?.proyecto).toBe("current");
  });
});
