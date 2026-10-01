import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const loader = resolve("tests/helpers/deny-flow-loader.mjs");

describe("TUI y Git directo sin motor de flujos", () => {
  it("los dos servicios compartidos no importan el motor ni el módulo de unidades", () => {
    const resolver = readFileSync(resolve("src/application/branch-resolver.ts"), "utf8");
    const gitFlow = readFileSync(resolve("src/application/git-flow-service.ts"), "utf8");
    expect(resolver).not.toMatch(/from ["'].*isolation-unit/);
    expect(gitFlow).not.toMatch(/from ["'].*hub-materialization-service/);
  });

  it("el componente principal y el servicio git-flow cargan sin sesiones ni decisiones internas", () => {
    const code = `const [{ App }, { runGitFlow }] = await Promise.all([
      import(${JSON.stringify(new URL("../../dist/cli/tui/app.js", import.meta.url).href)}),
      import(${JSON.stringify(new URL("../../dist/application/git-flow-service.js", import.meta.url).href)})
    ]);
    if (typeof App !== "function" || typeof runGitFlow !== "function") process.exit(2);
    process.stdout.write("TUI_GIT_READY");`;
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-loader", loader, "--input-type=module", "-e", code],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("TUI_GIT_READY");
  });
});
