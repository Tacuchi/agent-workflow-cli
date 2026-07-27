import { describe, expect, it } from "vitest";
import { parseMdSection, scanMarkdown } from "../../src/application/markdown.js";

// The project documents its own contracts AS Markdown examples, so the line
// between "structure" and "an illustration of structure" is load-bearing: a
// `## Refinement decisions` shown inside a fence used to promote a spec nobody
// refined, and a quoted `### F9` used to inflate the phase count. One scanner
// decides what is semantically visible; these tests pin that decision.

describe("scanMarkdown — what is structure and what is an example of structure", () => {
  it("reads headings outside fences and hides everything inside them", () => {
    const doc = [
      "# Plan 007",
      "",
      "## Solution",
      "",
      "```markdown",
      "## Refinement decisions",
      "### F9 — quoted example",
      "> Estado: validada",
      "```",
      "",
      "## Tasks",
    ].join("\n");

    const scan = scanMarkdown(doc);
    expect(scan.headings.map((h) => h.title)).toEqual(["Plan 007", "Solution", "Tasks"]);
    expect(scan.headings.map((h) => h.level)).toEqual([1, 2, 2]);
    // The raw lines survive untouched — hiding is about meaning, not content.
    expect(scan.lines).toHaveLength(11);
    expect(scan.lines[5]).toBe("## Refinement decisions");
    expect(scan.fenced.slice(4, 9)).toEqual([true, true, true, true, true]);
    expect(scan.fenced[10]).toBe(false);
  });

  it("hides a tilde fence the same way as a backtick one", () => {
    const scan = scanMarkdown(
      ["## Real", "~~~markdown", "## Quoted", "~~~", "## Also real"].join("\n"),
    );
    expect(scan.headings.map((h) => h.title)).toEqual(["Real", "Also real"]);
  });

  it("closes a fence only with its own marker, so a nested example never leaks", () => {
    // The alternating-marker shortcut reopened visibility here and let the
    // inner heading read as real structure.
    const doc = [
      "## Real",
      "````markdown",
      "```",
      "## Quoted inside the inner fence",
      "```",
      "## Quoted inside the outer fence",
      "````",
      "## Also real",
    ].join("\n");
    expect(scanMarkdown(doc).headings.map((h) => h.title)).toEqual(["Real", "Also real"]);
  });

  it("a longer closing marker of the same character closes the block; a shorter one does not", () => {
    const closed = scanMarkdown(["```", "## Quoted", "````", "## Real"].join("\n"));
    expect(closed.headings.map((h) => h.title)).toEqual(["Real"]);
    const unclosed = scanMarkdown(["````", "## Quoted", "```", "## Still quoted"].join("\n"));
    expect(unclosed.headings).toEqual([]);
  });

  it("records the line of each heading so callers can slice the document", () => {
    const scan = scanMarkdown(["intro", "## A", "body", "### B"].join("\n"));
    expect(scan.headings).toEqual([
      { level: 2, title: "A", line: 1 },
      { level: 3, title: "B", line: 3 },
    ]);
  });
});

describe("parseMdSection — boundaries come from the scanner", () => {
  const doc = [
    "# Spec 003",
    "",
    "## Context",
    "the real context",
    "",
    "```markdown",
    "## Decisions",
    "an example, not a section",
    "```",
    "",
    "## Open questions",
    "- one",
  ].join("\n");

  it("a heading quoted inside a fence neither opens nor closes a section", () => {
    // Without this, `## Context` ended at the fenced `## Decisions` line and
    // the example became a section of its own.
    expect(parseMdSection(doc, "Decisions")).toBeUndefined();
    const context = parseMdSection(doc, "Context") ?? "";
    expect(context).toContain("the real context");
    expect(context).toContain("## Decisions"); // the body keeps the example verbatim
  });

  it("the next real heading still closes the section", () => {
    expect(parseMdSection(doc, "Open questions")).toBe("- one");
  });

  it("a deeper heading does not close its parent section", () => {
    const nested = ["## Tasks", "### F1", "- [x] T1.1", "## Validations", "v"].join("\n");
    expect(parseMdSection(nested, "Tasks")).toBe("### F1\n- [x] T1.1");
  });
});
