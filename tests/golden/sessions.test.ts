import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { SessionsService } from "../../src/application/sessions-service.js";
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

describe("SessionsService — golden parity (new model, folder-marker state)", () => {
  const env = new FixtureEnv();
  const paths = new PathsService(normalizeNamespace("workflow"), env.homeDir(), env.cwd());
  const service = new SessionsService(new NodeFileSystem(), env, paths);

  it("default mode (active filter) matches sessions-default.json", async () => {
    const result = await service.list();
    expect(result).toEqual(loadGolden("sessions-default.json"));
  });

  it("--all mode matches sessions-all.json", async () => {
    const result = await service.list({ state: "all" });
    expect(result).toEqual(loadGolden("sessions-all.json"));
  });

  it("--state closed (derived from the .closed sentinel) matches sessions-closed.json", async () => {
    const result = await service.list({ state: "closed" });
    expect(result).toEqual(loadGolden("sessions-closed.json"));
  });
});
