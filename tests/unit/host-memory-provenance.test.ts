import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostMemoryCommand } from "../../src/cli/commands/host-memory.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { HostMemoryEntry, HostMemoryReport } from "../../src/domain/host-memory/model.js";
import { missingCommands } from "../../src/domain/host-memory/provenance.js";
import { readPackageVersion } from "../../src/runtime/version.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * `aw host-memory` contrast, provenance and destination (plan 062, F2).
 *
 * The mechanical half of `/w:recall`: a learning that names a command the CLI
 * no longer has comes flagged; a copy is known by the origin mark it carries and
 * answers to its original's id; the current host is told where it would save and
 * whether that place already holds the learning.
 */

const CLAUDE_MEMORY = ".claude/projects/-tmp-ws/memory";
const CODEX_NOTES = ".codex/memories/extensions/ad_hoc/notes";

const NEXT_NUMBER_NOTE = `---
name: aw-next-number-publish-no-sella-el-titulo
description: "\`aw next-number --publish\` deja el # Spec NNN del cuerpo sin reemplazar"
metadata:
  modified: 2026-09-02T10:00:00.000Z
---
`;

const DESIGN_NOTE = `---
name: aw-design-publica-el-paquete
description: "Workline: \`aw design publish\` sella el paquete de diseño"
metadata:
  modified: 2026-08-01T10:00:00.000Z
---
`;

let home: string;

function put(path: string, content: string): void {
  const abs = join(home, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function ctx(vars: Record<string, string> = {}): CliContext {
  return {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, join(home, "ws"), vars),
    process: new FakeProcess(),
    git: new RecordingGit(),
  } as unknown as CliContext;
}

async function report(argv: string[], context = ctx()): Promise<HostMemoryReport> {
  const result = await hostMemoryCommand.execute(parseArgv(["host-memory", ...argv]), context);
  expect(result.ok).toBe(true);
  return result.data as HostMemoryReport;
}

function entry(data: HostMemoryReport, host: string, name: string): HostMemoryEntry {
  const found = data.entries.find((e) => e.host === host && e.source.path.endsWith(name));
  if (found === undefined) throw new Error(`no ${host} entry for ${name}`);
  return found;
}

/** Claude Code's two notes, and a Codex ad-hoc note that saved the first with its mark. */
async function seedCopiedLearning(): Promise<string> {
  put(`${CLAUDE_MEMORY}/next-number.md`, NEXT_NUMBER_NOTE);
  put(`${CLAUDE_MEMORY}/design.md`, DESIGN_NOTE);
  put(".codex/config.toml", "[features]\nmemories = true\n");
  const asGemini = await report(["--host", "gemini"]);
  const mark = entry(asGemini, "claude-code", "next-number.md").origin_mark;
  put(
    `${CODEX_NOTES}/2026-09-21T09-00-00-next-number.md`,
    `aw next-number --publish no sella el título del cuerpo\n\n${mark}\n`,
  );
  return mark;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aw-host-memory-provenance-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("aw host-memory · the mechanical contrast", () => {
  it("flags an `aw` command the installed CLI does not have, and only that one", async () => {
    await seedCopiedLearning();
    const data = await report(["--host", "gemini"]);
    expect(entry(data, "claude-code", "design.md").stale).toEqual([
      { command: "design", cli_version: readPackageVersion() },
    ]);
    expect(entry(data, "claude-code", "next-number.md").stale).toEqual([]);
  });

  it("names the whole token, only inside code spans (a real note wrote `aw hasOwnProperty`)", () => {
    const commands = new Set(["status"]);
    expect(missingCommands("`aw hasOwnProperty` y `aw status --json`", commands)).toEqual([
      "hasOwnProperty",
    ]);
    expect(missingCommands("prose says aw design, which is not a claim", commands)).toEqual([]);
  });
});

describe("aw host-memory · provenance", () => {
  it("gives a learning the same id and mark on every reading of the same memory", async () => {
    await seedCopiedLearning();
    const first = entry(await report(["--host", "gemini"]), "claude-code", "next-number.md");
    const second = entry(await report(["--host", "gemini"]), "claude-code", "next-number.md");
    expect(second.id).toBe(first.id);
    expect(first.origin_mark).toBe(`[aw-origin id=${first.id} host=claude-code date=2026-09-02]`);
    expect(first.provenance).toEqual({ kind: "native" });
  });

  it("knows a copy by its mark: it carries its original's id and origin, never passes as native", async () => {
    const mark = await seedCopiedLearning();
    const data = await report(["--host", "gemini"]);
    const original = entry(data, "claude-code", "next-number.md");
    const copy = entry(data, "codex", "2026-09-21T09-00-00-next-number.md");
    expect(copy.id).toBe(original.id);
    expect(copy.provenance).toEqual({
      kind: "copy",
      origin_host: "claude-code",
      origin_date: "2026-09-02",
    });
    expect(copy.origin_mark).toBe(mark);
  });

  it("run as Codex, the learning its notes already copied comes present, and the rest does not", async () => {
    await seedCopiedLearning();
    const data = await report(["--host", "codex"]);
    expect(entry(data, "claude-code", "next-number.md").present_in_destination).toBe(true);
    expect(entry(data, "claude-code", "design.md").present_in_destination).toBe(false);
  });
});

describe("aw host-memory · where the current host saves", () => {
  it("Claude Code saves in the memory folder of the workspace's git root", async () => {
    const git = new (class extends RecordingGit {
      override async repoPrefix(): Promise<string | null> {
        return "projects/agent-workflow/";
      }
    })();
    const context = { ...ctx(), git } as CliContext;
    context.env = new FakeEnv(home, "/Users/u/Git/personal-lab/projects/agent-workflow", {});
    const data = await report(["--host", "claude-code"], context);
    expect(data.current_host.destination).toEqual({
      path: join(home, ".claude/projects/-Users-u-Git-personal-lab/memory"),
      channel: "claude-code-memory-note",
      name_format: null,
    });
    expect(data.current_host.destination_reason).toBeNull();
  });

  it("Codex with memory on saves an ad-hoc note, and with memory off has nowhere", async () => {
    put(".codex/config.toml", "[features]\nmemories = true\n");
    expect((await report(["--host", "codex"])).current_host.destination).toEqual({
      path: join(home, CODEX_NOTES),
      channel: "codex-ad-hoc-note",
      name_format: "YYYY-MM-DDTHH-MM-SS-<slug>.md",
    });
    put(".codex/config.toml", "[features]\nmemories = false\n");
    const off = (await report(["--host", "codex"])).current_host;
    expect(off.destination).toBeNull();
    expect(off.destination_reason).toContain("no está activa");
  });

  it("Kimi and an unrecognized host have no destination, say why, and hold nothing", async () => {
    put(`${CLAUDE_MEMORY}/next-number.md`, NEXT_NUMBER_NOTE);
    const kimi = await report(["--host", "kimi"]);
    expect(kimi.current_host.destination).toBeNull();
    expect(kimi.current_host.destination_reason).toContain("Kimi");
    expect(entry(kimi, "claude-code", "next-number.md").present_in_destination).toBeNull();

    const unknown = await report([]);
    expect(unknown.current_host.id).toBe("unknown");
    expect(unknown.current_host.destination).toBeNull();
    expect(unknown.current_host.destination_reason).toContain("no reconocido");
  });
});
