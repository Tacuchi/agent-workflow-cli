export interface EnvPort {
  get(name: string): string | undefined;
  homeDir(): string;
  cwd(): string;
}
