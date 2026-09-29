import { describe, expect, it, vi } from "vitest";
import { readPublicStatus } from "../../src/cli/tui/public-status.js";
import type { CliContext } from "../../src/cli/types.js";

function context(run: CliContext["process"]["run"]): CliContext {
  return {
    process: { run },
    runtime: { binName: "agent-workflow" },
    paths: { workspaceDir: () => "/fixture" },
  } as unknown as CliContext;
}

const counts = {
  sessions_active: 2,
  sessions_closed: 3,
  sessions_paused: 1,
  sessions_abandoned: 0,
  pending: 1,
};

describe("TUI lee sólo la superficie pública de estado", () => {
  it("proyecta pendientes, siguiente paso y sesiones sin abrir un flow", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        counts,
        pipeline: [{ file: "docs/plans/001-plan.md", detail: { next: "validar F2" } }],
      }),
      stderr: "",
    }));
    expect(await readPublicStatus(context(run as CliContext["process"]["run"]))).toEqual({
      state: "available",
      sessionsLabel: "6 sessions · 2 active",
      pending: 1,
      next: "docs/plans/001-plan.md: validar F2",
    });
    expect(run).toHaveBeenCalledWith("agent-workflow", ["status", "--format", "json"], {
      cwd: "/fixture",
      timeoutMs: 5000,
    });
  });

  it.each([
    "",
    "{}",
    '{"counts":{},"pipeline":[]}',
    "{malformed",
    '{"counts":{"pending":1},"pipeline":[{}]}',
  ])("un estado ausente o malformado muestra vacío/no disponible: %s", async (stdout) => {
    const run = vi.fn(async () => ({ code: 0, stdout, stderr: "" }));
    const summary = await readPublicStatus(context(run as CliContext["process"]["run"]));
    expect(summary).toEqual({
      state: "unavailable",
      sessionsLabel: "— sessions",
      pending: null,
      next: null,
    });
  });

  it("un status fallido tampoco bloquea las demás herramientas", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "no workspace" }));
    expect((await readPublicStatus(context(run as CliContext["process"]["run"]))).state).toBe(
      "unavailable",
    );
  });

  it("un pipeline vacío con contador cero dice que no hay trabajo pendiente", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ counts: { ...counts, pending: 0 }, pipeline: [] }),
      stderr: "",
    }));
    expect((await readPublicStatus(context(run as CliContext["process"]["run"]))).next).toBe(
      "sin trabajo pendiente",
    );
  });
});
