import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachCodex, codexConfigPath } from "../../src/application/multiroot/codex.js";

describe("attachCodex — TOML válido cross-platform", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "codex-attach-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  // Regression: double quotes broke on Windows (`"C:\Source"` → `\S` is not a
  // valid TOML escape). Single-quoted literals escape nothing.
  it("escribe additional_writable_roots con literales de comilla simple", () => {
    attachCodex(["C:\\Source\\app", "C:\\Source\\otro"], scopeDir);
    const text = readFileSync(codexConfigPath(scopeDir), "utf-8");

    const block = text.match(/additional_writable_roots\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    expect(block).toMatch(/'[^']+'/); // single-quoted literals present
    expect(block).not.toMatch(/"/); // and none double-quoted

    // The whole file parses with the same parser Codex/the doctor uses.
    expect(() => parseToml(text)).not.toThrow();
    const parsed = parseToml(text) as { additional_writable_roots?: string[] };
    expect(parsed.additional_writable_roots).toHaveLength(2);
  });
});
