import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { commandHelpText, globalHelpText } from "../../src/cli/help-groups.js";

const retired = /workline/i;

it("keeps global help and every registered command's help free of the retired name", () => {
  expect(ALL_COMMANDS.length).toBeGreaterThan(30);
  expect(globalHelpText(ALL_COMMANDS, "workflow", { all: true })).not.toMatch(retired);
  for (const command of ALL_COMMANDS) {
    expect(commandHelpText(command), command.name).not.toMatch(retired);
  }
});

it("keeps the emitted error-code catalog free of the retired prefix", async () => {
  const root = resolve("src");
  const codes = new Set<string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "utf8");
    for (const match of text.matchAll(/\bcode\s*(?::|=)\s*["']([A-Z][A-Z_]+)["']/g)) {
      if (match[1]) codes.add(match[1]);
    }
  }
  expect(codes.size).toBeGreaterThan(100);
  expect([...codes].filter((code) => retired.test(code))).toEqual([]);
});
