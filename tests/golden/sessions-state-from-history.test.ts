import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { SessionsService } from "../../src/application/sessions-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "sample-workspace-en");

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

describe("SessionsService — state from HISTORY.md (R3 reader gap fix)", () => {
  const env = new FixtureEnv();
  const paths = new PathsService(normalizeNamespace("workflow"), env.homeDir(), env.cwd());
  const service = new SessionsService(new NodeFileSystem(), env, paths);

  it("reads state from HISTORY.md row, not from STATUS.md fallback", async () => {
    const result = await service.list({ state: "all" });

    const s001 = result.sessions.find((s) => s.code === "001");
    const s002 = result.sessions.find((s) => s.code === "002");
    const s003 = result.sessions.find((s) => s.code === "003");

    expect(s001?.state).toBe("closed");
    expect(s002?.state).toBe("active");
    expect(s003?.state).toBe("closed");
  });

  it("reads phase from CHECKPOINT.md (EN canon) when present, not hardcoded 'requirement'", async () => {
    const result = await service.list({ state: "all" });

    const s001 = result.sessions.find((s) => s.code === "001");
    const s002 = result.sessions.find((s) => s.code === "002");
    const s003 = result.sessions.find((s) => s.code === "003");

    expect(s001?.phase).toBe("closure");
    expect(s002?.phase).toBe("execution");
    expect(s003?.phase).toBe("closure");
  });

  it("counts active and closed correctly via HISTORY.md", async () => {
    const result = await service.list({ state: "all" });
    expect(result.active_count).toBe(1);
    expect(result.closed_count).toBe(2);
    expect(result.total_count).toBe(3);
  });
});
