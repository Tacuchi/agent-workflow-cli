import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../src/application/flow/internal-actions.js";
import type { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import type { GitPort } from "../../src/ports/git.js";
import { FakeEnv } from "./fake-env.js";
import { RecordingGit } from "./fake-git.js";

/**
 * The executor a suite hands to `advanceFlow`, `submitFlow` and `restartFlow`.
 *
 * The internal operations are the REAL ones, over the suite's own workspace; only
 * env and git are faked. An internal row is the CLI's to run and to credit, so a
 * suite that walks a flow crosses it through this driver and never answers it with
 * an external result — which `submit` now refuses.
 */
export function testExecutor(
  fs: FileSystemPort,
  paths: PathsService,
  overrides: { env?: EnvPort; git?: GitPort } = {},
): InternalActionExecutor {
  const root = paths.hubDir();
  return internalActionExecutor({
    fs,
    paths,
    env: overrides.env ?? new FakeEnv(root, root),
    git: overrides.git ?? new RecordingGit(),
  });
}
