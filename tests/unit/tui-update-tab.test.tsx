import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { UpdateTab } from "../../src/cli/tui/tabs/update-tab.js";
import type { CliContext } from "../../src/cli/types.js";

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
  it("renderiza versión actual y nombre de paquete", () => {
    const ctx = buildCtx(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { lastFrame } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Update");
    expect(frame).toContain("v5.11.3");
    expect(frame).toContain("@tacuchi/agent-workflow-cli");
  });

  it("auto-corre `npm view <pkg> version` al montar", async () => {
    const invocations: { cmd: string; args: string[] }[] = [];
    const ctx = buildCtx(async (cmd, args) => {
      invocations.push({ cmd, args });
      return { code: 0, stdout: "5.11.3\n", stderr: "" };
    });
    const { lastFrame, unmount } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={() => {}} />,
    );
    // Auto-check al montar — esperar a que termine.
    await new Promise((r) => setTimeout(r, 100));
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations[0]).toEqual({
      cmd: "npm",
      args: ["view", "@tacuchi/agent-workflow-cli", "version"],
    });
    expect(lastFrame()).toContain("al día");
    unmount();
  });

  it("muestra '↑ disponible' cuando latest difiere", async () => {
    const ctx = buildCtx(async () => ({ code: 0, stdout: "5.99.0", stderr: "" }));
    const { lastFrame, unmount } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("v5.99.0");
    expect(frame).toContain("disponible");
    unmount();
  });

  it("tecla 'i' invoca onRequestUpdate cuando hay outdated", async () => {
    const onRequestUpdate = vi.fn();
    const ctx = buildCtx(async () => ({ code: 0, stdout: "5.99.0", stderr: "" }));
    const { stdin, unmount } = render(
      <UpdateTab ctx={ctx} version="5.11.3" isActive={true} onRequestUpdate={onRequestUpdate} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("i");
    await new Promise((r) => setTimeout(r, 50));
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    unmount();
  });
});
