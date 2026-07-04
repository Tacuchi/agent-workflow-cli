import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { sessionArtifactsCommand } from "../../src/cli/commands/session-artifacts.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

// Regression: the 4 export-* commands delegate artifact READING to
// session-artifacts, but the command only returned counts and the real dump
// (readSessionArtifacts) was dead code with a legacy naming filter
// (`session\d{3}-`) that never matched new-model sessions (`NNN-<slug>-<flow>`).
describe("session-artifacts --dump", () => {
  let workdir: string;
  let ctx: CliContext;

  function args(values: Record<string, string>, flags: string[] = []): ParsedArgs {
    return {
      rest: [],
      plugin: {},
      flags: new Set(flags),
      values: new Map(Object.entries(values)),
      valuesMulti: new Map(),
    };
  }

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-artifacts-dump-"));
    const sessionDir = join(workdir, ".workflow", "sessions", "012-foo-quick");
    await mkdir(join(sessionDir, "scripts"), { recursive: true });
    await writeFile(join(sessionDir, "SESSION.md"), "# SESSION — foo\n\n## Objective\nhacer foo\n");
    await writeFile(join(sessionDir, "DECISION.md"), "- se decidió X\n");
    await writeFile(join(sessionDir, "CONCLUSIONS.md"), "hallazgo Y\n");
    await writeFile(join(sessionDir, "scripts", "SCRIPTS.sql"), "-- read-only\n");
    const fs = new NodeFileSystem();
    const paths = new PathsService(normalizeNamespace("workflow"), workdir, workdir);
    ctx = {
      fs,
      env: { homeDir: () => workdir, cwd: () => workdir, get: () => undefined },
      paths,
    } as unknown as CliContext;
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("devuelve {path, content, size} por kind para una session del naming nuevo", async () => {
    const result = await sessionArtifactsCommand.execute(
      args({ code: "012", dump: "objetivo,decisiones,conclusiones,scripts" }),
      ctx,
    );
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, { path: string; content: string } | unknown>;
    expect(data.session).toBe("012-foo-quick");
    expect((data.objetivo as { content: string }).content).toContain("hacer foo");
    expect((data.decisiones as { content: string }).content).toContain("se decidió X");
    expect((data.conclusiones as { content: string }).content).toContain("hallazgo Y");
    expect((data.scripts as { name: string }[])[0]?.name).toBe("SCRIPTS.sql");
  });

  it("--dump sin CSV devuelve todos los kinds", async () => {
    const result = await sessionArtifactsCommand.execute(args({ code: "012" }, ["--dump"]), ctx);
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    for (const kind of [
      "objetivo",
      "decisiones",
      "conclusiones",
      "tasks",
      "checkpoint",
      "backlog",
      "scripts",
    ]) {
      expect(kind in data, kind).toBe(true);
    }
  });

  it("kinds inválidos → INVALID_INPUT; session inexistente → SESSION_NOT_FOUND exit 1", async () => {
    const bad = await sessionArtifactsCommand.execute(args({ code: "012", dump: "nope" }), ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("INVALID_INPUT");

    const missing = await sessionArtifactsCommand.execute(args({ code: "999" }, ["--dump"]), ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("SESSION_NOT_FOUND");
    expect(missing.exitCode).toBe(1);
  });
});
