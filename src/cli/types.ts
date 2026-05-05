import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import type { ResolvedNamespace } from "../runtime/namespace-resolver.js";
import type { ResolvedRuntime } from "../runtime/types.js";

export interface CliContext {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  process: ProcessPort;
  runtime: ResolvedRuntime;
  namespace: ResolvedNamespace;
}
