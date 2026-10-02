import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextCommandOf } from "../../src/application/flow/advance.js";
import { startFlow } from "../../src/application/flow/flow-start.js";
import { PathsService } from "../../src/application/paths-service.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import { commandHelpText } from "../../src/cli/help-groups.js";
import type { FlowRunState } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { COUNTED_FLOWS, openMeasuredRun } from "../helpers/agent-calls.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { stateWrittenAt } from "../helpers/journey-fixtures.js";
import { NodeFileSystem } from "../helpers/real-fs.js";
import { testExecutor } from "../helpers/test-executor.js";

/**
 * A run opens in one invocation and closes naming the command that follows
 * (plan 082 F7 · spec 061 AC-09, AC-10, AC-11). Run after `npm run build`.
 */

const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");
const run = promisify(execFile);
const fs = new NodeFileSystem();

let root: string;
let home: string;
let paths: PathsService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aw-flow-start-"));
  home = mkdtempSync(join(tmpdir(), "aw-flow-start-home-"));
  paths = new PathsService(normalizeNamespace("workflow"), root, root);
  mkdirSync(join(root, ".workflow", "sessions"), { recursive: true });
  writeFileSync(join(root, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
  mkdirSync(join(root, "docs", "specs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "specs", "031-spec-correo.md"),
    "---\nstatus: ready-for-plan\n---\n# Spec 031\n\n## Acceptance criteria\n\n- [ ] AC-01: el correo llega.\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("aw flow start — one invocation opens the run", () => {
  it("creates the session, seeds it, adopts the run and hands the read-set and the first directive", async () => {
    const started = await startFlow(
      { fs, paths, git: new RecordingGit() },
      testExecutor(fs, paths),
      {
        flow: "plan-new",
        name: "correo",
        objetivo: "planear el correo",
      },
    );
    if (!started.ok) throw new Error(JSON.stringify(started));
    const { session, read_set, bytes_to_read, directive } = started.data;
    expect(session.resumed).toBe(false);
    expect(session.folder).toMatch(/^\d{3}-correo-plan-new$/);
    expect(session.created?.inputs).toEqual(["docs/specs/031-spec-correo.md"]);
    // The command's guide is not sent again: the host already loaded it.
    expect(read_set.filter((entry) => entry.loaded).map((entry) => entry.path)).toEqual([
      "commands/plan-new.md",
    ]);
    expect(bytes_to_read).toBe(
      read_set.filter((entry) => !entry.loaded).reduce((n, entry) => n + entry.bytes, 0),
    );
    expect(directive.session).toBe(session.folder);
    expect(directive.boundary.transition).toBe("chassis.route-evaluation");
    const seeded = readFileSync(join(paths.cwdSessionsDir(), session.folder, "SESSION.md"), "utf8");
    expect(seeded).toContain("- [ ] AC-01: el correo llega.");
  });

  it("an active session with the same descriptor is resumed, never duplicated", async () => {
    const deps = { fs, paths, git: new RecordingGit() };
    const input = { flow: "plan-new" as const, name: "correo", objetivo: "planear el correo" };
    const first = await startFlow(deps, testExecutor(fs, paths), input);
    const again = await startFlow(deps, testExecutor(fs, paths), input);
    if (!first.ok || !again.ok) throw new Error("esperaba abrir la corrida");
    expect(again.data.session).toMatchObject({ folder: first.data.session.folder, resumed: true });
  });

  it("a numbered or suffixed --name is normalized, so it resumes instead of doubling", async () => {
    const deps = { fs, paths, git: new RecordingGit() };
    const numbered = { flow: "quick" as const, name: "028-z", objetivo: "o" };
    const first = await startFlow(deps, testExecutor(fs, paths), numbered);
    const again = await startFlow(deps, testExecutor(fs, paths), numbered);
    if (!first.ok || !again.ok) throw new Error("esperaba abrir la corrida");
    expect(first.data.session.folder).toMatch(/^\d{3}-z-quick$/);
    expect(again.data.session).toMatchObject({ folder: first.data.session.folder, resumed: true });
    const suffixed = await startFlow(deps, testExecutor(fs, paths), {
      flow: "quick",
      name: "x-quick",
      objetivo: "o",
    });
    if (!suffixed.ok) throw new Error(JSON.stringify(suffixed));
    expect(suffixed.data.session.folder).toMatch(/^\d{3}-x-quick$/);
  });

  it("refuses --code and --session: start names its session by --name", async () => {
    const out = await run(
      process.execPath,
      [
        CLI,
        "flow",
        "start",
        "--flow",
        "quick",
        "--name",
        "z",
        "--objetivo",
        "o",
        "--code",
        "001",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
    ).catch((error: { stdout: string }) => error);
    expect(JSON.parse(out.stdout).error.code).toBe("ARGS_INVALID");
  });

  it("through the binary: one call, JSON out, exit 0", async () => {
    const { stdout } = await run(
      process.execPath,
      [CLI, "flow", "start", "--flow", "plan-new", "--name", "correo", "--objetivo", "x", "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const data = JSON.parse(stdout);
    expect(data.session.folder).toMatch(/-correo-plan-new$/);
    expect(data.directive.boundary.transition).toBe("chassis.route-evaluation");
  });

  it("its help carries the F2 contract", () => {
    const help = commandHelpText(flowCommand, "start");
    expect(help).toContain("Usage: aw flow start");
    for (const flag of [
      "--name <slug>",
      "--objetivo <text>",
      "--input <path>",
      "--from <origin>",
    ]) {
      expect(help).toContain(flag);
    }
    expect(help).toMatch(/^Output \(JSON data\): \{session/m);
  });
});

describe("the final directive names the command that follows", () => {
  const EXPECTED: Record<string, RegExp> = {
    "spec-refine": /siguiente comando: \/w:plan-new docs\/specs\/001-spec-medida\.md/,
    "plan-new": /siguiente comando: \/w:plan-exec docs\/plans\/001-plan-medida\.md/,
    "plan-refine": /siguiente comando: \/w:plan-exec docs\/plans\/001-plan-medida\.md/,
    "plan-exec": /siguiente comando: ninguno/,
    quick: /siguiente comando: ninguno/,
  };

  it("in each of the five flows, walked to its end", async () => {
    for (const flow of COUNTED_FLOWS) {
      const measured = await openMeasuredRun(flow);
      try {
        let directive = measured.opened;
        for (let step = 0; step < 60; step += 1) {
          const { resolved } = await measured.current();
          if (resolved.stopped === null) break;
          const plan = await measured.answerFor(directive, resolved);
          const result = await measured.submit(plan.raw, plan.approval);
          if (!result.ok) throw new Error(JSON.stringify(result));
          directive = result.directive;
        }
        expect(directive.next_action, flow).toMatch(EXPECTED[flow] as RegExp);
      } finally {
        await measured.dispose();
      }
    }
  }, 120_000);

  function finished(flow: FlowRunState["flow"], extra: Partial<FlowRunState>): FlowRunState {
    return stateWrittenAt(12, flow, `001-x-${flow}`, [], null, extra);
  }

  it("sibling plans are alternatives, never one chosen", () => {
    const state = finished("plan-new", {
      events: [
        {
          kind: "executed",
          transition: "plan-new.publication",
          operation: "proposal.publish",
          summary: "publicado",
          published: ["docs/plans/010-plan-a.md", "docs/plans/011-plan-b.md"],
          output_digest: "x",
          effects: ["local_additive"],
          evidence: [],
        },
      ] as FlowRunState["events"],
    });
    expect(nextCommandOf(state)).toBe(
      "/w:plan-exec docs/plans/010-plan-a.md o /w:plan-exec docs/plans/011-plan-b.md",
    );
  });

  it("an escalated quick names its destination", () => {
    const state = finished("quick", {
      handoff: {
        destination: "spec-new",
        command: "/w:spec-new",
        package: {} as never,
        package_digest: "x",
      },
    });
    expect(nextCommandOf(state)).toBe("/w:spec-new");
  });
});
