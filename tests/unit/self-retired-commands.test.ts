import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

it("los dos instaladores ajenos retirados fallan en HOME aislado y conservan skills y registro", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-retired-installers-"));
  try {
    const home = join(root, "home");
    const foreign = join(home, ".agents", "skills", "foreign", "SKILL.md");
    const registry = join(home, ".agents", ".skills-registry.json");
    mkdirSync(join(home, ".agents", "skills", "foreign"), { recursive: true });
    const skillBytes = "---\nname: foreign\ndescription: previous installation\n---\n";
    const registryBytes = '{"skills":{"foreign":{"source":"own"}}}\n';
    writeFileSync(foreign, skillBytes);
    writeFileSync(registry, registryBytes);
    for (const command of ["install-plugin-skills", "install-plugin-skills-git"]) {
      const result = spawnSync(process.execPath, [cli, "self", command, "--format", "json"], {
        cwd: root,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      expect(result.status, command).toBe(1);
      expect(result.stdout + result.stderr).toContain("INVALID_INPUT");
      expect(readFileSync(foreign, "utf8")).toBe(skillBytes);
      expect(readFileSync(registry, "utf8")).toBe(registryBytes);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
