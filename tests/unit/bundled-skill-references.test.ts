import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const source = join(root, "src");

function references(text: string): string[] {
  return [...text.matchAll(/skills\/[\w./-]+\.md/g)].map(([path]) => path);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("referencias literales al bundle desde src/", () => {
  it("cada ruta skills/….md citada existe en el paquete", () => {
    const cited = sourceFiles(source).flatMap((file) => references(readFileSync(file, "utf8")));
    expect(cited).toContain("skills/w/roles/git/ROLE.md");
    expect(cited.filter((path) => !existsSync(join(root, path)))).toEqual([]);
    expect(existsSync(join(root, references('"skills/w/roles/git/no-existe.md"')[0] ?? ""))).toBe(
      false,
    );
  });
});
