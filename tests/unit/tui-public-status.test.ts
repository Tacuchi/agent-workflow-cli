import { describe, expect, it, vi } from "vitest";
import { readPending } from "../../src/cli/tui/public-status.js";
import type { CliContext } from "../../src/cli/types.js";

function context(run: CliContext["process"]["run"]): CliContext {
  return {
    process: { run },
    runtime: { binName: "aw" },
    paths: { hubDir: () => "/fixture" },
  } as unknown as CliContext;
}

const statusOf = (stdout: string, code = 0) =>
  vi.fn(async () => ({ code, stdout, stderr: "" })) as unknown as CliContext["process"]["run"];

describe("la TUI lee los pendientes solo por la superficie pública", () => {
  it("proyecta archivo, siguiente paso y comando por subproceso, sin contadores", async () => {
    const run = statusOf(
      JSON.stringify({
        pipeline: [
          {
            file: "docs/plans/001-plan.md",
            command: "/w:plan-exec docs/plans/001-plan.md",
            detail: { next: "validar F2" },
          },
          { file: "docs/specs/002-spec.md", detail: { next: "refinar" } },
        ],
      }),
    );
    expect(await readPending(context(run))).toEqual({
      state: "available",
      items: [
        {
          file: "docs/plans/001-plan.md",
          next: "validar F2",
          command: "/w:plan-exec docs/plans/001-plan.md",
        },
        { file: "docs/specs/002-spec.md", next: "refinar", command: null },
      ],
    });
    expect(run).toHaveBeenCalledWith("aw", ["status", "--format", "json"], {
      cwd: "/fixture",
      timeoutMs: 5000,
    });
  });

  it("el JSON compacto sin pipeline es un hub sin pendientes", async () => {
    expect(await readPending(context(statusOf("{}")))).toEqual({ state: "available", items: [] });
  });

  it.each(["", "{malformed", "[]", '{"pipeline":{}}', '{"pipeline":[{}]}'])(
    "un estado malformado queda no disponible: %s",
    async (stdout) => {
      expect(await readPending(context(statusOf(stdout)))).toEqual({ state: "unavailable" });
    },
  );

  it("un status fallido no rompe la pantalla", async () => {
    expect((await readPending(context(statusOf("", 1)))).state).toBe("unavailable");
  });
});
