import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile, stat, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { SkillsTab } from "../../src/cli/tui/tabs/skills-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

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

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
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
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("SkillsTab (TUI) — hooks integration (T2.8)", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-skills-tab-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("renders 3 hosts en la lista", async () => {
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("Codex");
    expect(frame).toContain("Warp Terminal");
    unmount();
  });

  it("uses the ~/.<host>/skills/w/ path (no legacy agent-workflow dir)", async () => {
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("skills/w/");
    expect(frame).not.toContain("skills/agent-workflow/");
    unmount();
  });

  it("shows hooks ✓ when ~/.claude/settings.json has hooks key", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [] }] } }),
      "utf8",
    );
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? "";
    // Look for the hooks status line for Claude — should show check mark next to "hooks"
    expect(frame).toContain("hooks");
    unmount();
  });

  it("no muestra pill `hooks` cuando settings.json no tiene hooks key", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: [] } }),
      "utf8",
    );
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? "";
    // No esperamos "hooks activos"; la lista de hosts no muestra hooks=false.
    expect(frame).not.toContain("hooks activos");
    expect(frame).toContain("Claude Code");
    unmount();
  });

  it("el header refleja los counts que reporta HostAdminSection (seam onSummary)", async () => {
    // Con ~/.claude/skills/w presente, la sección reporta installed=1 y el
    // PageHead del tab debe decir "1/7 hosts" — cubre el seam onSummary→estado
    // del tab que el refactor de extracción introdujo.
    await mkdir(join(home, ".claude", "skills", "w"), { recursive: true });
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await new Promise((r) => setTimeout(r, 100));
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("1/7 hosts");
    unmount();
  });

  it("renders without crashing when settings.json is invalid JSON", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{not valid", "utf8");
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Claude Code");
    unmount();
  });
});
