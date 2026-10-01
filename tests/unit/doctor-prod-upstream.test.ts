import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { visibilityProvider } from "../../src/application/doctor/provider-visibility.js";
import type { DoctorProviderInput } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import type { GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

describe("doctor · upstream de ramas de trabajo contra PROD", () => {
  it("avisa de cada rama incorrecta, nunca de PROD propia ni de una rama sin upstream; no toca git", async () => {
    const root = "/workspace";
    const source = join(root, "fuente con espacios");
    const fs = new MemFs({ lenient: true });
    fs.file(
      join(root, "CLAUDE.md"),
      `<!-- WORKFLOW-PROJECT-START -->
## Proyecto
Ejemplo
## Fuentes
| Alias | Path | Rama principal |
|---|---|---|
| app | ${source} | main |
## Status
- Ramas de trabajo actuales:
  - app: feature/w
<!-- WORKFLOW-PROJECT-END -->`,
    );
    const reads: string[] = [];
    const git = {
      isGitRepo: async (path: string) => {
        reads.push(`repo:${path}`);
        return true;
      },
      localBranches: async (path: string) => {
        reads.push(`branches:${path}`);
        return ["main", "feature/w", "feature/noup", "development"];
      },
      upstreamBranch: async (_path: string, branch: string) => {
        reads.push(`upstream:${branch}`);
        return branch === "feature/noup" ? null : "refs/remotes/origin/main";
      },
    } as GitPort;
    const ctx = {
      fs,
      env: new FakeEnv("/home/u", root),
      paths: new PathsService(normalizeNamespace("workflow"), "/home/u", root),
      git,
    } as CliContext;
    const input = {
      ctx,
      hosts: [],
      hostStates: [],
      currentHost: null,
      workspaceDir: root,
      skipNative: true,
    } as DoctorProviderInput;
    const report = await visibilityProvider.run(input);
    expect(report.findings.map((finding) => finding.id)).toEqual([
      "hub/hub-visibility/upstream:app:feature/w",
    ]);
    expect(report.findings[0]?.remediation.guidance).toEqual([
      `git -C '${source}' branch --unset-upstream 'feature/w'`,
    ]);
    expect(reads).toEqual([
      `repo:${source}`,
      `branches:${source}`,
      "upstream:feature/w",
      "upstream:feature/noup",
    ]);
  });
});
