import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runArtifactsCommand } from "../../src/application/artifacts-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdRead } from "../../src/application/project-md-service.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

// Read-command golden parity, post-P2.3. The old-model per-artifact readers
// (objetivo-data / tasks-data / decisiones-list / dependencias-list) were
// removed with the Flow/Phase model; this file now exercises only the
// surviving, still-wired read services against the shared sample-workspace
// fixture: session-artifacts, project-md --read, and session-resume.

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
const paths = new PathsService(normalizeNamespace("workflow"), env.homeDir(), env.cwd());

describe("Wave 1 read commands — golden parity (new model)", () => {
  it("session-artifacts --code 001", async () => {
    const result = await runArtifactsCommand(fs, env, paths, { code: "001" });
    expect(result).toEqual(loadGolden("artifacts-001.json"));
  });

  it("project-md-upsert --read", async () => {
    const result = await runProjectMdRead(fs, env, paths);
    expect(result).toEqual(loadGolden("project-read.json"));
  });

  it("session-resume --code 001", async () => {
    const result = await runSessionResume(fs, env, paths, { code: "001" });
    expect(result).toEqual(loadGolden("resume-001.json"));
  });
});
