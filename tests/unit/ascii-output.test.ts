import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { toAscii } from "../../src/cli/ascii.js";
import { exportDiagramsCommand } from "../../src/cli/commands/export.js";
import { hubMigrateCommand } from "../../src/cli/commands/hub-migrate.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { sessionArtifactsCommand } from "../../src/cli/commands/session-artifacts.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { visibilityCommand } from "../../src/cli/commands/visibility.js";
import { commandHelpText, globalHelpText } from "../../src/cli/help-groups.js";
import { type OutputMode, resolveOutputMode } from "../../src/cli/output-mode.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliCommand } from "../../src/cli/registry.js";
import {
  forPerson,
  renderHumanProjection,
  useAsciiStderr,
  writeStderr,
} from "../../src/cli/render.js";
import type { CliContext } from "../../src/cli/types.js";
import type { CommandResult } from "../../src/domain/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const HUMAN: OutputMode = { format: "human", detail: false, ascii: false };
const ASCII: OutputMode = { ...HUMAN, ascii: true };

function aboveAscii(text: string): string[] {
  return [...new Set([...text].filter((char) => (char.codePointAt(0) ?? 0) > 127))];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const env = new FakeEnv("/home/u", "/cwd");
const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");

async function statusResult(): Promise<CommandResult> {
  const fs = new MemFs({ lenient: true });
  fs.file("/cwd/.workflow/sessions/.keep", "");
  fs.file("/cwd/docs/plans/001-plan-uno.md", "# Plan 001 — acción\n\n## Tasks\n(ninguna)\n");
  const data = await runStatusCommand(fs, env, paths, {});
  return { ok: true, data, exitCode: 0 };
}

async function migrateResult(): Promise<CommandResult> {
  const fs = new MemFs({ lenient: true });
  fs.file("/cwd/.workflow/HISTORY.md", "# Session History\n");
  const ctx = { fs, env, paths } as unknown as CliContext;
  return hubMigrateCommand.execute(parseArgv(["workspace-migrate"]), ctx);
}

/**
 * One command per help family that has a human projection, rendered from a real
 * result. Checkpoint, Hooks, MCP, Dev-only and Self have none: they are JSON in
 * every mode, and JSON is never transliterated.
 */
async function humanSamples(): Promise<Array<[string, CliCommand, CommandResult]>> {
  return [
    ["Orchestration · status", statusCommand as CliCommand, await statusResult()],
    ["Doctor / Data · workspace-migrate", hubMigrateCommand as CliCommand, await migrateResult()],
    [
      "Exports · export-diagrams",
      exportDiagramsCommand as CliCommand,
      { ok: true, data: { stage: "apply", written: ["docs/diagrams/001-acción.md"] }, exitCode: 0 },
    ],
    [
      "Sources / Branches · visibility",
      visibilityCommand as CliCommand,
      {
        ok: true,
        data: {
          hub_dir: "/cwd",
          reports: [],
          global_reports: [],
          summary: {
            ok: 0,
            missing_paths: 0,
            extra_paths: 0,
            no_settings: 0,
            global_pollution: 0,
            no_hub_block: 0,
          },
        },
        exitCode: 0,
      },
    ],
    [
      "Session lifecycle · session-artifacts",
      sessionArtifactsCommand as CliCommand,
      {
        ok: true,
        data: {
          narrative: {
            session: "001-acción",
            phase: "ejecución",
            objective: { text: "Validar la transliteración — «sin tildes»" },
            next: null,
            sequence: [],
            tasks: [],
            decisions: [],
            results: [],
            evidence: [],
            pending: [],
            links: [],
          },
        },
        exitCode: 0,
      },
    ],
  ];
}

const FAILURE: CommandResult = {
  ok: false,
  error: { code: "UNKNOWN_FLAG", message: "--x no es un flag de este comando; acepta --código" },
  data: { action: "corregí el flag y reintentá → `aw status`" },
  exitCode: 1,
};

describe("--ascii · the human projection stays inside ASCII", () => {
  it("one command of each family: the mark removes every byte above 127", async () => {
    for (const [label, command, result] of await humanSamples()) {
      const plain = renderHumanProjection(result, command, HUMAN) ?? "";
      const ascii = renderHumanProjection(result, command, ASCII) ?? "";
      // The sample is meaningful only if it had something to transliterate.
      expect(aboveAscii(plain).length, label).toBeGreaterThan(0);
      expect(aboveAscii(ascii), label).toEqual([]);
    }
  });

  it("an error is ASCII too, code, message and next action", () => {
    const text = renderHumanProjection(FAILURE, statusCommand as CliCommand, ASCII) ?? "";
    expect(aboveAscii(text)).toEqual([]);
    expect(text).toContain("X UNKNOWN_FLAG");
    expect(text).toContain("acepta --codigo");
    expect(text).toContain("corregi el flag y reintenta -> `aw status`");
  });

  it("without the mark the output is byte for byte today's", async () => {
    for (const [label, command, result] of await humanSamples()) {
      const today = command.renderHuman?.(result, { detail: false });
      expect(renderHumanProjection(result, command, HUMAN), label).toBe(today);
    }
  });

  it("the help and the per-command help follow the same mark", () => {
    const help = globalHelpText(ALL_COMMANDS, "workflow");
    expect(aboveAscii(help).length).toBeGreaterThan(0);
    expect(aboveAscii(forPerson(help, ASCII))).toEqual([]);
    // Per-command help is English (plan 082 F2), so it is ASCII already and the
    // mark has nothing left to replace in it.
    const perCommand = commandHelpText(statusCommand);
    expect(aboveAscii(perCommand)).toEqual([]);
    expect(forPerson(perCommand, ASCII)).toBe(perCommand);
    expect(forPerson(perCommand, HUMAN)).toBe(perCommand);
  });

  it("the global help documents the output flags", () => {
    const help = globalHelpText([], "workflow");
    for (const flag of ["--format human|json", "--json", "--detail", "--ascii", "AW_ASCII=1"]) {
      expect(help).toContain(flag);
    }
  });
});

describe("--ascii · the transliteration", () => {
  it("maps the table of glyphs the plan names", () => {
    expect(toAscii("a · b — c")).toBe("a - b - c");
    expect(toAscii("«x»")).toBe('"x"');
    expect(toAscii("✓ ✔ ✗ ✘")).toBe("OK OK X X");
    expect(toAscii("a → b… ▸ ⚠")).toBe("a -> b... > !");
    expect(toAscii("┌─┐\n│x│\n└─┘")).toBe("+-+\n|x|\n+-+");
  });

  it("drops accents with NFKD and puts ? on whatever is left", () => {
    expect(toAscii("acción ñandú Über")).toBe("accion nandu Uber");
    expect(toAscii("漢 🚀")).toBe("? ?");
    expect(toAscii("plain ascii\n")).toBe("plain ascii\n");
  });

  it("decomposed accents, variation selectors and ZWJ sequences are one character each", () => {
    expect(toAscii("Cafe\u0301")).toBe("Cafe");
    expect(toAscii("\u26a0\ufe0f")).toBe("!");
    expect(toAscii("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}")).toBe("?");
    expect(toAscii("a\u00a0b")).toBe("a b");
  });

  it("no glyph the CLI prints falls to `?`: each one has an ASCII reading", () => {
    // The TUI draws with Ink and never goes through the mark, so it is left out.
    const glyphs = new Set(
      sourceFiles(resolve(__dirname, "../../src"))
        .filter((file) => !file.includes("/cli/tui/"))
        .flatMap((file) => aboveAscii(readFileSync(file, "utf8"))),
    );
    expect(glyphs.size).toBeGreaterThan(10);
    // `¿` IS read as `?`: the one glyph whose ASCII reading is the fallback itself.
    const readAsQuestionMark = new Set(["¿"]);
    const unread = [...glyphs].filter(
      (glyph) => toAscii(glyph) === "?" && !readAsQuestionMark.has(glyph),
    );
    expect(unread).toEqual([]);
  });
});

describe("--ascii · JSON never changes", () => {
  // The refusal and AW_ASCII resolution live in output-mode.test.ts. Here, the
  // one case that is specific to the projection: through a pipe the mark is
  // accepted and the format stays JSON, whose branch never calls `forPerson`.
  it("through a pipe --ascii is not refused: JSON is automatic and the mark does not apply", () => {
    const resolution = resolveOutputMode(parseArgv(["status", "--ascii"]), false);
    expect(resolution).toMatchObject({ ok: true, mode: { format: "json", ascii: true } });
  });
});

describe("--ascii · the notices on stderr", () => {
  it("a hook notice written through writeStderr is ASCII while the mark is on", () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      useAsciiStderr(true);
      writeStderr("la compactación continúa sin checkpoint — refugio: «x»\n");
      useAsciiStderr(false);
      writeStderr("sin la marca — igual\n");
    } finally {
      useAsciiStderr(false);
      spy.mockRestore();
    }
    expect(written[0]).toBe('la compactacion continua sin checkpoint - refugio: "x"\n');
    expect(written[1]).toBe("sin la marca — igual\n");
  });
});
