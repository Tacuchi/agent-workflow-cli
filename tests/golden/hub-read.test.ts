import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHubBlockRead } from "../../src/application/hub-block-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

// Read-command golden parity in 31.0.0: the session readers left with the
// sessions (spec 066); the hub block read stays and keeps its exact shape.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "sample-workspace");
const GOLDEN = join(HERE, "..", "fixtures", "golden", "project-read.json");

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

/** The fixture's portable `.` source path, bound to the fixture root at runtime. */
function expected(): unknown {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as {
    block: { fuentes: Array<{ path: string }> } | null;
  };
  if (golden.block === null) return golden;
  return {
    ...golden,
    block: {
      ...golden.block,
      fuentes: golden.block.fuentes.map((source) =>
        source.path === "." ? { ...source, path: FIXTURE } : source,
      ),
    },
  };
}

describe("read commands — golden parity", () => {
  it("project-md-upsert --read", async () => {
    const env = new FixtureEnv();
    const paths = new PathsService(normalizeNamespace("workflow"), env.homeDir(), env.cwd());
    expect(await runHubBlockRead(new NodeFileSystem(), env, paths)).toEqual(expected());
  });
});
