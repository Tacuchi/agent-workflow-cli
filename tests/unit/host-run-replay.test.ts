// Replays of the screens and logs of the s280 third run (2026-09-30T00-48-39Z),
// rebuilt synthetically in their shape (no transcript content is copied): the
// run misjudged far more than the hosts failed. Each case pins the corrected
// judgment — a step never sent or never started is not-reached with a reason,
// a first-run screen waits for the person, claude's tabbed question gets only
// its content answer, evidence comes from what the host did while its pane ran.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLOW_TAB_NOTICE,
  classify,
  currentBlock,
  readyForInput,
  tabbedQuestion,
} from "../../scripts/host-run/classifier.mjs";
import { HOSTS } from "../../scripts/host-run/hosts.mjs";
import { nodeFs, planIsolation, prepareHost } from "../../scripts/host-run/isolation.mjs";
import {
  MODEL_FAILED,
  NOT_SUBMITTED,
  collectEvidence,
  evidenceOf,
  inputNotSubmitted,
  recallRelayed,
  tick,
} from "../../scripts/host-run/live.mjs";
import { catalogStates, judgeSurface } from "../../scripts/host-run/matrix.mjs";
import { PROFILES } from "../../scripts/host-run/profiles/index.mjs";
import { STEPS, stepForHost } from "../../scripts/host-run/scenario.mjs";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "host-run-replay-")));
  dirs.push(d);
  return d;
};
const RULE = "─".repeat(60);
const claudeQuestion = { rule: "claude.question" };
const quick = STEPS.find((s: { surface: string }) => s.surface === "structured-choice");

/** claude 2.1.285's AskUserQuestion with a content tab and Workline's flow tab. */
const CLAUDE_TABBED = [
  "❯ /w:quick Rediseñar la arquitectura completa del CLI en varias fuentes…",
  RULE,
  "←  ☐ Alcance  ☐ flow  ✔ Submit  →",
  "│ El objetivo excede un quick. ¿Cómo seguimos?",
  "❯ 1. Cambiar a SPEC (Recomendado)",
  "     Captura el rediseño como spec draft.",
  "  2. Seguir en quick",
  "     Abre una sesión quick con el objetivo completo.",
  "  3. Recortar alcance",
  "     Reduce la tarea a la subtarea indicada.",
  "  4. Type something.",
  RULE,
  "  5. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

const CLAUDE_FLOW_TAB = [
  "←  ☒ Alcance  ☐ flow  ✔ Submit  →",
  "│ Control de flujo",
  "❯ 1. Compactar",
  "     Conservar el estado para retomarlo.",
  "  2. Cerrar",
  "     Terminar aquí.",
  "  3. Type something.",
  RULE,
  "  4. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

describe("host-run replay: claude's tabbed question", () => {
  it("the content tab gets the arrows onto Recortar alcance; the flow controls are in their tab", () => {
    expect(tabbedQuestion(CLAUDE_TABBED)).toEqual({
      tabs: ["Alcance", "flow", "Submit"],
      flowTab: true,
    });
    // The rule line inside the selector no longer cuts the block.
    expect(currentBlock(CLAUDE_TABBED).some((l: string) => l.includes("Recortar alcance"))).toBe(
      true,
    );
    const step = stepForHost(quick, "claude-code");
    const d = classify(
      { host: "claude-code", state: "blocked", screen: CLAUDE_TABBED, explain: claudeQuestion },
      step,
    );
    expect(d).toMatchObject({
      action: "send-keys",
      boundary: "quick.gate-choice",
      label: "Recortar alcance",
      keys: ["down", "down"],
    });
  });

  it("the flow tab is left to the person", () => {
    const step = stepForHost(quick, "claude-code");
    const d = classify(
      { host: "claude-code", state: "blocked", screen: CLAUDE_FLOW_TAB, explain: claudeQuestion },
      step,
    );
    expect(d).toEqual({ action: "notify", reason: FLOW_TAB_NOTICE });
  });
});

describe("host-run replay: codex's gate as labeled markdown", () => {
  const CODEX_MARKDOWN_GATE = [
    "› $w-quick Rediseñar la arquitectura completa del CLI…",
    "• Diagnóstico: 6 sanos, 1 advertencia, 0 bloqueos.",
    "  No abrí una sesión ni creé NOTES.md: queda pendiente elegir el alcance.",
    "",
    "  Alcance",
    "",
    "  • Cambiar a SPEC (recomendado) — Especificar el rediseño completo.",
    "  • Seguir en quick — Mantener el objetivo completo dentro del flujo quick.",
    "  • Recortar alcance — Crear únicamente NOTES.md con la línea host-run.",
    "",
    "  Reparación",
    "",
    "  • codex/mcps/workspace:host-run-probe — Preparar la reparación.",
    "",
    "  Control",
    "",
    "  • Compactar — Conservar el estado para retomarlo.",
    "  • Cerrar — Terminar aquí.",
    "",
    "  El selector no admite esta aprobación en el modo actual; presento las opciones en Markdown.",
    "",
    "› Ask Codex to do anything",
    "  GPT-6-Astra default · /workspace",
    "  ? for shortcuts",
  ].join("\n");

  it("the labels at the end of its last reply get the label typed back (degraded, labeled markdown)", () => {
    const d = classify(
      { host: "codex", state: "idle", screen: CODEX_MARKDOWN_GATE, explain: null },
      stepForHost(quick, "codex"),
    );
    expect(d).toMatchObject({
      action: "prompt",
      boundary: "quick.gate-choice",
      text: "Recortar alcance",
    });
  });
});

describe("host-run replay: first-run screens wait for the person", () => {
  it("crush's «initialize now?» and agy's terms screen are never answered", () => {
    const crushInit = [
      "  When I initialize your codebase I examine the project and",
      "  put the result into an AGENTS.md file.",
      "  Would you like to initialize now?",
      "    Yep!     Nope",
    ].join("\n");
    const agyTerms = [
      " Terms of Service & Data Use",
      " AI coding agents are known to have certain security risks.",
      "   > [x] Yes, I agree to help improve Antigravity CLI by allowing",
      "     [Previous]      [Done]",
      "   ↑/↓ Navigate · enter Toggle",
    ].join("\n");
    for (const [host, screen] of [
      ["crush", crushInit],
      ["gemini", agyTerms],
    ] as const) {
      const pane = { host, state: "idle", screen, screenOnly: host === "crush" };
      expect(readyForInput(pane).ok, host).toBe(false);
      expect(classify(pane, null).action, host).toBe("notify");
    }
  });

  it("crush's init flag is pre-seeded in the workspace, so the question does not come", async () => {
    const dir = temp();
    const p = planIsolation({
      hostId: "crush",
      root: join(dir, "aw-host-run-r1-crush-S"),
      checkout: "/checkout",
      node: process.execPath,
      hostBin: "/opt/crush",
      realHome: join(dir, "no-home"),
      profile: PROFILES.crush,
    });
    await prepareHost({ ...p, steps: [] }, { fs: nodeFs(), run: async () => ({ status: 0 }) });
    expect(JSON.parse(readFileSync(join(p.workspace, ".crush", "init"), "utf8"))).toEqual({
      initialized: true,
    });
  });
});

/** A live context with scripted screens, as the live loop reads them. */
function replayCtx(screens: { state: string; screen: string }[], clock: { t: number }) {
  const sent: string[] = [];
  const notified: string[] = [];
  return {
    sent,
    notified,
    ctx: {
      steps: STEPS,
      answers: new Set(),
      now: () => clock.t,
      sleep: async () => {},
      transcript: () => {},
      notify: (id: string, m: string) => notified.push(`${id}: ${m}`),
      herdr: {
        snapshot: (host: string) => ({
          host,
          explain: null,
          ...(screens.length > 1 ? screens.shift() : screens[0]),
        }),
        prompt: (pane: string, text: string) => sent.push(`${pane} prompt ${text}`),
        keys: () => {},
      },
    },
  };
}

const host = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  pane: "p1",
  home: "/nonexistent/home",
  workspace: "/nonexistent/ws",
  phase: "send",
  stepIndex: 0,
  evidence: {},
  screensBySurface: {},
  ...over,
});

describe("host-run replay: a step is judged only once it started", () => {
  it("codex: the bare invocation left in the input is never completed from files; the person is told", async () => {
    const clock = { t: 0 };
    const typed = "› $w-doctor\n  GPT-6-Astra default · /workspace";
    const { ctx, notified } = replayCtx(
      [
        { state: "idle", screen: "› Ask Codex to do anything\n  GPT-6-Astra default · /workspace" },
        { state: "idle", screen: typed },
      ],
      clock,
    );
    const h = host("codex");
    await tick(ctx, [h]);
    expect(h.phase).toBe("await");
    for (let i = 0; i < 20; i++) {
      clock.t += 5_000;
      await tick(ctx, [h]);
    }
    // Idle for 100 s, never working: the step is still open, not «broken».
    expect(h.phase).toBe("await");
    expect(h.evidence).toEqual({});
    expect(inputNotSubmitted(typed, "$w-doctor")).toBe(true);
    expect(notified).toContain(`codex: ${NOT_SUBMITTED}`);
    // At the timeout it is not reached, with why.
    clock.t += 16 * 60 * 1000;
    await tick(ctx, [h]);
    expect(h.evidence.commands).toEqual({
      reached: false,
      reason: "the step's input was never submitted",
    });
    expect(judgeSurface("commands", h.evidence.commands)).toBe("not-reached");
  });

  it("waiting on a permission pauses the step's clock: 20 minutes on it is no timeout", async () => {
    const clock = { t: 0 };
    const permission = [
      "  Would you like to run the following command?",
      "  $ aw doctor --host codex --format human",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    const { ctx } = replayCtx(
      [
        { state: "idle", screen: "› Ask Codex to do anything" },
        { state: "working", screen: "• Working" },
        { state: "blocked", screen: permission },
      ],
      clock,
    );
    const h = host("codex");
    await tick(ctx, [h]);
    for (let i = 0; i < 240; i++) {
      clock.t += 5_000;
      await tick(ctx, [h]);
    }
    expect(h.phase).toBe("await");
    expect(h.evidence.commands).toBeUndefined();
  });

  it("a host whose model call failed: its step is not reached, never broken", async () => {
    const clock = { t: 0 };
    const { ctx } = replayCtx(
      [
        { state: "idle", screen: "> " },
        { state: "working", screen: "Build · thinking" },
        {
          state: "idle",
          screen: "┃ * Quota exceeded for metric: generativelanguage…, limit: 0\n> ",
        },
      ],
      clock,
    );
    const h = host("opencode");
    for (let i = 0; i < 4; i++) {
      clock.t += 5_000;
      await tick(ctx, [h]);
    }
    expect(h.evidence.commands).toEqual({ reached: false, reason: MODEL_FAILED });
  });

  it("a host that was never sent a step: every cell not-reached with the reason", () => {
    const catalog = catalogStates(HARNESSES, capabilitiesFor);
    const agy = host("gemini", { phase: "held", heldReason: "a first-run screen stayed on" });
    const { matrix } = evidenceOf(
      {
        runId: "r3",
        date: "2026-09-30",
        cli: { version: "28.0.0", revision: "f1caa78" },
        digest: "d",
        catalog,
        steps: STEPS,
        labels: Object.fromEntries(HARNESSES.map((x) => [x.id, x.label])),
        realHome: "/Users/someone",
        username: "someone",
      },
      [agy],
    );
    for (const cell of Object.values(matrix.hosts.gemini.cells) as {
      state: string;
      not_reached_reason?: string;
    }[]) {
      expect(cell.state).toBe("not-reached");
      expect(cell.not_reached_reason).toBe("a first-run screen stayed on");
    }
  });
});

describe("host-run replay: evidence from what the host did while its pane ran", () => {
  function homeWithLog(lines: string[]) {
    const home = join(temp(), "home");
    mkdirSync(join(home, ".workflow", "logs"), { recursive: true });
    mkdirSync(join(home, ".host-run"), { recursive: true });
    writeFileSync(
      join(home, ".workflow", "logs", "agent-workflow-2026-09-30.log"),
      lines.join("\n"),
    );
    return home;
  }

  it("hooks: the guard's log line counts only after the pane opened; READ_ONLY_POLICY is the MCP server, not the hook", () => {
    const preparation = "2026-09-30T00:48:50.000Z INFO mcp request --arguments=<redacted>";
    const home = homeWithLog([preparation]);
    const h = { id: "codex", home, workspace: "/ws", logStart: preparation.length };
    const screen =
      'Failed host-run-probe.execute_sql\n {"success":false,"code":"READ_ONLY_POLICY"}';
    // codex never ran the guard (its hooks are not armed): no hook line.
    expect(collectEvidence("hooks", h, { screens: [screen] }).lines.PreToolUse).toBe(false);
    // Its MCP server answered: that is the mcp surface's evidence.
    expect(collectEvidence("mcp", h, { screens: [screen] }).serverReached).toBe(true);
    // A guard that ran logs `hook sql-mutation-guard` in the home's log.
    writeFileSync(
      join(home, ".workflow", "logs", "agent-workflow-2026-09-30.log"),
      [preparation, "2026-09-30T00:57:31.000Z INFO hook sql-mutation-guard"].join("\n"),
    );
    expect(collectEvidence("hooks", h, { screens: [screen] }).lines.PreToolUse).toBe(true);
  });

  it("mcp: the setup's own `mcp request` (before the pane) and its receipt are not evidence", () => {
    const preparation = "2026-09-30T00:48:50.000Z INFO mcp request --arguments=<redacted>";
    const home = homeWithLog([preparation]);
    const h = { id: "crush", home, workspace: "/ws", logStart: preparation.length };
    // The tool names in a sidebar alone, with no server reached, are degraded.
    const e = collectEvidence("mcp", h, { screens: ["● execute_sql ● search_objects"] });
    expect(e).toEqual({ toolsListed: true, serverReached: false });
    expect(judgeSurface("mcp", e)).toBe("degraded");
  });

  it("commands: the wrapper ran the CLI's doctor during the step, even when claude folds the report", () => {
    const home = homeWithLog([]);
    writeFileSync(
      join(home, ".host-run", "shim-calls.log"),
      "/r/bin/aw doctor --host claude-code --format human\n",
    );
    const h = { id: "claude-code", home, workspace: "/ws" };
    const folded = "❯ /w:doctor\n  Ran 1 shell command\n⏺ Reporte relayado arriba tal cual.";
    const e = collectEvidence("commands", h, { screens: [folded], shimStart: 0 });
    expect(e).toMatchObject({ ran: true, relayed: false });
    expect(judgeSurface("commands", e)).toBe("works");
  });

  it("host-memory: rows relayed in Spanish count («Ausente», «desactivada»)", () => {
    const screen = [
      " Claude Code             Ausente: no existe .claude/projects.",
      " Gemini / Antigravity    Ausente en esta máquina.",
      " OpenCode                Ausente en esta máquina.",
    ].join("\n");
    expect(recallRelayed(screen, "/r/bin/aw host-memory --host codex --json\n")).toBe(true);
  });

  it("declared_by_doctor: read from any relay the host showed, or from the CLI's doctor when it folds it", () => {
    const catalog = catalogStates(HARNESSES, capabilitiesFor);
    const relay = [
      "• Hosts",
      "  → Codex · ready · runtime available 0.157.1 · Workline instalado",
      "      hooks degraded — host supports hooks; Workline generates its plugin bundle instead",
      "  Cobertura",
    ].join("\n");
    const base = {
      runId: "r3",
      date: "2026-09-30",
      cli: { version: "28.0.0", revision: "f1caa78" },
      digest: "d",
      catalog,
      steps: STEPS,
      labels: Object.fromEntries(HARNESSES.map((x) => [x.id, x.label])),
      realHome: "/Users/someone",
      username: "someone",
    };
    const codex = host("codex", { relays: [relay], evidence: { hooks: { lines: {} } } });
    const fromRelay = evidenceOf(base, [codex]).matrix.hosts.codex.cells.hooks;
    expect(fromRelay).toMatchObject({ declared_by_doctor: true, declared_source: "relay" });
    // A host that folded its relay: the CLI's doctor in that home declares it.
    const folded = host("codex", { evidence: { hooks: { lines: {} } } });
    const fromCli = evidenceOf({ ...base, cliDoctorText: () => relay }, [folded]).matrix.hosts.codex
      .cells.hooks;
    // AC-05: only the host's own relay declares; the CLI's doctor is support only.
    expect(fromCli).toMatchObject({
      declared_by_doctor: false,
      declared_source: "cli",
      state: "degraded-undeclared",
    });
  });
});

describe("host-run replay: the profiles and invocations the run needed", () => {
  it("opencode runs and probes an OpenAI model from its catalog; a key goes only to its wrapper", () => {
    const base = {
      hostId: "opencode",
      root: "/tmp/r/aw-host-run-r1-opencode-O",
      checkout: "/checkout",
      node: "/usr/local/bin/node",
      hostBin: "/opt/opencode",
      realHome: "/Users/someone",
      profile: PROFILES.opencode,
    };
    const own = planIsolation(base);
    expect(own.model).toBe("openai/gpt-6-astra");
    expect(own.pane.launchLine).toContain("--model openai/gpt-6-astra");
    const probe = own.steps.find((s: { kind: string }) => s.kind === "auth-probe");
    expect(probe.args).toEqual([
      "run",
      "-m",
      "openai/gpt-6-astra",
      "Reply with the single word ok.",
    ]);
    const keyed = planIsolation({
      ...base,
      tokenPresent: true,
      token: HOSTS.opencode.tokenChoices[0],
    });
    expect(keyed.secret).toMatchObject({ host: "opencode", var: "OPENAI_API_KEY" });
    expect(keyed.pane.launchLine).not.toContain("OPENAI_API_KEY");
    expect(planIsolation({ ...base, model: "openai/gpt-5.6" }).model).toBe("openai/gpt-5.6");
  });

  it("codex may write the disposable home's .workflow; claude does not ask on --root at the bundle", () => {
    const codexToml = PROFILES.codex
      .files({ realHome: "/Users/someone", siblingRoots: [], workspace: "/r/ws", home: "/r/home" })
      .map((f: { value: unknown }) => String(f.value))
      .join("\n");
    expect(codexToml).toContain('"/r/home/.workflow/dev" = "write"');
    expect(codexToml).not.toContain('"/r/home/.workflow" = "write"');
    expect(codexToml).not.toMatch(/\.workflow\/logs"\s*=\s*"write"/);
    const ask = PROFILES["claude-code"].effective({
      workspace: "/r/ws",
      realHome: "/Users/someone",
      siblingRoots: ["/r/other"],
    }).ask;
    expect(ask).not.toContain("Bash(aw *--root*)");
    expect(ask).toContain("Bash(aw *--root /Users/someone*)");
    expect(ask).toContain("Bash(aw *--root /r/other*)");
    expect(ask).toContain("Bash(aw *--hub*)");
  });

  it("codex's bare invocations carry text after the mention, so Enter submits them", () => {
    const text = (surface: string) =>
      stepForHost(
        STEPS.find((s: { surface: string }) => s.surface === surface),
        "codex",
      ).invocation.text;
    // doctor carries its own argument (`detalle`); the rest say there is none.
    expect(text("commands")).toBe("$w-doctor detalle");
    expect(text("host-memory")).toMatch(/^\$w-\w+ \(no arguments\)$/);
    // /compact stays alone (codex's own compaction command).
    const compact = STEPS.find((s: { surface: string }) => s.surface === "compaction");
    expect(stepForHost(compact, "codex").invocation.text).toBe("/compact");
  });
});

describe("host-run review AC1–AC6", () => {
  it("AC1: the root's aw refuses every --root/--hub outside the root, whatever its form", async () => {
    const { symlinkSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const dir = temp();
    const root = join(dir, "aw-host-run-r1-claude-code-G");
    const p = planIsolation({
      hostId: "claude-code",
      root,
      checkout: "/checkout",
      node: process.execPath,
      hostBin: "/opt/claude",
      realHome: join(dir, "real-home"),
      profile: PROFILES["claude-code"],
    });
    await prepareHost({ ...p, steps: [] }, { fs: nodeFs(), run: async () => ({ status: 0 }) });
    // The root's node, and a stand-in for its copy of the CLI that reports its argv.
    symlinkSync(process.execPath, join(root, "bin", "node"));
    mkdirSync(join(root, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(p.cliMain, 'process.stdout.write("RAN " + process.argv.slice(2).join(" "));\n');
    symlinkSync(dir, join(p.workspace, "escape"));
    const aw = (...args: string[]) =>
      spawnSync(join(root, "bin", "aw"), args, {
        cwd: p.workspace,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: p.home },
      });
    const outside = [
      ["context-plan", "--root", "/"],
      ["context-plan", "--root", "//"],
      ["context-plan", "--root=/"],
      ["context-plan", "--root", "/Users"],
      ["flow", "start", "--root", dir],
      ["flow", "start", "--root", "/checkout/skills/w"],
      ["context-plan", "--root", "../.."],
      ["context-plan", "--root", `${root}/../elsewhere`],
      ["context-plan", "--root", "escape/skills"],
      ["status", "--hub", "/etc"],
      ["status", "--hub="],
    ];
    for (const args of outside) {
      const r = aw(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr.trim().split("\n"), args.join(" ")).toHaveLength(1);
      expect(r.stderr).toMatch(/outside the disposable root refused/);
    }
    for (const args of [
      ["context-plan", "--root", `${root}/home/.claude/skills/w`],
      ["context-plan", `--root=${root}/cli`],
      ["status", "--hub", p.workspace],
    ]) {
      const r = aw(...args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout).toBe(`RAN ${args.join(" ")}`);
    }
  });

  it("AC2: --assert-closed rejects a degradation declared only by the CLI's doctor", async () => {
    const { closureFailures } = await import("../../scripts/host-run/compare.mjs");
    const { buildMatrix } = await import("../../scripts/host-run/matrix.mjs");
    const catalog = catalogStates(HARNESSES, capabilitiesFor);
    const run = (source: string | null, declared: boolean) =>
      buildMatrix({
        runId: "r9",
        date: "2026-09-30",
        cli: { version: "28.0.0", revision: "x" },
        scenarioDigest: "d",
        catalog,
        hosts: ["codex"],
        steps: ["hooks"],
        hostRuns: {
          codex: {
            version: "0.157.1",
            cells: {
              hooks: {
                observed: "fails",
                mode: "interactive",
                declared_by_doctor: declared,
                ...(source ? { declared_source: source } : {}),
              },
            },
          },
        },
      });
    const cliOnly = run("cli", false);
    expect(cliOnly.hosts.codex.cells.hooks.state).toBe("degraded-undeclared");
    expect(closureFailures([cliOnly])).toContain("codex/hooks: degraded-undeclared (run r9)");
    const relayed = run("relay", true);
    expect(relayed.hosts.codex.cells.hooks.state).toBe("degraded-declared");
    expect(closureFailures([relayed]).some((f: string) => f.startsWith("codex/hooks"))).toBe(false);
  });

  it("AC4: a host that finishes between two ticks is done, not «never started»", async () => {
    const clock = { t: 0 };
    const before = "❯ \n  ⏸ manual mode on · ? for shortcuts";
    const after =
      "❯ /w:doctor\n  Ran 1 shell command\n⏺ Reporte relayado arriba tal cual.\n❯ \n  ⏸ manual mode on · ? for shortcuts";
    const { ctx } = replayCtx(
      [
        { state: "idle", screen: before },
        { state: "idle", screen: after },
      ],
      clock,
    );
    const h = host("claude-code");
    await tick(ctx, [h]);
    clock.t += 2_000;
    await tick(ctx, [h]);
    expect(h.sawWork).toBe(true);
    // Idle with work seen: the step is judged now, not stalled for 15 minutes.
    expect(h.stepIndex).toBe(1);
  });

  it("AC5: a doctor report that mentions a «rate limit» is not a model failure", async () => {
    const clock = { t: 0 };
    const report = [
      "❯ /w:doctor",
      "  mcp degraded — the provider applies a rate limit to anonymous calls",
      "  Veredicto: salida 0",
      "⏺ Listo.",
      "❯ ",
    ].join("\n");
    const { ctx } = replayCtx(
      [
        { state: "idle", screen: "❯ " },
        { state: "working", screen: "✶ working" },
        { state: "idle", screen: report },
      ],
      clock,
    );
    const h = host("claude-code");
    for (let i = 0; i < 3; i++) {
      clock.t += 2_000;
      await tick(ctx, [h]);
    }
    expect(h.evidence.commands?.reason).toBeUndefined();
    expect(h.evidence.commands).toMatchObject({ relayed: true });
  });

  it("AC6: one env var feeding two covered hosts would be warned about; with crush excluded, none does", async () => {
    const { spawnSync } = await import("node:child_process");
    const RUN = join(__dirname, "..", "..", "scripts", "host-run", "run.mjs");
    const env: Record<string, string | undefined> = { ...process.env };
    for (const v of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[v];
    const key = ["s", "k-proj-", "TEST-not-a-real-openai-key"].join("");
    const r = spawnSync(process.execPath, [RUN, "--dry-run", "--hosts", "opencode,gemini"], {
      encoding: "utf8",
      env: { ...env, OPENAI_API_KEY: key },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    // Only opencode takes OPENAI_API_KEY now: no warning, and the value never shows.
    expect(r.stdout).not.toContain("WARNING: OPENAI_API_KEY");
    expect(r.stdout).toContain("opencode OpenAI API key: present (from OPENAI_API_KEY");
    expect(r.stdout).not.toContain(key);
  }, 240_000);
});
