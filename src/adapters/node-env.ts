import { homedir } from "node:os";
import type { EnvPort } from "../ports/env.js";

export class NodeEnv implements EnvPort {
  get(name: string): string | undefined {
    return process.env[name];
  }

  homeDir(): string {
    return homedir();
  }

  cwd(): string {
    return process.cwd();
  }
}
