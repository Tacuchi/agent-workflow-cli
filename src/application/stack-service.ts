import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { detectStackDict } from "./stack-detect.js";

export interface StackInput {
  projectDir?: string;
}

export interface StackOutput {
  language: string | null;
  framework: string | null;
  db: string | null;
  build: string | null;
  wrapper: string | null;
}

export async function runStack(
  fs: FileSystemPort,
  env: EnvPort,
  input: StackInput,
): Promise<StackOutput> {
  const target = input.projectDir ?? env.cwd();
  const stack = await detectStackDict(fs, target);
  return {
    language: stack.language ?? null,
    framework: stack.framework ?? null,
    db: stack.db ?? null,
    build: stack.build ?? null,
    wrapper: stack.wrapper ?? null,
  };
}
