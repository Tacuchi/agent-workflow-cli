import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  readWorkspaceBlock,
  requireSourcePath,
} from "../../src/application/parsers/project-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  readWorkspaceLocalConfig,
  writeWorkspaceLocalConfig,
} from "../../src/application/workspace-local-config.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const fs = new NodeFileSystem();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function hub() {
  const root = await mkdtemp(join(tmpdir(), "aw-portable-"));
  roots.push(root);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  await mkdir(paths.cwdRoot());
  return { root, paths };
}

describe("configuración local de fuentes", () => {
  it("ignora local.json en info/exclude sin crear cambios versionados", async () => {
    const { root, paths } = await hub();
    execFileSync("git", ["init", "-q", root]);
    const before = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    await writeWorkspaceLocalConfig(fs, paths, { repo: join(root, "repo") });
    const after = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    expect(after).toBe(before);
    expect(
      execFileSync("git", ["-C", root, "check-ignore", paths.cwdLocalConfigFile()], {
        encoding: "utf8",
      }),
    ).toContain("local.json");
    expect(await fs.exists(join(root, ".gitignore"))).toBe(false);
  });

  it("da prioridad a local.json, conserva sus otras claves y nunca inventa una ruta", async () => {
    const { root, paths } = await hub();
    const actual = join(root, "repo");
    await mkdir(actual);
    await writeFile(
      join(root, "AGENTS.md"),
      [
        paths.blockMarkers().start,
        "## Fuentes",
        "| Alias | Path | Rama principal |",
        "|---|---|---|",
        "| repo | (local) | main |",
        "| falta | (local) | main |",
        "| constructor | (local) | main |",
        paths.blockMarkers().end,
      ].join("\n"),
    );
    await writeFile(
      paths.cwdLocalConfigFile(),
      JSON.stringify({ version: 1, sources: { repo: actual }, custom: "se conserva" }),
    );
    const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
    expect(block?.fuentes[0]?.path).toBe(actual);
    expect(block?.fuentes[0]?.declared_path).toBe("(local)");
    expect(block?.fuentes[1]?.path).toBeNull();
    expect(block?.fuentes[2]?.path).toBeNull();
    const missing = block?.fuentes[1];
    if (!missing) throw new Error("esperaba la fuente falta");
    await expect(requireSourcePath(fs, missing)).rejects.toMatchObject({
      code: "SOURCE_PATH_MISSING",
    });
    await writeWorkspaceLocalConfig(fs, paths, { repo: actual });
    expect((await readWorkspaceLocalConfig(fs, paths.cwdLocalConfigFile())).config?.custom).toBe(
      "se conserva",
    );
  });

  it("un archivo ilegible mantiene todas las fuentes sin resolver y no se sobreescribe", async () => {
    const { root, paths } = await hub();
    const original = "{roto";
    await writeFile(paths.cwdLocalConfigFile(), original);
    await writeFile(
      join(root, "CLAUDE.md"),
      [
        paths.blockMarkers().start,
        "## Fuentes",
        "| Alias | Path | Rama principal |",
        "|---|---|---|",
        "| repo | ../repo | main |",
        paths.blockMarkers().end,
      ].join("\n"),
    );
    const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
    expect(block?.fuentes[0]?.path).toBeNull();
    expect(block?.fuentes[0]?.path_reason).toContain("local.json ilegible");
    await expect(writeWorkspaceLocalConfig(fs, paths, { repo: root })).rejects.toThrow(
      "local.json ilegible",
    );
    expect(await readFile(paths.cwdLocalConfigFile(), "utf8")).toBe(original);
  });
});
