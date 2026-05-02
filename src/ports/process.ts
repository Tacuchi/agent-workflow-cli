export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessPort {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  which(cmd: string): Promise<string | undefined>;
}
