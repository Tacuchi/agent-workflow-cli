import { describe, expect, test } from "vitest";
import { getSkillVersion, parseSkillFrontmatter } from "../../src/domain/skill-frontmatter.js";

describe("parseSkillFrontmatter", () => {
  test("returns null when there is no opening delimiter", () => {
    expect(parseSkillFrontmatter("no frontmatter here\n# title")).toBeNull();
  });

  test("returns null when the frontmatter block is never closed", () => {
    expect(parseSkillFrontmatter("---\nname: foo\nstill open")).toBeNull();
  });

  test("parses simple scalar fields", () => {
    const fm = parseSkillFrontmatter("---\nname: foo\ndescription: bar baz\n---\nbody");
    expect(fm?.fields.name).toBe("foo");
    expect(fm?.fields.description).toBe("bar baz");
  });

  test("folds a block-scalar (>-) value into a single spaced string", () => {
    const text = [
      "---",
      "name: foo",
      "description: >-",
      "  Line one",
      "  line two",
      "  line three",
      "---",
    ].join("\n");
    const fm = parseSkillFrontmatter(text);
    expect(fm?.fields.description).toBe("Line one line two line three");
  });

  test("does NOT capture the block-scalar indicator '>-' as the value (regression)", () => {
    const text = "---\nname: foo\ndescription: >-\n  Real description text.\n---";
    const fm = parseSkillFrontmatter(text);
    expect(fm?.fields.description).not.toBe(">-");
    expect(fm?.fields.description).toBe("Real description text.");
  });

  test("folds blank lines inside a folded block as a paragraph break", () => {
    const text = ["---", "description: >-", "  para one", "", "  para two", "---"].join("\n");
    const fm = parseSkillFrontmatter(text);
    expect(fm?.fields.description).toBe("para one\npara two");
  });

  test("keeps newlines for a literal block-scalar (|)", () => {
    const text = ["---", "description: |", "  line a", "  line b", "---"].join("\n");
    const fm = parseSkillFrontmatter(text);
    expect(fm?.fields.description).toBe("line a\nline b");
  });

  test("captures hyphenated keys like allowed-tools", () => {
    const fm = parseSkillFrontmatter("---\nname: foo\nallowed-tools: Bash(git:*) Read\n---");
    expect(fm?.fields["allowed-tools"]).toBe("Bash(git:*) Read");
  });

  test("parses a nested metadata mapping", () => {
    const text = [
      "---",
      "name: foo",
      "metadata:",
      "  author: acme",
      '  version: "1.2.0"',
      "---",
    ].join("\n");
    const fm = parseSkillFrontmatter(text);
    expect(fm?.metadata.author).toBe("acme");
    expect(fm?.metadata.version).toBe("1.2.0");
  });

  test("strips surrounding quotes from scalar and metadata values", () => {
    const text = ["---", 'name: "foo"', "metadata:", "  version: '1.0'", "---"].join("\n");
    const fm = parseSkillFrontmatter(text);
    expect(fm?.fields.name).toBe("foo");
    expect(fm?.metadata.version).toBe("1.0");
  });

  test("resumes top-level keys after a metadata block ends", () => {
    const text = ["---", "metadata:", "  author: acme", "license: MIT", "---"].join("\n");
    const fm = parseSkillFrontmatter(text);
    expect(fm?.metadata.author).toBe("acme");
    expect(fm?.fields.license).toBe("MIT");
  });

  test("ignores Windows CRLF line endings", () => {
    const fm = parseSkillFrontmatter("---\r\nname: foo\r\ndescription: bar\r\n---\r\n");
    expect(fm?.fields.name).toBe("foo");
    expect(fm?.fields.description).toBe("bar");
  });
});

describe("getSkillVersion", () => {
  test("prefers metadata.version over a legacy top-level version", () => {
    expect(getSkillVersion({ fields: { version: "9.9.9" }, metadata: { version: "1.0.0" } })).toBe(
      "1.0.0",
    );
  });

  test("falls back to the legacy top-level version when metadata.version is absent", () => {
    expect(getSkillVersion({ fields: { version: "2.0.0" }, metadata: {} })).toBe("2.0.0");
  });

  test("returns null when no version is present anywhere", () => {
    expect(getSkillVersion({ fields: {}, metadata: {} })).toBeNull();
  });
});
