import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { observeQuickCheckouts } from "../../src/application/flow/quick-checkouts.js";
import { locateRun } from "../../src/application/flow/run-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { newRunState, serializeRunState } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const fs = new NodeFileSystem();
const SESSION = "001-huellas-quick";
let repo: string;
let paths: PathsService;

function git(...args: string[]) {
  return execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "aw-quick-checkouts-"));
  const root = join(repo, "workspace");
  paths = new PathsService(normalizeNamespace("agent-workflow"), repo, root);
  await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
  await writeFile(
    locateRun(paths, SESSION).statePath,
    serializeRunState(newRunState("quick", SESSION)),
  );
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

it("detecta modos Git sin incluir vecinos ni artefactos internos", async () => {
  git("init", "--quiet", "--initial-branch=main");
  const script = join(paths.hubDir(), "script.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  await chmod(script, 0o644);
  git("add", "workspace/script.sh");
  git("commit", "--quiet", "-m", "base");
  const adapter = new GitCliAdapter(new NodeProcess());
  const observe = () => observeQuickCheckouts(fs, paths, SESSION, adapter);
  const before = await observe();
  expect(before).not.toBeNull();
  await writeFile(join(repo, "vecino.txt"), "otro plan");
  await writeFile(join(paths.cwdSessionsDir(), SESSION, "CHECKPOINT.md"), "artefacto del quick");
  expect(await observe()).toEqual(before);
  await chmod(script, 0o755);
  expect(await observe()).not.toEqual(before);
  await chmod(script, 0o644);
  expect(await observe()).toEqual(before);
  const untracked = join(paths.hubDir(), "nuevo.sh");
  await writeFile(untracked, "#!/bin/sh\nexit 0\n");
  await chmod(untracked, 0o644);
  const added = await observe();
  expect(added).not.toBeNull();
  await chmod(untracked, 0o755);
  expect(await observe()).not.toEqual(added);
});

it("rechaza un mapa cuya primera raíz cambió al leer la segunda", async () => {
  const source = join(repo, "source");
  await mkdir(source);
  await writeFile(
    join(paths.hubDir(), "AGENTS.md"),
    [
      paths.blockMarkers().start,
      "## Fuentes",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      `| cli | ${source} | main |`,
      paths.blockMarkers().end,
    ].join("\n"),
  );
  let hub = "original";
  const reader = Object.assign(new RecordingGit(), {
    scopedFingerprint: async (root: string) => {
      if (root === source) hub = "cambió durante la lectura";
      return root === source ? "source" : hub;
    },
    checkoutFingerprint: async () => "metadata",
  });
  expect(await observeQuickCheckouts(fs, paths, SESSION, reader)).toBeNull();
});
