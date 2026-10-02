import { describe, expect, it } from "vitest";
import { HerdrCli } from "../../src/adapters/herdr-cli.js";
import { fakeHerdr } from "../helpers/fake-herdr.js";

/** The Herdr adapter over the recorded 0.9.0 shapes (plan 089 F2). */

describe("HerdrCli", () => {
  it("acepta 0.9.x y declara missing, unsupported-version o cli-changed sin lanzar", async () => {
    expect(await new HerdrCli(fakeHerdr([]).process).probe()).toBeNull();
    expect(await new HerdrCli(fakeHerdr([], { version: "0.9.3" }).process).probe()).toBeNull();
    expect(await new HerdrCli(fakeHerdr([], { which: undefined }).process).probe()).toMatchObject({
      kind: "missing",
    });
    expect(await new HerdrCli(fakeHerdr([], { version: "0.10.0" }).process).probe()).toMatchObject({
      kind: "unsupported-version",
    });
    const noVersion = fakeHerdr([], {
      run: (args) =>
        args[0] === "--version" ? { code: 0, stdout: "herdr\n", stderr: "" } : undefined,
    });
    expect(await new HerdrCli(noVersion.process).probe()).toMatchObject({ kind: "cli-changed" });
  });

  it("lee workspace list y pane list con la forma de 0.9.0", async () => {
    const { process } = fakeHerdr([
      {
        workspace_id: "w1",
        label: "hub:alfa",
        panes: [{ cwd: "/h/alfa", foreground_cwd: "/h/alfa/src" }],
      },
    ]);
    const cli = new HerdrCli(process);
    expect(await cli.listWorkspaces()).toEqual({
      ok: true,
      value: [{ id: "w1", label: "hub:alfa" }],
    });
    expect(await cli.listPanes("w1")).toEqual({
      ok: true,
      value: [{ cwd: "/h/alfa", foreground_cwd: "/h/alfa/src" }],
    });
    expect(await cli.createWorkspace("/h/beta", "hub:beta")).toEqual({ ok: true, value: "wnew1" });
  });

  it("un servidor caído es unreachable y una respuesta con otra forma es cli-changed", async () => {
    const down = fakeHerdr([], {
      run: (args) =>
        args[0] === "workspace"
          ? { code: 1, stdout: "", stderr: "connection refused\n" }
          : undefined,
    });
    expect(await new HerdrCli(down.process).listWorkspaces()).toEqual({
      ok: false,
      degradation: { kind: "unreachable", detail: "workspace list: connection refused" },
    });
    for (const stdout of [
      "no json",
      "{}",
      JSON.stringify({ result: { workspaces: [{ label: "x" }] } }),
    ]) {
      const odd = fakeHerdr([], {
        run: (args) => (args[0] === "workspace" ? { code: 0, stdout, stderr: "" } : undefined),
      });
      expect(await new HerdrCli(odd.process).listWorkspaces()).toMatchObject({
        ok: false,
        degradation: { kind: "cli-changed" },
      });
    }
  });

  it("report-metadata publica con source, TTL y next recortado, y borra next nulo", async () => {
    const { process, herdrCalls } = fakeHerdr([]);
    const cli = new HerdrCli(process);
    await cli.reportMetadata("w1", { pending: 3, next: `/w:plan-exec ${"x".repeat(100)}` });
    await cli.reportMetadata("w1", { pending: 0, next: null });
    const [long, cleared] = herdrCalls();
    expect(long).toEqual([
      "workspace",
      "report-metadata",
      "w1",
      "--source",
      "aw-hubs",
      "--token",
      "pending=3",
      "--token",
      `next=${`/w:plan-exec ${"x".repeat(100)}`.slice(0, 80)}`,
      "--ttl-ms",
      "900000",
    ]);
    expect((long?.[8] ?? "").length).toBe("next=".length + 80);
    expect(cleared).toEqual([
      "workspace",
      "report-metadata",
      "w1",
      "--source",
      "aw-hubs",
      "--token",
      "pending=0",
      "--clear-token",
      "next",
      "--ttl-ms",
      "900000",
    ]);
  });
});
