import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runCheckBranch } from "../../src/application/check-branch-service.js";
import {
  observeScopedFingerprints,
  resolveCheckoutCandidates,
} from "../../src/application/flow/checkout-observation.js";
import { runGenerateLaunch } from "../../src/application/generate-launch-service.js";
import { runGitFlow } from "../../src/application/git-flow-service.js";
import { runBranchCheckHook } from "../../src/application/hook-branch-check.js";
import { runMergeState } from "../../src/application/merge-state-service.js";
import { runMultiroot } from "../../src/application/multiroot-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildProjectTabData } from "../../src/application/project-tab-data.js";
import { getDocsDir } from "../../src/application/release-data/common.js";
import { runSources } from "../../src/application/sources-service.js";
import { runVisibilityDoctor } from "../../src/application/visibility-doctor-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import { fixGitCommand } from "../../src/cli/commands/fix-git.js";
import { setWorkingBranchCommand } from "../../src/cli/commands/set-branch.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { unitPath, workspaceKey } from "../../src/domain/isolation-unit.js";
import type { GitPort } from "../../src/ports/git.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function missingHub() {
  const root = await mkdtemp(join(tmpdir(), "aw-source-missing-"));
  roots.push(root);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  await mkdir(paths.cwdRoot());
  await writeFile(
    join(root, "AGENTS.md"),
    [
      paths.blockMarkers().start,
      "## Fuentes",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      "| remoto | C:/Source/no-presente | main |",
      paths.blockMarkers().end,
    ].join("\n"),
  );
  const git = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("git NO debe correr");
      },
    },
  ) as GitPort;
  return { root, paths, git, fs: new NodeFileSystem(), env: new FakeEnv(root) };
}

it("sources informa el alias ausente sin consultar git en el cwd", async () => {
  const { paths, fs, env, git } = await missingHub();
  const result = await runSources(fs, env, git, paths, {
    verbose: true,
  });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]?.error).toContain("la ruta de la fuente remoto no existe en este host");
  expect(result.sources[0]?.error_code).toBe("SOURCE_PATH_MISSING");
  expect(result.sources[0]?.error).toContain("aw add-source remoto:<ruta>");
});

it("sources y worktree list consultan la ruta local de una celda (local)", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-local-hub-"));
  const repo = await mkdtemp(join(tmpdir(), "aw-local-repo-"));
  roots.push(root, repo);
  const fs = new NodeFileSystem();
  const env = new FakeEnv(root);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  await mkdir(paths.cwdSessionsDir(), { recursive: true });
  await writeFile(
    join(root, "AGENTS.md"),
    [
      paths.blockMarkers().start,
      "## Fuentes",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      "| repo | (local) | main |",
      paths.blockMarkers().end,
    ].join("\n"),
  );
  await writeFile(paths.cwdLocalConfigFile(), JSON.stringify({ version: 1, sources: { repo } }));
  const calls: string[] = [];
  const git = {
    isGitRepo: async (path: string) => {
      calls.push(path);
      return true;
    },
    currentBranch: async (path: string) => {
      calls.push(path);
      return "main";
    },
    changedFiles: async (path: string) => {
      calls.push(path);
      return [];
    },
    worktreeList: async (path: string) => {
      calls.push(path);
      return [];
    },
  } as GitPort;
  const sources = await runSources(fs, env, git, paths, { verbose: true });
  expect(sources.sources[0]?.path).toBe(repo);
  const listed = await runWorktree({ fs, env, git, paths }, { action: "list" });
  if ("error" in listed) throw new Error(listed.error);
  expect(listed.unreadable).toEqual([]);
  expect(calls).toEqual([repo, repo, repo, repo, repo]);
});

it("fix-git --source rehúsa la fuente ausente antes de consultar git", async () => {
  const { fs, env, git, paths } = await missingHub();
  const args: ParsedArgs = {
    rest: ["prepare"],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map([["source", ["remoto"]]]),
  };
  const result = await fixGitCommand.execute(args, { fs, env, git, paths } as CliContext);
  expect(result.error?.code).toBe("SOURCE_PATH_MISSING");
  expect(result.error?.message).toContain("la ruta de la fuente remoto no existe en este host");
  const explicitPath: ParsedArgs = {
    ...args,
    valuesMulti: new Map([["path", ["C:/Source/no-presente"]]]),
  };
  const byPath = await fixGitCommand.execute(explicitPath, { fs, env, git, paths } as CliContext);
  expect(byPath.error?.code).toBe("SOURCE_PATH_MISSING");
});

it("set-working-branch no inicia git ni guarda una rama si falta la ruta", async () => {
  const { fs, env, git, paths } = await missingHub();
  const args: ParsedArgs = {
    rest: ["remoto", "feature/x"],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
  const result = await setWorkingBranchCommand.execute(args, { fs, env, git, paths } as CliContext);
  expect(result.error?.code).toBe("SOURCE_PATH_MISSING");
});

it("la observación del checkout no acredita una unidad si su fuente ya no resuelve", async () => {
  const { fs, git, paths } = await missingHub();
  const session = "103-una-plan-exec";
  await mkdir(paths.userUnitsDir(), { recursive: true });
  const unit = unitPath(await fs.realPath(paths.userUnitsDir()), {
    workspaceKey: workspaceKey(paths.workspaceDir()),
    alias: "remoto",
    session,
  });
  await mkdir(unit, { recursive: true });
  const candidates = await resolveCheckoutCandidates(fs, paths, session);
  expect(candidates.map((candidate) => candidate.source)).not.toContain("remoto");
  const result = await observeScopedFingerprints(fs, git, paths, session, ["remoto"]);
  expect(result).toMatchObject({ ok: false, failure: { code: "SOURCE_PATH_MISSING" } });
});

it("el hook avisa sin bloquear la edición de la unidad de una fuente ausente", async () => {
  const { root, fs, env, git, paths } = await missingHub();
  const session = "103-una-plan-exec";
  await mkdir(paths.userUnitsDir(), { recursive: true });
  const unit = unitPath(await fs.realPath(paths.userUnitsDir()), {
    workspaceKey: workspaceKey(root),
    alias: "remoto",
    session,
  });
  await mkdir(unit, { recursive: true });
  const input = (path: string) =>
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path } });
  const notice = await runBranchCheckHook({
    stdin: input(join(unit, "src", "file.ts")),
    fs,
    env,
    git,
    paths,
  });
  expect(notice.exitCode).toBe(0);
  expect(notice.stderr).toContain("la ruta de la fuente remoto no existe en este host");
  const unrelated = await runBranchCheckHook({
    stdin: input(join(root, "docs", "note.md")),
    fs,
    env,
    git,
    paths,
  });
  expect(unrelated.exitCode).toBe(0);
});

it("los lectores y comandos de fuente rehúsan la ruta ausente por alias sin invocar git", async () => {
  const { root, fs, env, git, paths } = await missingHub();
  const branch = await runCheckBranch(fs, env, git, paths, { alias: "remoto" });
  expect(branch).toMatchObject({ alias: "remoto", reason: "SOURCE_PATH_MISSING", match: false });

  const flow = await runGitFlow(fs, git, paths, { action: "sync", source: "remoto" });
  expect(flow.results[0]).toMatchObject({ source: "remoto", error_code: "SOURCE_PATH_MISSING" });

  const merge = await runMergeState(fs, git, env, paths, { source: "remoto" });
  expect(merge.repos[0]).toMatchObject({ alias: "remoto", error_code: "SOURCE_PATH_MISSING" });

  await expect(getDocsDir(fs, root, paths, "remoto")).rejects.toMatchObject({
    code: "SOURCE_PATH_MISSING",
  });

  const launch = await runGenerateLaunch(fs, env, paths, { aliases: ["remoto"], dryRun: true });
  expect(launch).toMatchObject({
    ok: false,
    unreadable_sources: [{ alias: "remoto", code: "SOURCE_PATH_MISSING" }],
  });

  const multiroot = await runMultiroot(fs, env, paths, "attach", {
    fromSources: true,
    dryRun: true,
  });
  expect(multiroot).toMatchObject({
    error: "SOURCE_PATH_MISSING",
    hint: expect.stringContaining("remoto"),
  });

  const visibility = await runVisibilityDoctor(fs, env, paths, { workspace: root });
  expect(visibility.reports[0]?.status).toBe("source-path-missing");
  expect(visibility.unreadable_sources?.[0]).toContain("aw add-source remoto:<ruta>");

  const proc = {
    run: async () => {
      throw new Error("proc NO debe correr");
    },
  } as unknown as ProcessPort;
  const project = await buildProjectTabData({ fs, env, git, process: proc, paths });
  expect(project.git).toBeNull();
  expect(project.sources[0]?.error).toContain("la ruta de la fuente remoto no existe en este host");
});
