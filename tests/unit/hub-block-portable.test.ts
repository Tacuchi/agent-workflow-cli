import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  previewHubBlockUpsert,
  runHubBlockUpsertWrite,
} from "../../src/application/hub-block-upsert-service.js";
import { readHubBlock } from "../../src/application/parsers/hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("migración por máquina de la tabla Fuentes", () => {
  it("migra sólo las rutas existentes, mantiene la ruta remota y no escribe en vista previa", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-hub-migrate-"));
    roots.push(root);
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const fs = new NodeFileSystem();
    const env = new FakeEnv(root);
    const nested = join(root, "nested");
    await mkdir(nested);
    const external = await mkdtemp(join(tmpdir(), "aw-hub-source-"));
    roots.push(external);
    await mkdir(paths.cwdRoot());
    const original = [
      paths.blockMarkers().start,
      "## Hub",
      "hub",
      "## Fuentes",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      `| nested | ${nested} | main |`,
      `| external | ${external} | main |`,
      "| windows | C:/Source/windows | main |",
      paths.blockMarkers().end,
    ].join("\n");
    await writeFile(join(root, "CLAUDE.md"), original);
    const input = { op: "init" as const, proyecto: "hub", verbose: true };
    const preview = await previewHubBlockUpsert(fs, env, paths, input);
    expect(preview.migrated).toEqual(["nested", "external"]);
    expect(preview.not_migrated).toEqual(["windows"]);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(original);
    expect(await fs.exists(paths.cwdLocalConfigFile())).toBe(false);
    await runHubBlockUpsertWrite(fs, env, paths, input);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(original);
    const block = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(block).toContain("| nested | nested | main |");
    expect(block).toContain("| external | (local) | main |");
    expect(block).toContain("| windows | C:/Source/windows | main |");
    const local = JSON.parse(await readFile(paths.cwdLocalConfigFile(), "utf8"));
    expect(local.sources.external).toBe(external);
  });

  it("conserva una relativa declarada y una absoluta ajena aunque haya entradas locales", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-hub-local-precedence-"));
    roots.push(root);
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const fs = new NodeFileSystem();
    await mkdir(paths.cwdRoot());
    const override = join(root, "override");
    await mkdir(override);
    await writeFile(
      paths.cwdLocalConfigFile(),
      JSON.stringify({ version: 1, sources: { mac: override, windows: override } }),
    );
    const original = [
      paths.blockMarkers().start,
      "## Fuentes",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      "| mac | ../declarada | main |",
      "| windows | C:/Source/windows | main |",
      paths.blockMarkers().end,
    ].join("\n");
    await writeFile(join(root, "AGENTS.md"), original);
    const result = await runHubBlockUpsertWrite(fs, new FakeEnv(root), paths, { op: "init" });
    if ("error" in result) throw new Error(result.error);
    expect(result.not_migrated).toEqual(["windows"]);
    const rewritten = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(rewritten).toContain("| mac | ../declarada | main |");
    expect(rewritten).toContain("| windows | C:/Source/windows | main |");
    expect(
      (await readHubBlock(fs, root, paths.blockMarkers()))?.fuentes.map((f) => f.path),
    ).toEqual([override, override]);
    expect(JSON.parse(await readFile(paths.cwdLocalConfigFile(), "utf8")).sources.windows).toBe(
      override,
    );
  });

  it("normaliza el marcador (local) reescrito por una CLI antigua", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-hub-legacy-local-"));
    roots.push(root);
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const fs = new NodeFileSystem();
    const old = [
      paths.blockMarkers().start,
      "## Fuentes",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      `| repo | ${join(root, "(local)")} | main |`,
      paths.blockMarkers().end,
    ].join("\n");
    await writeFile(join(root, "AGENTS.md"), old);
    const block = await readHubBlock(fs, root, paths.blockMarkers());
    expect(block?.fuentes[0]?.path).toBeNull();
    expect(block?.fuentes[0]?.declared_path).toBe(join(root, "(local)"));
  });
});
