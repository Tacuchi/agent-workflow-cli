import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { UpdateTab } from "../../src/cli/tui/tabs/update-tab.js";
import type { CliContext } from "../../src/cli/types.js";

const ENTER = "\r";
const ARROW_DOWN = `${String.fromCharCode(0x1b)}[B`;

function buildCtx(runImpl: CliContext["process"]["run"]): CliContext {
  return {
    fs: {} as never,
    env: {
      homeDir: () => "/home/u",
      cwd: () => "/cwd",
      get: () => undefined,
    },
    process: {
      run: runImpl,
      which: async () => undefined,
    },
    git: {} as never,
    namespace: { namespace: "workflow", source: "default" as const },
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default" as const,
    },
    paths: {} as never,
  };
}

describe("UpdateTab", () => {
  it("solo renderiza 'Buscar actualizaciones' hasta que un check encuentre una versión más reciente", () => {
    const ctx = buildCtx(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { lastFrame } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Buscar actualizaciones");
    expect(frame).not.toContain("(npm install)");
    expect(frame).toContain("v5.11.3");
  });

  it("'Buscar actualizaciones' (Enter sobre item 1) corre `npm view <pkg> version`", async () => {
    const invocations: { cmd: string; args: string[] }[] = [];
    const ctx = buildCtx(async (cmd, args) => {
      invocations.push({ cmd, args });
      return { code: 0, stdout: "5.11.3\n", stderr: "" };
    });
    const { stdin, lastFrame, unmount } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 100));
    expect(invocations).toEqual([
      { cmd: "npm", args: ["view", "@tacuchi/agent-workflow-cli", "version"] },
    ]);
    expect(lastFrame()).toContain("Ya estás en la última versión");
    unmount();
  });

  it("muestra 'hay versión más reciente' cuando latest difiere", async () => {
    const ctx = buildCtx(async () => ({ code: 0, stdout: "5.99.0", stderr: "" }));
    const { stdin, lastFrame, unmount } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toContain("v5.99.0");
    expect(lastFrame()).toContain("disponible");
    unmount();
  });

  it("'Actualizar a vX' aparece tras detectar outdated y Down+Enter llama onRequestUpdate", async () => {
    const onRequestUpdate = vi.fn();
    const ctx = buildCtx(async () => ({ code: 0, stdout: "5.99.0", stderr: "" }));
    const { stdin, lastFrame, unmount } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={onRequestUpdate} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? "").not.toContain("Actualizar a v5.99.0");
    stdin.write(ENTER); // 'Buscar actualizaciones' → detecta outdated
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame() ?? "").toContain("Actualizar a v5.99.0");
    stdin.write(ARROW_DOWN);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 50));
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    unmount();
  });
});
