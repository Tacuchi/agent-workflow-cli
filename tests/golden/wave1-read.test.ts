import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runArtifactsCommand } from "../../src/application/artifacts-service.js";
import { runDecisionesCommand } from "../../src/application/decisiones-service.js";
import { runDependenciasCommand } from "../../src/application/dependencias-service.js";
import { runHistoryDataCommand } from "../../src/application/history-data-service.js";
import { runObjetivoCommand } from "../../src/application/objetivo-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdRead } from "../../src/application/project-md-service.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import { runTasksCommand } from "../../src/application/tasks-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "sample-workspace");
const GOLDEN_DIR = join(HERE, "..", "fixtures", "golden");

class FixtureEnv implements EnvPort {
  get(): undefined {
    return undefined;
  }
  homeDir(): string {
    return "/home/test";
  }
  cwd(): string {
    return FIXTURE;
  }
}

function loadGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8"));
}

const fs = new NodeFileSystem();
const env = new FixtureEnv();
const paths = new PathsService(normalizeNamespace("qtc"), env.homeDir(), env.cwd());

describe("Wave 1 read commands — golden parity vs python qtc_core", () => {
  it("objetivo-data --code 001", async () => {
    const result = await runObjetivoCommand(fs, env, { code: "001" });
    expect(result).toEqual(loadGolden("objetivo-001.json"));
  });

  it("tasks-data --code 001", async () => {
    const result = await runTasksCommand(fs, env, { code: "001" });
    expect(result).toEqual(loadGolden("tasks-001.json"));
  });

  it("tasks-data --code 001 --only-open", async () => {
    const result = await runTasksCommand(fs, env, { code: "001", onlyOpen: true });
    expect(result).toEqual(loadGolden("tasks-001-open.json"));
  });

  it("tasks-data --code 002 (empty fixture)", async () => {
    const result = await runTasksCommand(fs, env, { code: "002" });
    expect(result).toEqual(loadGolden("tasks-002.json"));
  });

  it("decisiones-list --code 001", async () => {
    const result = await runDecisionesCommand(fs, env, { code: "001" });
    expect(result).toEqual(loadGolden("decisiones-001.json"));
  });

  it("dependencias-list --code 001", async () => {
    const result = await runDependenciasCommand(fs, env, { code: "001" });
    expect(result).toEqual(loadGolden("dependencias-001.json"));
  });

  it("history-data", async () => {
    const result = await runHistoryDataCommand(fs, env, paths, {});
    expect(result).toEqual(loadGolden("history-data.json"));
  });

  it("session-artifacts --code 001", async () => {
    const result = await runArtifactsCommand(fs, env, { code: "001" });
    expect(result).toEqual(loadGolden("artifacts-001.json"));
  });

  it("project-md-upsert --read", async () => {
    const result = await runProjectMdRead(fs, env);
    expect(result).toEqual(loadGolden("project-read.json"));
  });

  it("session-resume --code 001", async () => {
    const result = await runSessionResume(fs, env, { code: "001" });
    expect(result).toEqual(loadGolden("resume-001.json"));
  });
});
