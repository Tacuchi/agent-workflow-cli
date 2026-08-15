import { describe, expect, it } from "vitest";
import { isValidNamespace, normalizeNamespace } from "../../src/runtime/namespace.js";

describe("namespace validation", () => {
  it("accepts kebab-case lowercase 2-31 chars starting with letter", () => {
    expect(isValidNamespace("legacy")).toBe(true);
    expect(isValidNamespace("agent-workflow")).toBe(true);
    expect(isValidNamespace("ab")).toBe(true);
    expect(isValidNamespace("a")).toBe(false); // single char rejected
  });

  it("rejects uppercase, underscore, leading digit, special chars, traversal", () => {
    expect(isValidNamespace("LEGACY")).toBe(false);
    expect(isValidNamespace("agent_workflow")).toBe(false);
    expect(isValidNamespace("1ns")).toBe(false);
    expect(isValidNamespace("ns!")).toBe(false);
    expect(isValidNamespace("../escape")).toBe(false);
    expect(isValidNamespace("")).toBe(false);
  });

  it("normalizeNamespace returns trimmed input or throws", () => {
    expect(normalizeNamespace(" legacy ")).toBe("legacy");
    expect(() => normalizeNamespace("BAD")).toThrow(/Invalid namespace/);
    expect(() => normalizeNamespace("")).toThrow(/Invalid namespace/);
  });
});
