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
import { runGitFlow } from "../../src/application/git-flow-service.js";
import { buildHubTabData } from "../../src/application/hub-tab-data.js";
import { runMergeState } from "../../src/application/merge-state-service.js";
import { runMultiroot } from "../../src/application/multiroot-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { getDocsDir } from "../../src/application/release-data/common.js";
import { runResume } from "../../src/application/resume-service.js";
import { runSources } from "../../src/application/sources-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { runVisibilityDoctor } from "../../src/application/visibility-doctor-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import { resumeCommand } from "../../src/cli/commands/resume.js";
import { setWorkingBranchCommand } from "../../src/cli/commands/set-branch.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { hubKey, unitPath } from "../../src/domain/isolation-unit.js";
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
    hubKey: hubKey(paths.hubDir()),
    alias: "remoto",
    session,
  });
  await mkdir(unit, { recursive: true });
  const candidates = await resolveCheckoutCandidates(fs, paths, session);
  expect(candidates.map((candidate) => candidate.source)).not.toContain("remoto");
  const result = await observeScopedFingerprints(fs, git, paths, session, ["remoto"]);
  expect(result).toMatchObject({ ok: false, failure: { code: "SOURCE_PATH_MISSING" } });
});

it("los lectores y comandos de fuente rehúsan la ruta ausente por alias sin invocar git", async () => {
  const { root, fs, env, git, paths } = await missingHub();
  const branch = await runCheckBranch(fs, env, git, paths, { alias: "remoto" });
  expect(branch).toMatchObject({ alias: "remoto", reason: "SOURCE_PATH_MISSING", match: false });

  const flow = await runGitFlow(fs, git, paths, { action: "sync", source: "remoto" });
  expect(flow.results[0]).toMatchObject({ source: "remoto", error_code: "SOURCE_PATH_MISSING" });

  const merge = await runMergeState(fs, git, env, paths, { source: "remoto" });
  expect(merge.repos).toEqual([]);
  expect(merge.unreadable[0]).toMatchObject({
    alias: "remoto",
    code: "SOURCE_PATH_MISSING",
    action: expect.stringContaining("aw add-source remoto:<ruta>"),
  });

  await expect(getDocsDir(fs, root, paths, "remoto")).rejects.toMatchObject({
    code: "SOURCE_PATH_MISSING",
  });

  const multiroot = await runMultiroot(fs, env, paths, "attach", {
    fromSources: true,
    dryRun: true,
  });
  expect(multiroot).toMatchObject({
    error: "SOURCE_PATH_MISSING",
    hint: expect.stringContaining("remoto"),
  });

  const visibility = await runVisibilityDoctor(fs, env, paths, { hub: root });
  expect(visibility.reports[0]?.status).toBe("source-path-missing");
  expect(visibility.unreadable_sources?.[0]).toContain("aw add-source remoto:<ruta>");

  const proc = {
    run: async () => {
      throw new Error("proc NO debe correr");
    },
  } as unknown as ProcessPort;
  const project = await buildHubTabData({ fs, env, git, process: proc, paths });
  expect(project.git).toBeNull();
  expect(project.sources[0]?.error).toContain("la ruta de la fuente remoto no existe en este host");
});

it("status y resume no descartan la fuente ausente ni en JSON ni en la salida humana", async () => {
  const { fs, env, git, paths } = await missingHub();
  const status = await runStatusCommand(fs, env, paths, { git });
  expect(status.unreadable_sources).toEqual([
    expect.objectContaining({ alias: "remoto", code: "SOURCE_PATH_MISSING" }),
  ]);
  const renderedStatus = statusCommand.renderHuman?.({ ok: true, data: status, exitCode: 0 }, {
    detail: false,
  } as never);
  expect(renderedStatus).toContain("aw add-source remoto:<ruta>");

  const resumed = await runResume(fs, env, paths, { git });
  expect(resumed.unreadable_sources?.[0]?.alias).toBe("remoto");
  const renderedResume = resumeCommand.renderHuman?.({ ok: true, data: resumed, exitCode: 0 }, {
    detail: false,
  } as never);
  expect(renderedResume).toContain("aw add-source remoto:<ruta>");
});

it("check-branch sin objetivo verifica cada fuente declarada y no afirma una coincidencia que no midió", async () => {
  // Plan 082, F6 · spec 061 AC-12: before, no target answered `match: true`.
  const { fs, env, git, paths } = await missingHub();
  const all = await runCheckBranch(fs, env, git, paths, {});
  expect(all).toMatchObject({ match: false, reason: "all_declared_sources" });
  expect(all.sources?.map((verdict) => [verdict.alias, verdict.reason])).toEqual([
    ["remoto", "SOURCE_PATH_MISSING"],
  ]);

  const empty = await mkdtemp(join(tmpdir(), "aw-source-none-"));
  roots.push(empty);
  const bare = new PathsService(normalizeNamespace("workflow"), empty, empty);
  await mkdir(bare.cwdRoot());
  expect(await runCheckBranch(fs, env, git, bare, {})).toEqual({
    match: false,
    reason: "no_sources_declared",
  });
});
