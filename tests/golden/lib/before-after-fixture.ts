import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathsService } from "../../../src/application/paths-service.js";
import { normalizeNamespace } from "../../../src/runtime/namespace.js";
import { FakeEnv } from "../../helpers/fake-env.js";

/** Clones a fixture dir into a fresh tmpdir and returns the clone's absolute cwd. */
export function cloneFixture(fixturePath: string, prefix = "agent-workflow-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixturePath, dir, { recursive: true });
  return dir;
}

/** EnvPort stub fixed to home=/home/test with the clone dir as cwd. */
export class TestEnv extends FakeEnv {
  constructor(cwd: string) {
    super("/home/test", cwd);
  }
}

export function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Constructs a `PathsService` for tests with namespace=workflow, so that all
 * path methods produce `.workflow/...` literals. Used by golden tests when
 * services are migrated to take `paths: PathsService` as a dependency.
 */
export function makeWorkflowPaths(env: TestEnv): PathsService {
  return new PathsService(normalizeNamespace("workflow"), env.homeDir(), env.cwd());
}
