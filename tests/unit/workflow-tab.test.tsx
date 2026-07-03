import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFile, stat, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { WORKFLOW_CONTENT } from "../../src/cli/tui/data/workflow-content.js";
import { HOSTS } from "../../src/cli/tui/hosts.js";
import { WorkflowTab } from "../../src/cli/tui/tabs/workflow-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

// [Workflows] monta HostAdminSection (fs.exists sobre ~/.<host>/skills/w), así
// que el harness necesita un home sandbox real — mismo patrón que el test del
// skills-tab.
class FakeEnv implements EnvPort {
  constructor(private home: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this.home;
  }
  cwd() {
    return this.home;
  }
}

class RealFs implements FileSystemPort {
  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  async writeText(path: string, content: string): Promise<void> {
    await writeFileAsync(path, content, "utf8");
  }
  async writeTextExclusive(): Promise<{ created: boolean }> {
    return { created: true };
  }
  async appendText(): Promise<void> {}
  async remove(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async list(): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async stat(): Promise<FileStat> {
    throw new Error("nyi");
  }
}

class FakeProcess implements ProcessPort {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which() {
    return undefined;
  }
}

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new RealFs(),
    env: new FakeEnv(home),
    process: new FakeProcess() as unknown as ProcessPort,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("WorkflowTab ([Workflows] = admin + informativo mínimo)", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-workflow-tab-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function renderFlat(): Promise<string> {
    const { lastFrame, unmount } = render(<WorkflowTab ctx={buildCtx(home)} isActive />);
    await new Promise((r) => setTimeout(r, 80));
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    unmount();
    return frame;
  }

  it("header: título Workflows + counts derivados de los data modules (.length)", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Workflows");
    expect(frame).toContain(`${WORKFLOW_CONTENT.slashCommands.length} slash commands`);
    expect(frame).toContain(`${WORKFLOW_CONTENT.hooks.length} hooks`);
  });

  it("informativo mínimo: overview 1 línea + strip de flows; sin FamilyCards ni PhaseCards", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Flows:");
    expect(frame).toContain("SPEC · PLAN · QUICK");
    // Las secciones retiradas por el rediseño (U2) no deben renderizar.
    expect(frame).not.toContain("Command families");
    expect(frame).not.toContain("Workspace init");
  });

  it("administración por host montada: sección Hosts con TODOS los targets del registro", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("HOSTS");
    // Derivado de HOSTS (no lista hardcodeada): si el registro suma o pierde un
    // host, este assert lo refleja — lección clean-legacy v14.5.1.
    for (const host of HOSTS) {
      expect(frame).toContain(host.name);
    }
    expect(frame).toContain("skills/w/");
  });
});
