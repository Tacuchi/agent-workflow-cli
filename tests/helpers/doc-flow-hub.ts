// Un hub temporal con git y el binario construido, para recorrer los flujos de
// documento sin sesión (spec 066, F3).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve("dist/cli/main.js");

export interface DocFlowHub {
  root: string;
  home: string;
  aw(args: string[], input?: string): { status: number | null; json: Record<string, unknown> };
  git(...args: string[]): string;
  /** Every path git reports as changed or untracked, relative to the hub. */
  changed(): string[];
  /** Commits whatever is in the tree, so the next step's diff stands alone. */
  checkpoint(message: string): void;
  /** Any file or folder of the session model anywhere under the hub. */
  sessionResidue(): string[];
  dispose(): void;
}

/**
 * `nested` puts the hub at that folder of a bigger repository (spec 067, F2)
 * instead of at its own repository root.
 */
export function docFlowHub(options: { nested?: string } = {}): DocFlowHub {
  const base = mkdtempSync(join(tmpdir(), "aw-doc-flow-"));
  const repoRoot = options.nested === undefined ? join(base, "hub") : join(base, "repo");
  const root = options.nested === undefined ? repoRoot : join(repoRoot, options.nested);
  const home = join(base, "home");
  mkdirSync(join(root, "docs/specs"), { recursive: true });
  mkdirSync(join(root, "docs/plans"), { recursive: true });
  mkdirSync(join(root, ".workflow"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, ".workflow/workline.json"), '{"workline":1}\n');
  writeFileSync(
    join(root, "CLAUDE.md"),
    [
      "<!-- WORKFLOW-HUB-START -->",
      "## Hub",
      "",
      "Hub de prueba.",
      "",
      "## Fuentes",
      "",
      "| Alias | Path | Rama principal |",
      "|---|---|---|",
      `| app | ${join(base, "app")} | main |`,
      "",
      "## Pipeline",
      "",
      "- app: build `npm run build` · test `npm test`",
      "",
      "<!-- WORKFLOW-HUB-END -->",
      "",
    ].join("\n"),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("add", ".");
  git("commit", "-q", "-m", "hub");

  const residue = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (/^(sessions|\.flow-attempts|HISTORY\.md|claims\.jsonl|\.flow-run\.json)$/.test(name)) {
        out.push(path.slice(root.length + 1));
      }
      try {
        residue(path, out);
      } catch {
        // a file, not a folder
      }
    }
    return out;
  };

  return {
    root,
    home,
    aw(args, input = "") {
      const result = spawnSync(
        process.execPath,
        ["--no-warnings", entry, ...args, "--format", "json"],
        {
          cwd: root,
          encoding: "utf8",
          input,
          env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
        },
      );
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {
        json = { raw: result.stdout, stderr: result.stderr };
      }
      return { status: result.status, json };
    },
    git,
    changed: () =>
      git("status", "--porcelain", "-uall")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3)),
    checkpoint(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    sessionResidue: () => (existsSync(root) ? residue(root) : []),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** The `data` of a CLI JSON envelope. */
export function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return (json.data ?? json) as Record<string, unknown>;
}
