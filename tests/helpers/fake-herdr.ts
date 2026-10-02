import type { RunResult } from "../../src/ports/process.js";
import { FakeProcess } from "./fake-process.js";

/**
 * A Herdr 0.9.0 that answers with the recorded shapes of `workspace list`,
 * `pane list` and `workspace create`, keeping the workspaces it creates so a
 * second run sees them. Ids and paths are synthetic.
 */
export interface FakeWorkspace {
  workspace_id: string;
  label: string;
  panes: { cwd: string; foreground_cwd: string }[];
}

export function fakeHerdr(
  workspaces: FakeWorkspace[],
  overrides: {
    which?: string | undefined;
    version?: string;
    run?: (args: string[]) => RunResult | undefined;
  } = {},
) {
  let created = 0;
  const ok = (result: unknown): RunResult => ({
    code: 0,
    stdout: JSON.stringify({ id: "cli", result }),
    stderr: "",
  });
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";
  const handlers: Record<string, (args: string[]) => RunResult> = {
    "--version": () => ({ code: 0, stdout: `herdr ${overrides.version ?? "0.9.0"}\n`, stderr: "" }),
    "workspace list": () =>
      ok({
        type: "workspace_list",
        workspaces: workspaces.map((w, index) => ({
          workspace_id: w.workspace_id,
          label: w.label,
          number: index + 1,
          pane_count: w.panes.length,
          tab_count: 1,
          focused: false,
          agent_status: "idle",
        })),
      }),
    "pane list": (args) => {
      const id = after(args, "--workspace");
      const panes = workspaces.find((w) => w.workspace_id === id)?.panes ?? [];
      return ok({
        type: "pane_list",
        panes: panes.map((pane, index) => ({
          ...pane,
          pane_id: `${id}:p${index + 1}`,
          workspace_id: id,
        })),
      });
    },
    "workspace create": (args) => {
      const id = `wnew${++created}`;
      const cwd = after(args, "--cwd");
      const label = after(args, "--label");
      workspaces.push({ workspace_id: id, label, panes: [{ cwd, foreground_cwd: cwd }] });
      return ok({
        type: "workspace_created",
        workspace: { workspace_id: id, label },
        root_pane: { pane_id: `${id}:p1` },
      });
    },
    "workspace report-metadata": () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const process = new FakeProcess({
    which: (cmd) => {
      if (cmd !== "herdr") return undefined;
      return "which" in overrides ? overrides.which : "/usr/local/bin/herdr";
    },
    run: (cmd, args) => {
      if (cmd !== "herdr") return { code: 127, stdout: "", stderr: "not found" };
      const handler = handlers[args[0] === "--version" ? "--version" : args.slice(0, 2).join(" ")];
      return (
        overrides.run?.(args) ??
        handler?.(args) ?? { code: 2, stdout: "", stderr: `unexpected herdr ${args.join(" ")}` }
      );
    },
  });
  const herdrCalls = () =>
    process.calls.filter((call) => call.cmd === "herdr").map((call) => call.args);
  return { process, herdrCalls };
}
