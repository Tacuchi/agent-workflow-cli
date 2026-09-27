import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import { workspaceInitCommand } from "../../src/cli/commands/workspace-init.js";
import { parseArgv } from "../../src/cli/parser.js";
import { renderHumanError } from "../../src/cli/render.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

let root: string;
let paths: PathsService;
let env: FakeEnv;
const fs = new NodeFileSystem();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-project-pair-"));
  paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
  env = new FakeEnv(root, root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("si falla el segundo archivo al publicarse, los dos vuelven byte a byte a su contenido anterior", async () => {
  const initial = await runProjectMdUpsertWrite(fs, env, paths, {
    op: "init",
    proyecto: "Anterior",
  });
  expect("error" in initial).toBe(false);
  const claude = join(root, "CLAUDE.md");
  const agents = join(root, "AGENTS.md");
  const before = await Promise.all([readFile(claude, "utf8"), readFile(agents, "utf8")]);
  let failed = false;
  const injected: FileSystemPort = new Proxy(fs, {
    get(target, property) {
      if (property === "writeText") {
        return async (path: string, content: string) => {
          if (path === agents && !failed) {
            failed = true;
            throw new Error("fallo inyectado en AGENTS.md");
          }
          return target.writeText(path, content);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const output = await runProjectMdUpsertWrite(injected, env, paths, {
    op: "init",
    proyecto: "Nuevo",
    verbose: true,
  });
  expect("error" in output).toBe(false);
  if ("error" in output) throw new Error(output.error);
  expect(output.ok).toBe(false);
  expect(output.results?.map((item) => item.action)).toEqual([undefined, undefined]);
  expect(output.results?.every((item) => item.error?.includes("revertida"))).toBe(true);
  expect(await Promise.all([readFile(claude, "utf8"), readFile(agents, "utf8")])).toEqual(before);

  failed = false;
  const command = await workspaceInitCommand.execute(
    parseArgv(["workspace-init", "--source", `core:${root}:main`, "--proyecto", "Otro"]),
    { fs: injected, rawFs: injected, env, paths } as CliContext,
  );
  expect(command.ok).toBe(false);
  const human = renderHumanError(command.error, command.data);
  expect(human).toContain("CLAUDE.md: revertido");
  expect(human).toContain("AGENTS.md: revertido");
  expect(human).toContain(`· ${claude}`);
  expect(human).toContain("fuente core:");
});

it("sin HISTORY dos escrituras con tiempo distinto son idénticas; con HISTORY usa el namespace real", async () => {
  const first = await runProjectMdUpsertWrite(fs, env, paths, {
    op: "init",
    proyecto: "Mi proyecto",
    lastActivity: "2026-01-01 00:00",
  });
  expect("error" in first).toBe(false);
  const claude = join(root, "CLAUDE.md");
  const before = await readFile(claude, "utf8");
  expect(before).not.toContain("Última actividad:");
  expect(before).not.toContain("Histórico:");
  const second = await runProjectMdUpsertWrite(fs, env, paths, {
    op: "init",
    lastActivity: "2026-12-31 23:59",
    verbose: true,
  });
  if ("error" in second) throw new Error(second.error);
  expect(second.results?.map((item) => item.action)).toEqual(["unchanged", "unchanged"]);
  expect(await readFile(claude, "utf8")).toBe(before);

  await fs.writeText(paths.cwdHistoryFile(), "# HISTORY\n");
  await runProjectMdUpsertWrite(fs, env, paths, { op: "init" });
  const after = await readFile(claude, "utf8");
  expect(after).toContain("- Histórico: `.agent-workflow/HISTORY.md`");
  expect(after).not.toContain("Última actividad:");
});
