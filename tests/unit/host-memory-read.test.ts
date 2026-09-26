import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostMemoryCommand } from "../../src/cli/commands/host-memory.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import type { HostMemoryReport, HostMemoryRow } from "../../src/domain/host-memory/model.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * `aw host-memory` over a fake HOME (plan 062, F1).
 *
 * What it pins: every host of the catalog but the current one gets a row whose
 * state says why it gave what it gave; only Workline learnings leave a host, the
 * rest is counted and its text never appears; the date is the memory's own or
 * null; and the command writes nothing at all.
 */

const CLAUDE_MEMORY = ".claude/projects/-tmp-ws/memory";
const CODEX_MEMORIES = ".codex/memories";

const WORKLINE_NOTE = `---
name: aw-next-number-publish-no-sella-el-titulo
description: "aw next-number --publish asigna el correlativo al nombre del archivo y deja el # Spec NNN del cuerpo sin reemplazar"
metadata:
  type: project
  modified: 2026-09-02T10:00:00.000Z
---

El encabezado del cuerpo se estampa a mano después de publicar.
`;

const UNDATED_WORKLINE_NOTE = `---
name: plan-exec-un-lote-por-fase
description: /w:plan-exec infiere un lote por fase aunque el plan declare un rango continuo
metadata:
  type: reference
---
`;

const FINANCE_NOTE = `---
name: finanzas-plan-de-pagos
description: Plan de pagos de la tarjeta con bolsillo máximo de S/ 312
metadata:
  type: project
  modified: 2026-09-10T10:00:00.000Z
---
`;

const CODEX_INDEX = `# Task Group: agent-workflow-cli npm releases

scope: Publish Workline releases from a clean checkout.
applies_to: cwd=/Users/u/Git/agent-workflow-cli; reuse_rule=re-check the registry.

## Task 1: Publish 25.3.1, success

### rollout_summary_files

- rollout_summaries/2026-09-09T13-12-38-vuPJ-release.md (cwd=/Users/u, updated_at=2026-09-09T13:31:42+00:00)
- rollout_summaries/2026-09-12T08-00-00-abcd-release.md (cwd=/Users/u)

### keywords

- npm publish, tag, registry

## Reusable knowledge

- Run \`npm run prepublishOnly\` before
  \`npm pack --dry-run --json\`.
- The tag goes after the publish check.
- A note consolidated from an ad-hoc note [ad-hoc note]

## Failures and how to do differently

- A 404 right after publish is registry propagation, not auth.

# Task Group: Blender render farm

scope: Keep the render nodes busy overnight.
applies_to: cwd=/Users/u/renders

## Reusable knowledge

- Cycles denoising needs the OptiX driver.
- Tile size 256 is faster on the GPU nodes.
`;

const AD_HOC_NOTE = "# aw flow submit lee el sobre por stdin\n\nNo existe --input.\n";

let home: string;

function put(path: string, content: string): void {
  const abs = join(home, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function seedMachine(): void {
  put(`${CLAUDE_MEMORY}/MEMORY.md`, "# Memory index\n\n- [nota](aw-next-number.md)\n");
  put(`${CLAUDE_MEMORY}/aw-next-number.md`, WORKLINE_NOTE);
  put(`${CLAUDE_MEMORY}/plan-exec-lotes.md`, UNDATED_WORKLINE_NOTE);
  put(`${CLAUDE_MEMORY}/finanzas.md`, FINANCE_NOTE);
  put(`${CLAUDE_MEMORY}/rota.md`, "una nota sin frontmatter\n");
  put(".codex/config.toml", "[features]\nmemories = true\n");
  put(`${CODEX_MEMORIES}/MEMORY.md`, CODEX_INDEX);
  put(`${CODEX_MEMORIES}/extensions/ad_hoc/notes/2026-09-20T08-30-00-flow-submit.md`, AD_HOC_NOTE);
  mkdirSync(join(home, ".kimi-code"), { recursive: true });
}

/** Every file under HOME with its bytes and mtime: a read-only command leaves both as they were. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.set(relative(home, abs), `${statSync(abs).mtimeMs}:${readFileSync(abs, "base64")}`);
    }
  };
  walk(home);
  return out;
}

function ctx(vars: Record<string, string> = {}): CliContext {
  return {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, home, vars),
    process: new FakeProcess(),
    git: new RecordingGit(),
  } as unknown as CliContext;
}

async function run(argv: string[], context = ctx()) {
  return hostMemoryCommand.execute(parseArgv(["host-memory", ...argv]), context);
}

async function report(argv: string[], context = ctx()): Promise<HostMemoryReport> {
  const result = await run(argv, context);
  expect(result.ok).toBe(true);
  expect(result.exitCode).toBe(0);
  if (result.data === undefined) throw new Error("host-memory returned no report");
  return result.data as HostMemoryReport;
}

function row(data: HostMemoryReport, host: string): HostMemoryRow {
  const found = data.hosts.find((candidate) => candidate.host === host);
  if (found === undefined) throw new Error(`no row for ${host}`);
  return found;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aw-host-memory-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("aw host-memory · one row per other host, with its state and reason", () => {
  it("reports every catalog host but the current one, and never fails for what a host lacks", async () => {
    seedMachine();
    const data = await report(["--host", "gemini", "--json"]);

    expect(data.current_host).toMatchObject({ id: "gemini", detected_via: "binding:gemini" });
    expect(data.hosts.map((candidate) => candidate.host)).toEqual(
      HARNESSES.map((spec) => spec.id).filter((id) => id !== "gemini"),
    );
    expect(row(data, "claude-code")).toMatchObject({
      state: "read",
      workline_entries: 2,
      other_entries: 1,
    });
    expect(row(data, "claude-code").skipped).toEqual([
      { path: join(home, CLAUDE_MEMORY, "rota.md"), reason: "sin frontmatter" },
    ]);
    expect(row(data, "codex")).toMatchObject({
      state: "read",
      workline_entries: 4,
      other_entries: 2,
    });
    expect(row(data, "kimi")).toMatchObject({ state: "no-curated-memory" });
    expect(row(data, "opencode")).toMatchObject({ state: "absent" });
    for (const candidate of data.hosts)
      expect(candidate.reason === null).toBe(candidate.state === "read");
  });

  it("a Codex with memories switched off is disabled, and one whose index it cannot parse is unreadable", async () => {
    put(".codex/config.toml", "[features]\nmemories = false\n");
    put(`${CODEX_MEMORIES}/MEMORY.md`, CODEX_INDEX);
    expect(row(await report(["--host", "gemini"]), "codex")).toMatchObject({
      state: "disabled",
      reason: expect.stringContaining("memories no es true"),
    });

    put(".codex/config.toml", "[features]\nmemories = true\n");
    put(`${CODEX_MEMORIES}/MEMORY.md`, "free text with no groups\n");
    expect(row(await report(["--host", "gemini"]), "codex")).toMatchObject({
      state: "unreadable",
      reason: expect.stringContaining("'# Task Group'"),
    });
  });
  it("an index it cannot parse never hides the ad-hoc notes next to it", async () => {
    put(".codex/config.toml", "[features]\nmemories = true\n");
    put(`${CODEX_MEMORIES}/MEMORY.md`, "free text with no groups\n");
    put(
      `${CODEX_MEMORIES}/extensions/ad_hoc/notes/2026-09-20T08-30-00-flow-submit.md`,
      AD_HOC_NOTE,
    );
    const data = await report(["--host", "gemini"]);
    expect(row(data, "codex")).toMatchObject({ state: "read", workline_entries: 1 });
    expect(row(data, "codex").skipped).toEqual([
      {
        path: join(home, CODEX_MEMORIES, "MEMORY.md"),
        reason: "no trae ningún bloque '# Task Group'",
      },
    ]);
  });

  it("a host whose reading throws becomes its own unreadable row, and the rest of the report stands", async () => {
    seedMachine();
    class FailingClaudeFs extends NodeFileSystem {
      override async list(path: string) {
        if (path.includes(".claude")) throw new Error("EACCES: permission denied");
        return super.list(path);
      }
    }
    const data = await report(["--host", "gemini"], {
      ...ctx(),
      fs: new FailingClaudeFs(),
    } as CliContext);
    expect(row(data, "claude-code")).toMatchObject({
      state: "unreadable",
      reason: expect.stringContaining("EACCES"),
    });
    expect(row(data, "codex")).toMatchObject({ state: "read", workline_entries: 4 });
  });
});

describe("aw host-memory · only Workline learnings leave a host", () => {
  it("lists each learning with its host, its memory date or null, and its source", async () => {
    seedMachine();
    const data = await report(["--host", "gemini"]);

    expect(data.entries).toMatchObject([
      {
        host: "claude-code",
        date: "2026-09-02",
        text: "aw next-number --publish asigna el correlativo al nombre del archivo y deja el # Spec NNN del cuerpo sin reemplazar",
        source: { path: join(home, CLAUDE_MEMORY, "aw-next-number.md"), section: null },
      },
      {
        host: "claude-code",
        date: null,
        text: "/w:plan-exec infiere un lote por fase aunque el plan declare un rango continuo",
        source: { path: join(home, CLAUDE_MEMORY, "plan-exec-lotes.md"), section: null },
      },
      ...[
        ["Run `npm run prepublishOnly` before `npm pack --dry-run --json`.", "Reusable knowledge"],
        ["The tag goes after the publish check.", "Reusable knowledge"],
        [
          "A 404 right after publish is registry propagation, not auth.",
          "Failures and how to do differently",
        ],
      ].map(([text, section]) => ({
        host: "codex",
        date: "2026-09-12",
        text,
        source: {
          path: join(home, CODEX_MEMORIES, "MEMORY.md"),
          section: `agent-workflow-cli npm releases › ${section}`,
        },
      })),
      {
        host: "codex",
        date: "2026-09-20",
        text: "aw flow submit lee el sobre por stdin",
        source: {
          path: join(
            home,
            CODEX_MEMORIES,
            "extensions/ad_hoc/notes/2026-09-20T08-30-00-flow-submit.md",
          ),
          section: null,
        },
      },
    ]);
    // What is not about Workline is counted and nothing of it is printed.
    const printed = JSON.stringify(data);
    for (const leak of ["S/ 312", "tarjeta", "Blender", "OptiX", "[ad-hoc note]"]) {
      expect(printed).not.toContain(leak);
    }
  });

  it("with only the current host's memory on the machine the list is empty and the exit is 0", async () => {
    put(`${CLAUDE_MEMORY}/aw-next-number.md`, WORKLINE_NOTE);
    const data = await report([], ctx({ CLAUDECODE: "1" }));
    expect(data.current_host).toMatchObject({ id: "claude-code", detected_via: "env:CLAUDECODE" });
    expect(data.entries).toEqual([]);
    expect(data.hosts.some((candidate) => candidate.host === "claude-code")).toBe(false);
  });
});

describe("aw host-memory · reads and never writes", () => {
  it("leaves the fake HOME byte for byte as it was", async () => {
    seedMachine();
    const before = snapshot();
    await report(["--host", "gemini"]);
    await report(["--host", "codex"]);
    expect(snapshot()).toEqual(before);
  });

  it("refuses an unknown flag and an unknown host instead of running as if they were not there", async () => {
    const unknown = await run(["--hots", "codex"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("UNKNOWN_FLAG");
    const invalid = await run(["--host", "vim"]);
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("INVALID_INPUT");
  });
});
