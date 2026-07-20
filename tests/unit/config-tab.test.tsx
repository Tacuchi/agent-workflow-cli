import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { HOSTS } from "../../src/cli/tui/hosts.js";
import { ConfigTab } from "../../src/cli/tui/tabs/config-tab.js";
import { DEFAULT_TUI_PREFS } from "../../src/cli/tui/tui-prefs.js";
import type { CliContext } from "../../src/cli/types.js";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const tick = () => new Promise((r) => setTimeout(r, 50));
const noop = () => {};
const saveOk = async () => true;

function buildCtx(): CliContext {
  return {
    namespace: { namespace: "workflow", source: "default" },
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    },
    paths: {
      userRuntimeJson: () => "/home/test/.config/agent-workflow/profile.json",
      userLibConfigDir: () => "/tmp",
    },
  } as unknown as CliContext;
}

const ESC = "\x1b";
const MARKERS = { start: "<!-- WORKFLOW-PROJECT-START -->", end: "<!-- WORKFLOW-PROJECT-END -->" };

const DECLARED_DEFAULTS = [
  "- Ramas por defecto:",
  "  - principal: trunk",
  "  - desarrollo: develop",
  "  - qa: release/qa",
];

/** Workspace block with (or without) a `Ramas por defecto` entry. */
function workspaceMd(defaults?: string[]): string {
  return [
    MARKERS.start,
    "## Proyecto",
    "",
    "WS",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    "| core | /src/core | certificacion |",
    "",
    "## Status",
    "",
    ...(defaults ?? []),
    "- Última actividad: 2026-05-26 14:19",
    MARKERS.end,
  ].join("\n");
}

/**
 * ctx of a fully-formed environment with NO workspace block: the hydration
 * effect must reach `readWorkspaceBlock` and get null, instead of dying on a
 * missing ctx.fs/ctx.env (which would make the "hidden section" assertion pass
 * for the wrong reason).
 */
function buildPlainCtx(): CliContext {
  return {
    ...buildCtx(),
    fs: { exists: async () => false, readText: async () => "" },
    env: { cwd: () => "/plain", homeDir: () => "/home" },
    paths: {
      userRuntimeJson: () => "/home/test/.config/agent-workflow/profile.json",
      userLibConfigDir: () => "/tmp",
      blockMarkers: () => MARKERS,
    },
  } as unknown as CliContext;
}

/** ctx of a real workspace → the RAMAS section renders. */
function buildWorkspaceCtx(defaults?: string[]): CliContext {
  return {
    ...buildCtx(),
    fs: {
      exists: async (p: string) => p === "/ws/CLAUDE.md",
      readText: async () => workspaceMd(defaults),
    },
    env: { cwd: () => "/ws", homeDir: () => "/home" },
    paths: {
      userRuntimeJson: () => "/home/test/.config/agent-workflow/profile.json",
      userLibConfigDir: () => "/tmp",
      blockMarkers: () => MARKERS,
    },
  } as unknown as CliContext;
}

/** ↓ presses needed to land on the first RAMAS row (accent, initialScreen, namespace, hosts…). */
const DOWNS_TO_FIRST_BRANCH = 3 + HOSTS.length;

async function pressDown(stdin: { write: (s: string) => void }, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    stdin.write(DOWN);
    await tick();
  }
}

describe("ConfigTab — sección RAMAS (workspace)", () => {
  it("no muestra la sección ni añade controles fuera de un workspace", async () => {
    const { lastFrame } = render(
      <ConfigTab
        ctx={buildPlainCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("RAMAS");
    expect(frame).not.toContain("Rama principal");
    // Sin workspace las 3 filas tampoco son navegables.
    expect(frame).toContain(`${3 + HOSTS.length} settings`);
  });

  it("muestra los 3 roles con los defaults declarados en el bloque WORKSPACE", async () => {
    const { lastFrame } = render(
      <ConfigTab
        ctx={buildWorkspaceCtx(DECLARED_DEFAULTS)}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("RAMAS (WORKSPACE)"); // SectionHead uppercases
    for (const label of ["Rama principal", "Rama de desarrollo", "Rama QA"]) {
      expect(frame).toContain(label);
    }
    for (const value of ["trunk", "develop", "release/qa"]) {
      expect(frame).toContain(value);
    }
  });

  it("cae a main/development/qa cuando el bloque no declara defaults", async () => {
    const { lastFrame } = render(
      <ConfigTab
        ctx={buildWorkspaceCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("main");
    expect(frame).toContain("development");
    expect(frame).toContain("qa");
  });

  it("⏎ sobre un rol lo edita y persiste SOLO ese rol", async () => {
    const onSaveBranchDefaults = vi.fn().mockResolvedValue(true);
    const { stdin, lastFrame } = render(
      <ConfigTab
        ctx={buildWorkspaceCtx(DECLARED_DEFAULTS)}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={onSaveBranchDefaults}
      />,
    );
    await tick();
    // Editamos «Rama principal» (1ª fila) y escribimos un valor NUEVO: ni la clave
    // ni el valor esperados coinciden con ningún default, así que la aserción no
    // puede pasar por una constante.
    await pressDown(stdin, DOWNS_TO_FIRST_BRANCH);
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").toContain("Rama principal");
    stdin.write("-2026"); // se añade al valor precargado
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSaveBranchDefaults).toHaveBeenCalledWith({ principal: "trunk-2026" });
    expect(onSaveBranchDefaults).toHaveBeenCalledTimes(1);
    // La fila adopta el valor nuevo; los otros dos roles siguen intactos.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("trunk-2026");
    expect(frame).toContain("develop");
    expect(frame).toContain("release/qa");
  });

  it("mantiene el valor anterior cuando el guardado falla", async () => {
    const onSaveBranchDefaults = vi.fn().mockResolvedValue(false);
    const { stdin, lastFrame } = render(
      <ConfigTab
        ctx={buildWorkspaceCtx(DECLARED_DEFAULTS)}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={onSaveBranchDefaults}
      />,
    );
    await tick();
    await pressDown(stdin, DOWNS_TO_FIRST_BRANCH);
    stdin.write(ENTER);
    await tick();
    stdin.write("-2026");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSaveBranchDefaults).toHaveBeenCalledWith({ principal: "trunk-2026" });
    // Sin escritura confirmada la fila NO miente.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("trunk");
    expect(frame).not.toContain("trunk-2026");
  });

  it("esc cancela la edición sin persistir", async () => {
    const onSaveBranchDefaults = vi.fn().mockResolvedValue(true);
    const { stdin, lastFrame } = render(
      <ConfigTab
        ctx={buildWorkspaceCtx(DECLARED_DEFAULTS)}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={onSaveBranchDefaults}
      />,
    );
    await tick();
    await pressDown(stdin, DOWNS_TO_FIRST_BRANCH + 1); // Rama de desarrollo
    stdin.write(ENTER);
    await tick();
    stdin.write("otra-rama");
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onSaveBranchDefaults).not.toHaveBeenCalled();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("develop");
    expect(frame).not.toContain("otra-rama");
  });

  it("rechaza un nombre de rama con espacios y no persiste", async () => {
    const onSaveBranchDefaults = vi.fn().mockResolvedValue(true);
    const { stdin, lastFrame } = render(
      <ConfigTab
        ctx={buildWorkspaceCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={onSaveBranchDefaults}
      />,
    );
    await tick();
    await pressDown(stdin, DOWNS_TO_FIRST_BRANCH);
    stdin.write(ENTER);
    await tick();
    stdin.write(" rama mala");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").toContain("sin espacios");
    expect(onSaveBranchDefaults).not.toHaveBeenCalled();
  });
});

describe("ConfigTab", () => {
  it("renders the sections, workspace info and host list (no density)", () => {
    const { lastFrame } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    const frame = lastFrame() ?? "";
    for (const label of [
      "APPEARANCE",
      "Accent color",
      "ON OPEN",
      "Initial screen",
      "WORKSPACE",
      "Namespace",
      "Profile",
      "Claude Code",
    ]) {
      expect(frame).toContain(label);
    }
    expect(frame).not.toContain("Density");
    expect(frame).toContain("workflow"); // namespace value
    expect(frame).toContain("profile.json");
  });

  it("→ on the focused accent cycles to the next color (violet → cyan)", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={onChange}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    stdin.write(RIGHT);
    await tick();
    expect(onChange).toHaveBeenCalledWith({ accentColor: "cyan" });
  });

  it("toggles a backed host into disabledHosts", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={onChange}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    // accent(0) → initialScreen(1) → namespace(2) → claude(3)
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(" ");
    await tick();
    expect(onChange).toHaveBeenCalledWith({ disabledHosts: ["claude"] });
  });

  it("enter on namespace opens edit mode and submit persists it", async () => {
    const onSaveNamespace = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={onSaveNamespace}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    stdin.write(DOWN); // → initialScreen
    await tick();
    stdin.write(DOWN); // → namespace
    await tick();
    stdin.write(ENTER); // open edit
    await tick();
    stdin.write(ENTER); // submit default value
    await tick();
    expect(onSaveNamespace).toHaveBeenCalledWith("workflow");
  });

  it("r resets all prefs to defaults", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={onChange}
        onSaveNamespace={noop}
        onSaveBranchDefaults={saveOk}
      />,
    );
    await tick();
    stdin.write("r");
    await tick();
    expect(onChange).toHaveBeenCalledWith(DEFAULT_TUI_PREFS);
  });
});
