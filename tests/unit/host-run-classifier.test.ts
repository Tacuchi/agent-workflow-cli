// The pane classifier of the host run (plan 085, T1.5, AC-08): it answers only a
// scenario question shown literally, with the scenario's label, and every
// permission — even one whose text resembles a label — goes to the person.
// Captures are synthetic, one per host and dialog kind.

import { describe, expect, it } from "vitest";
import {
  assertSafe,
  blockSignature,
  classify,
  classifyAll,
  confirmsSelection,
  currentBlock,
  isSelected,
  readyForInput,
  selectionKeys,
} from "../../scripts/host-run/classifier.mjs";
import { evidenceOf, makeNotifier, sendStep, tick } from "../../scripts/host-run/live.mjs";
import { catalogStates } from "../../scripts/host-run/matrix.mjs";
import { STEPS, scenarioAnswers, stepForHost } from "../../scripts/host-run/scenario.mjs";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

const quickStep = STEPS.find((s) => s.surface === "structured-choice");
const doctorStep = STEPS.find((s) => s.surface === "commands");
if (!quickStep || !doctorStep) throw new Error("scenario steps missing");
const quick = (host: string) => stepForHost(quickStep, host);
const doctor = (host: string) => stepForHost(doctorStep, host);

const GATE_SELECTOR = `
 ☐ Tamaño

¿El objetivo excede un quick?

❯ 1. Cambiar a SPEC
     se cierra la sesión quick y se entrega a /w:spec-new
  2. Seguir en quick
     el recorrido continúa como quick
  3. Recortar alcance
     el objetivo pasa a ser la sub-tarea que sí entra
  4. Compactar
  5. Cerrar
  6. Type something.
`;

const GATE_MARKDOWN = `
El objetivo excede un quick. Elegí una opción por su etiqueta:

- **Cambiar a SPEC** — se cierra la sesión quick y se entrega a /w:spec-new
- **Seguir en quick** — el recorrido continúa como quick
- **Recortar alcance** — el objetivo pasa a ser la sub-tarea que sí entra
- **Compactar** — guardar el estado y compactar
- **Cerrar** — cerrar la corrida
`;

const claudeQuestion = { matched_rule: { id: "claude.ask-user-question" }, state: "blocked" };
const claudePermission = { matched_rule: { id: "claude.permission-prompt" }, state: "blocked" };

describe("host-run classifier — answers only scenario questions", () => {
  it("claude: a blocked AskUserQuestion with the gate labels gets arrows onto Recortar alcance", () => {
    const d = classify(
      { host: "claude-code", state: "blocked", screen: GATE_SELECTOR, explain: claudeQuestion },
      quick("claude-code"),
    );
    expect(d).toMatchObject({
      action: "send-keys",
      label: "Recortar alcance",
      keys: ["down", "down"],
      confirm: "enter",
    });
  });

  it("kimi: the same question, read through its Herdr rule", () => {
    const d = classify(
      { host: "kimi", state: "blocked", screen: GATE_SELECTOR, explain: { rule: "kimi.question" } },
      quick("kimi"),
    );
    expect(d.action).toBe("send-keys");
  });

  it("codex, opencode, agy and crush: their text markers make it a question", () => {
    const markers: Record<string, string> = {
      // Markers sit in the dialog, above its options: nothing may follow a live selector.
      codex: "  Other: write your own\n",
      opencode: "  Type your own answer\n",
      gemini: "  Write-in response\n",
      crush: "  Question 1 of 1\n",
    };
    for (const [host, marker] of Object.entries(markers)) {
      const d = classify(
        { host, state: "blocked", screen: marker + GATE_SELECTOR, explain: null },
        quick(host),
      );
      expect(d.action, host).toBe("send-keys");
      const bare = classify(
        { host, state: "blocked", screen: GATE_SELECTOR, explain: null },
        quick(host),
      );
      expect(bare.action, `${host} without its marker`).toBe("notify");
    }
  });

  it("an idle pane with the labeled markdown gets a prompt with the label text", () => {
    for (const host of ["codex", "gemini", "opencode"]) {
      const d = classify(
        { host, state: "idle", screen: GATE_MARKDOWN, explain: null },
        quick(host),
      );
      expect(d, host).toMatchObject({
        action: "prompt",
        text: "Recortar alcance",
        boundary: "quick.gate-choice",
      });
    }
  });

  it("doctor's repair offer is closed with Cerrar", () => {
    const offer = `
¿Qué reparo?
❯ 1. claude-code/skills/stale
  2. Compactar
  3. Cerrar
`;
    const d = classify(
      { host: "claude-code", state: "blocked", screen: offer, explain: claudeQuestion },
      doctor("claude-code"),
    );
    expect(d).toMatchObject({ action: "send-keys", label: "Cerrar", keys: ["down", "down"] });
  });

  it("moves the cursor by option lines and confirms the selection before Enter", () => {
    expect(selectionKeys(GATE_SELECTOR, "Cambiar a SPEC")).toEqual([]);
    expect(selectionKeys(GATE_SELECTOR, "Cerrar")).toEqual(["down", "down", "down", "down"]);
    expect(isSelected(GATE_SELECTOR, "Recortar alcance")).toBe(false);
    const moved = GATE_SELECTOR.replace("❯ 1. Cambiar", "  1. Cambiar").replace(
      "  3. Recortar",
      "❯ 3. Recortar",
    );
    expect(isSelected(moved, "Recortar alcance")).toBe(true);
    expect(selectionKeys(moved, "Seguir en quick")).toEqual(["up"]);
  });
});

describe("host-run classifier — never answers a permission", () => {
  const permissions: Record<string, string> = {
    "claude-code": `
Bash command
  git push origin main
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for git push commands
  3. No, and tell Claude what to do differently (esc)
`,
    codex: `
Would you like to run the following command?
  $ rm -rf dist
› 1. Yes, proceed
  2. Yes, and don't ask again for this command
  3. No, and tell Codex what to do differently
`,
    opencode: `
△ Permission required
  bash: git tag v1
  Allow once   Allow always   Reject
`,
    gemini: `
Run this command?
  npm publish
❯ Yes, allow access
  No, deny creation
`,
    crush: `
Permission Required
  Tool: bash   git remote add origin x
  Allow   Allow for Session   Deny
`,
    kimi: `
Approve Bash: npm version patch?
❯ Approve once
  Approve for this session
  Reject
`,
  };

  for (const [host, screen] of Object.entries(permissions)) {
    it(`${host}: a permission dialog gets no answer`, () => {
      for (const state of ["blocked", "idle"]) {
        const d = classify(
          { host, state, screen, explain: host === "claude-code" ? claudePermission : null },
          quick(host),
        );
        expect(d.action, `${host}/${state}`).toBe("notify");
      }
    });
  }

  it("a permission whose options look like scenario labels still gets no answer", () => {
    const lookalike = `
Do you want to allow the tool mcp__host-run-probe__execute_sql?
❯ 1. Cambiar a SPEC
  2. Seguir en quick
  3. Recortar alcance
  4. Compactar
  5. Cerrar
`;
    for (const host of ["claude-code", "codex", "opencode", "gemini", "crush", "kimi"]) {
      const d = classify(
        { host, state: "blocked", screen: lookalike, explain: claudeQuestion },
        quick(host),
      );
      expect(d.action, host).toBe("notify");
      const idle = classify({ host, state: "idle", screen: lookalike, explain: null }, quick(host));
      expect(idle.action, `${host} idle`).toBe("notify");
    }
  });

  it("a detection rule that names a permission vetoes even a clean question screen", () => {
    const d = classify(
      { host: "claude-code", state: "blocked", screen: GATE_SELECTOR, explain: claudePermission },
      quick("claude-code"),
    );
    expect(d.action).toBe("notify");
  });

  it("labels shown only partly, or a question from another step, get no answer", () => {
    const partial = GATE_SELECTOR.replace("  3. Recortar alcance", "  3. Otra cosa");
    expect(
      classify(
        { host: "claude-code", state: "blocked", screen: partial, explain: claudeQuestion },
        quick("claude-code"),
      ).action,
    ).toBe("notify");
    expect(
      classify(
        { host: "claude-code", state: "idle", screen: partial, explain: null },
        quick("claude-code"),
      ).action,
    ).toBe("idle");
  });

  it("an unknown or unrecognized state is the person's", () => {
    expect(
      classify(
        { host: "crush", state: "unknown", screen: GATE_MARKDOWN, explain: null },
        quick("crush"),
      ).action,
    ).toBe("notify");
    expect(
      classify(
        { host: "codex", state: "working", screen: GATE_MARKDOWN, explain: null },
        quick("codex"),
      ).action,
    ).toBe("wait");
  });

  it("a pane waiting on a permission holds only its own host", () => {
    const decisions = classifyAll(
      [
        {
          host: "claude-code",
          state: "blocked",
          screen: permissions["claude-code"],
          explain: claudePermission,
        },
        { host: "codex", state: "idle", screen: GATE_MARKDOWN, explain: null },
        {
          host: "kimi",
          state: "blocked",
          screen: GATE_SELECTOR,
          explain: { rule: "kimi.question" },
        },
        { host: "opencode", state: "working", screen: "", explain: null },
      ],
      (host: string) => quick(host),
    );
    expect(decisions.map((d) => [d.host, d.action])).toEqual([
      ["claude-code", "notify"],
      ["codex", "prompt"],
      ["kimi", "send-keys"],
      ["opencode", "wait"],
    ]);
  });

  it("the executor refuses a bare Enter, «1», «y» or a text that is not a label", () => {
    const answers = scenarioAnswers();
    expect(() =>
      assertSafe(
        { action: "send-keys", keys: ["enter"], confirm: "enter", label: "Cerrar" },
        answers,
      ),
    ).toThrow();
    expect(() =>
      assertSafe({ action: "send-keys", keys: ["1"], confirm: "enter", label: "Cerrar" }, answers),
    ).toThrow();
    expect(() => assertSafe({ action: "prompt", text: "y" }, answers)).toThrow();
    expect(() => assertSafe({ action: "prompt", text: "1" }, answers)).toThrow();
    expect(() =>
      assertSafe({ action: "send-keys", keys: ["down"], confirm: "enter", label: "Yes" }, answers),
    ).toThrow();
    expect(assertSafe({ action: "prompt", text: "Recortar alcance" }, answers).text).toBe(
      "Recortar alcance",
    );
  });
});

describe("host-run herdr reading", () => {
  it("reads agent_status from agent get, and crush's state from its screen alone", async () => {
    const { agentStatus, screenState } = await import("../../scripts/host-run/herdr.mjs");
    expect(
      agentStatus({ result: { type: "agent_info", agent: { agent_status: "blocked" } } }),
    ).toBe("blocked");
    expect(agentStatus(null)).toBe("unknown");
    expect(screenState("crush", "Question 1 of 1\n- Recortar alcance")).toBe("blocked");
    expect(screenState("crush", "Permission Required\n Allow  Deny")).toBe("blocked");
    expect(screenState("crush", "> type a message")).toBe("unknown");
  });
});

describe("host-run classifier — only the selector the host shows now", () => {
  it("an echoed prompt in the scrollback is not the selection (reviewer's string)", () => {
    const screen = "> Cerrar\n...\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    expect(isSelected(screen, "Cerrar")).toBe(false);
    expect(selectionKeys(screen, "Cerrar")).toBeNull();
  });

  it("labels in the scrollback above the current selector do not match its boundary", () => {
    const screen = `${GATE_MARKDOWN}\n\nOK, recorté el alcance.\n\n❯ 1. Otra pregunta\n  2. Otra respuesta\n  3. Compactar\n  4. Cerrar\n`;
    const d = classify(
      { host: "claude-code", state: "blocked", screen, explain: claudeQuestion },
      quick("claude-code"),
    );
    expect(d.action).toBe("notify");
    const idle = classify({ host: "codex", state: "idle", screen, explain: null }, quick("codex"));
    expect(idle.action).toBe("idle");
  });

  it("the commit boundary after the fix preview is the quick step's stop point, never answered", () => {
    const commit = `${GATE_MARKDOWN}\n\n❯ 1. Aprobar el commit\n  2. Dejar la tarea sin commitear\n  3. Compactar\n  4. Cerrar\n`;
    for (const state of ["blocked", "idle"]) {
      const d = classify(
        { host: "claude-code", state, screen: commit, explain: claudeQuestion },
        quick("claude-code"),
      );
      expect(d, state).toMatchObject({ action: "stop", boundary: "quick.commit-authorization" });
    }
  });

  it("a stale selector followed by other text and a key hint is not live: nothing is sent", () => {
    const stale = `${GATE_SELECTOR}\nLet me think about the refactor first.\nPress enter to confirm`;
    expect(currentBlock(stale)).toEqual([]);
    for (const state of ["blocked", "idle"]) {
      const d = classify(
        { host: "claude-code", state, screen: stale, explain: claudeQuestion },
        quick("claude-code"),
      );
      expect(["notify", "idle"], state).toContain(d.action);
    }
    const live = `${GATE_SELECTOR}\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n`;
    expect(
      classify(
        { host: "claude-code", state: "blocked", screen: live, explain: claudeQuestion },
        quick("claude-code"),
      ).action,
    ).toBe("send-keys");
    const withInput = `${GATE_MARKDOWN}\n\n› Ask Codex to do anything\n`;
    expect(
      classify({ host: "codex", state: "idle", screen: withInput, explain: null }, quick("codex"))
        .action,
    ).toBe("prompt");
  });

  it("a stale word «permission» in the scrollback does not stall a live question", () => {
    const earlier = "hooks degraded — needs a permission review\n".repeat(3);
    const screen = `${earlier}${"\nsome output".repeat(20)}\n${GATE_SELECTOR}`;
    expect(
      classify(
        { host: "claude-code", state: "blocked", screen, explain: claudeQuestion },
        quick("claude-code"),
      ).action,
    ).toBe("send-keys");
  });

  it("bullets and `>` quotes are not cursors; `> 1.` in front of a numbered option is", () => {
    expect(isSelected("* Cerrar\n- Compactar\n", "Cerrar")).toBe(false);
    expect(isSelected("> 1. Compactar\n  2. Cerrar\n", "Compactar")).toBe(true);
  });

  it("Enter is confirmed only on a fresh screen that still shows the same question", () => {
    const step = quick("claude-code");
    const decision = classify(
      { host: "claude-code", state: "blocked", screen: GATE_SELECTOR, explain: claudeQuestion },
      step,
    );
    const moved = GATE_SELECTOR.replace("❯ 1. Cambiar", "  1. Cambiar").replace(
      "  3. Recortar",
      "❯ 3. Recortar",
    );
    const fresh = (over: Record<string, unknown>) => ({
      host: "claude-code",
      state: "blocked",
      screen: moved,
      explain: claudeQuestion,
      ...over,
    });
    expect(confirmsSelection(fresh({}), step, decision)).toBe(true);
    // The cursor landed elsewhere.
    expect(confirmsSelection(fresh({ screen: GATE_SELECTOR }), step, decision)).toBe(false);
    // A permission appeared under the question.
    expect(
      confirmsSelection(
        fresh({ screen: `${moved}\nDo you want to proceed?\n❯ 1. Yes\n  2. No` }),
        step,
        decision,
      ),
    ).toBe(false);
    // No longer blocked, or the rule now reads a permission.
    expect(confirmsSelection(fresh({ state: "idle" }), step, decision)).toBe(false);
    expect(confirmsSelection(fresh({ explain: claudePermission }), step, decision)).toBe(false);
    // Another boundary took its place.
    const other = "¿Commit?\n❯ 1. Recortar alcance\n  2. Otra\n  3. Compactar\n  4. Cerrar\n";
    expect(confirmsSelection(fresh({ screen: other }), step, decision)).toBe(false);
  });

  it("trust prompts of a fresh home are permissions", () => {
    for (const screen of [
      "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit",
      "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
    ]) {
      expect(readyForInput({ state: "idle", screen, explain: null }).ok, screen).toBe(false);
    }
    expect(readyForInput({ state: "blocked", screen: "", explain: null }).ok).toBe(false);
    expect(readyForInput({ state: "idle", screen: "> ", explain: null }).ok).toBe(true);
  });

  it("crush reads idle only after the same quiet screen three times", async () => {
    const { screenState } = await import("../../scripts/host-run/herdr.mjs");
    const s = "crush  ~/w\n> type a message";
    expect(screenState("crush", s, [])).toBe("unknown");
    expect(screenState("crush", s, [s])).toBe("unknown");
    expect(screenState("crush", s, [s, s])).toBe("idle");
    expect(screenState("crush", s, ["before"])).toBe("working");
    expect(screenState("crush", "Permission Required\n Allow  Deny", [s, s])).toBe("blocked");
  });
});

/** A Herdr stand-in: scripted snapshots per pane, and a log of everything sent. */
function fakeHerdr(screens: Record<string, { state: string; screen: string }[]>) {
  const sent: string[] = [];
  return {
    sent,
    snapshot(host: string, pane: string) {
      const queue = screens[pane] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { host, explain: host === "claude-code" ? claudeQuestion : null, ...next };
    },
    prompt(pane: string, text: string) {
      sent.push(`${pane} prompt ${text}`);
    },
    keys(pane: string, keys: string[]) {
      if (keys.length > 0) sent.push(`${pane} keys ${keys.join(" ")}`);
    },
  };
}

function liveCtx(herdr: ReturnType<typeof fakeHerdr>) {
  return {
    herdr,
    steps: STEPS,
    answers: scenarioAnswers(),
    now: () => 0,
    sleep: async () => {},
    transcript: () => {},
    notified: [] as string[],
    notify(id: string, reason: string) {
      this.notified.push(`${id}: ${reason}`);
    },
    readHostMemory: () => null,
  };
}

const hostState = (id: string, pane: string, over: Record<string, unknown> = {}) => ({
  id,
  pane,
  home: "/nonexistent/home",
  workspace: "/nonexistent/ws",
  phase: "send",
  stepIndex: 0,
  evidence: {},
  screensBySurface: {},
  ...over,
});

describe("host-run live — nothing is typed without a fresh, clean read", () => {
  it("a trust dialog on the first tick: no send, the person is told", async () => {
    const herdr = fakeHerdr({
      p1: [
        {
          state: "blocked",
          screen: "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit",
        },
      ],
    });
    const ctx = liveCtx(herdr);
    const h = hostState("claude-code", "p1");
    await tick(ctx, [h]);
    expect(herdr.sent).toEqual([]);
    expect(h.phase).toBe("send");
    expect(ctx.notified.join("\n")).toMatch(/not idle|trust/);
  });

  it("a trust dialog reported idle is still refused", async () => {
    const herdr = fakeHerdr({
      p1: [
        {
          state: "idle",
          screen: "Do you trust the contents of this directory?\n› 1. Yes\n  2. No",
        },
      ],
    });
    const ctx = liveCtx(herdr);
    expect(await sendStep(ctx, hostState("codex", "p1"))).toBe(false);
    expect(herdr.sent).toEqual([]);
  });

  it("a permission appearing between steps: the next step is not sent", async () => {
    const herdr = fakeHerdr({
      p1: [
        { state: "idle", screen: "Bash command\n  ls\nDo you want to proceed?\n❯ 1. Yes\n  2. No" },
      ],
    });
    const ctx = liveCtx(herdr);
    const h = hostState("claude-code", "p1", { stepIndex: 1 });
    await tick(ctx, [h]);
    expect(herdr.sent).toEqual([]);
    expect(h.stepIndex).toBe(1);
  });

  it("a clean idle pane gets exactly the step's invocation", async () => {
    const herdr = fakeHerdr({ p1: [{ state: "idle", screen: "> " }] });
    const ctx = liveCtx(herdr);
    const h = hostState("claude-code", "p1");
    await tick(ctx, [h]);
    expect(herdr.sent).toEqual(["p1 prompt /w:doctor"]);
    expect(h.phase).toBe("await");
  });

  it("arrows are sent, but Enter waits for a fresh screen with the cursor on the label", async () => {
    const moved = GATE_SELECTOR.replace("❯ 1. Cambiar", "  1. Cambiar").replace(
      "  3. Recortar",
      "❯ 3. Recortar",
    );
    const permission = `${moved}\nDo you want to proceed?\n❯ 1. Yes\n  2. No`;
    for (const [after, enter] of [
      [moved, true],
      [permission, false],
      [GATE_SELECTOR, false],
    ] as const) {
      const herdr = fakeHerdr({
        p1: [
          { state: "blocked", screen: GATE_SELECTOR },
          { state: "blocked", screen: after },
        ],
      });
      const ctx = liveCtx(herdr);
      const h = hostState("claude-code", "p1", {
        phase: "await",
        stepIndex: 1,
        since: 0,
        screens: [],
        answered: [],
        reached: [],
      });
      await tick(ctx, [h]);
      expect(herdr.sent[0]).toBe("p1 keys down down");
      expect(herdr.sent.includes("p1 keys enter"), after.slice(-20)).toBe(enter);
    }
  });

  it("labeled markdown is answered once, not on every tick it stays on screen", async () => {
    const recall = STEPS.findIndex((st) => st.surface === "host-memory");
    const offer =
      "Guardo lo aprendido?\n\n- **Compactar** — guardar y compactar\n- **Cerrar** — no guardar\n";
    const herdr = fakeHerdr({ p1: [{ state: "idle", screen: offer }] });
    const ctx = liveCtx(herdr);
    const h = hostState("codex", "p1", {
      phase: "await",
      stepIndex: recall,
      since: 0,
      sawWork: false,
      screens: [],
      answered: [],
      reached: [],
    });
    for (let i = 0; i < 6; i++) await tick(ctx, [h]);
    expect(herdr.sent).toEqual(["p1 prompt Cerrar"]);
  });

  it("the quick step stops at the commit boundary with its evidence, leaving it unanswered", async () => {
    const quickIndex = STEPS.findIndex((st) => st.surface === "structured-choice");
    const commit =
      "❯ 1. Aprobar el commit\n  2. Dejar la tarea sin commitear\n  3. Compactar\n  4. Cerrar\n";
    const herdr = fakeHerdr({ p1: [{ state: "blocked", screen: commit }] });
    const ctx = liveCtx(herdr);
    const h = hostState("claude-code", "p1", {
      phase: "await",
      stepIndex: quickIndex,
      since: 0,
      screens: [],
      answered: ["native"],
      reached: ["quick.gate-choice"],
    });
    await tick(ctx, [h]);
    expect(herdr.sent).toEqual([]);
    expect(h.stepIndex).toBe(quickIndex + 1);
    expect(h.evidence["structured-choice"]).toMatchObject({ reached: true, answered: "native" });
  });

  it("a timeout keeps the evidence already collected", async () => {
    const quickIndex = STEPS.findIndex((st) => st.surface === "structured-choice");
    const herdr = fakeHerdr({ p1: [{ state: "working", screen: "…" }] });
    const ctx = { ...liveCtx(herdr), now: () => 16 * 60 * 1000 };
    const h = hostState("claude-code", "p1", {
      phase: "await",
      stepIndex: quickIndex,
      since: 0,
      screens: [],
      answered: ["native"],
      reached: ["quick.gate-choice"],
    });
    await tick(ctx, [h]);
    expect(h.evidence["structured-choice"]).toMatchObject({ reached: true, answered: "native" });
  });

  it("crush's palette: nothing is typed unless a fresh read shows it open", async () => {
    for (const [after, typed] of [
      ["crush  ~/w\n> type a message", false],
      ["Commands\n> user:w:\n  user:w:doctor", true],
    ] as const) {
      const herdr = fakeHerdr({
        p1: [
          { state: "idle", screen: "crush  ~/w\n> type a message" },
          { state: "idle", screen: after },
        ],
      });
      const ctx = liveCtx(herdr);
      const h = hostState("crush", "p1");
      await tick(ctx, [h]);
      expect(herdr.sent[0]).toBe("p1 keys ctrl+p");
      expect(herdr.sent.includes("p1 prompt user:w:doctor"), after).toBe(typed);
      expect(h.phase).toBe("await");
    }
  });

  it("one host held on a permission does not hold the others", async () => {
    const herdr = fakeHerdr({
      p1: [{ state: "blocked", screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No" }],
      p2: [{ state: "idle", screen: "> " }],
    });
    const ctx = liveCtx(herdr);
    await tick(ctx, [hostState("claude-code", "p1"), hostState("codex", "p2")]);
    expect(herdr.sent).toEqual(["p2 prompt $w-doctor (no arguments)"]);
  });
});

describe("host-run live — evidence", () => {
  it("an extract that fails the privacy filter is refused on its cell; the matrix stands", () => {
    const mcpStep = STEPS.filter((st) => st.surface === "mcp");
    const ctx = {
      runId: "r9",
      date: "2026-09-29",
      cli: { version: "28.0.0", revision: "abc1234" },
      digest: "d",
      catalog: catalogStates(HARNESSES, capabilitiesFor),
      steps: mcpStep,
      labels: Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])),
      realHome: "/Users/someone",
      username: "someone",
      foreignMcp: ["qtc-prod"],
    };
    const host = (id: string, screen: string) => ({
      id,
      root: `/tmp/aw-host-run-r9-${id}-X`,
      evidence: { mcp: { toolsListed: true, serverReached: true } },
      screensBySurface: { mcp: screen },
    });
    const { matrix, extracts } = evidenceOf(ctx, [
      host("codex", "tools: execute_sql, search_objects (ask person@example.com)"),
      host("gemini", "tools: execute_sql, search_objects; also qtc-prod"),
      host("opencode", "tools: execute_sql, search_objects"),
    ]);
    expect(matrix.hosts.codex.cells.mcp.extract_refused).toContain("contains an email address");
    expect(matrix.hosts.codex.cells.mcp).not.toHaveProperty("extract");
    expect(matrix.hosts.gemini.cells.mcp.extract_refused).toContain(
      "names an MCP outside the scenario",
    );
    // Only the category reaches matrix.json, never the foreign name.
    expect(JSON.stringify(matrix)).not.toContain("qtc-prod");
    expect(extracts.map((e) => e.path)).toEqual(["extracts/opencode/mcp.json"]);
    expect(matrix.hosts.opencode.cells.mcp.state).toBe("works");
    expect(matrix.hosts.kimi.cells.mcp.state).toBe("not-covered");
  });
});

describe("host-run herdr client", () => {
  const client = async (responses: Record<string, { status: number; stdout: string }>) => {
    const { HerdrClient } = await import("../../scripts/host-run/herdr.mjs");
    const calls: string[] = [];
    const exec = (argv: string[]) => {
      const key = argv.slice(0, 2).join(" ");
      calls.push(argv.join(" "));
      return { stderr: "", ...(responses[key] ?? { status: 0, stdout: "" }) };
    };
    return { herdr: new HerdrClient(exec), calls };
  };

  it("fails loudly without a workspace id, closing the pane it did get", async () => {
    const { herdr, calls } = await client({
      "workspace create": {
        status: 0,
        stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } }),
      },
    });
    expect(() => herdr.openPane("/ws", "host-run-codex", "env -i x")).toThrow(/no workspace id/);
    expect(calls).toContain("pane close w1:p1");
    expect(calls.some((c) => c.startsWith("pane run"))).toBe(false);
    expect(calls.some((c) => c.startsWith("workspace close"))).toBe(false);
  });

  it("closes the workspace when the pane command cannot be started", async () => {
    const created = {
      result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p1" } },
    };
    const { herdr, calls } = await client({
      "workspace create": { status: 0, stdout: JSON.stringify(created) },
      "pane run": { status: 1, stdout: "" },
    });
    expect(() => herdr.openPane("/ws", "host-run-codex", "env -i x")).toThrow();
    expect(calls).toContain("workspace close w1");
  });

  it("close() never runs without an id", async () => {
    const { herdr, calls } = await client({});
    herdr.close(undefined);
    expect(calls).toEqual([]);
  });
});

describe("host-run classifier — third review", () => {
  /** A 30-row crush screen: its permission overlay about 10 lines above the editor and footer. */
  const crush30 = [
    "crush  ~/workspace",
    ...Array.from({ length: 8 }, (_, i) => `  earlier output line ${i}`),
    "  ╭──────────────────────────────────────╮",
    "  │ Permission Required                  │",
    "  │ Tool: bash                           │",
    "  │ ls -la                               │",
    "  │  [ Allow ]  [ Allow for Session ]  [ Deny ] │",
    "  ╰──────────────────────────────────────╯",
    ...Array.from({ length: 11 }, (_, i) => `  scrollback ${i}`),
    "",
    "> ",
    "",
    "ctrl+p commands · ctrl+c quit",
  ].join("\n");

  it("crush's permission overlay blocks wherever it sits on a 30-row screen", async () => {
    const { screenState } = await import("../../scripts/host-run/herdr.mjs");
    expect(crush30.split("\n").length).toBe(30);
    expect(screenState("crush", crush30, [crush30, crush30])).toBe("blocked");
    expect(
      readyForInput({ state: "idle", screen: crush30, explain: null, screenOnly: true }).ok,
    ).toBe(false);
    // The same text far up the scrollback of a host WITH a Herdr state does not stall it.
    expect(readyForInput({ state: "idle", screen: crush30, explain: null }).ok).toBe(true);
  });

  it("accepts exactly one empty, boxed or echoed input line below the selector", () => {
    for (const tail of ["> ", "❯ ", "│ > │", "> Recortar alcance", "› Ask Codex to do anything"]) {
      const screen = `${GATE_MARKDOWN}\n\n${tail}\n`;
      expect(currentBlock(screen).length, JSON.stringify(tail)).toBeGreaterThan(0);
      expect(
        classify({ host: "codex", state: "idle", screen, explain: null }, quick("codex")).action,
        tail,
      ).toBe("prompt");
    }
    const boxed = `${GATE_MARKDOWN}\n╭────────╮\n│ >      │\n╰────────╯\n`;
    expect(currentBlock(boxed).length).toBeGreaterThan(0);
    // Two input lines are not «at most one»: no block, nothing sent.
    expect(currentBlock(`${GATE_MARKDOWN}\n> hola\n> chau\n`)).toEqual([]);
    expect(currentBlock("> hola\n> chau\n")).toEqual([]);
  });

  it("an echoed answer below the block does not make it a new showing", () => {
    const before = `${GATE_MARKDOWN}\n\n> \n`;
    const echoed = `${GATE_MARKDOWN}\n\n> Recortar alcance\n`;
    expect(blockSignature(echoed)).toBe(blockSignature(before));
    const again = `${GATE_MARKDOWN}\n\n> Recortar alcance\nLo pienso otra vez.\n${GATE_MARKDOWN}\n`;
    expect(blockSignature(again)).not.toBe(blockSignature(before));
  });
});

describe("host-run live — third review", () => {
  it("an echoed input line does not trigger a second answer of the same boundary", async () => {
    const recall = STEPS.findIndex((st) => st.surface === "host-memory");
    const offer =
      "Guardo lo aprendido?\n\n- **Compactar** — guardar y compactar\n- **Cerrar** — no guardar\n";
    const herdr = fakeHerdr({
      p1: [
        { state: "idle", screen: `${offer}\n> \n` },
        { state: "idle", screen: `${offer}\n> Cerrar\n` },
        { state: "idle", screen: `${offer}\n> Cerrar\n` },
      ],
    });
    const ctx = liveCtx(herdr);
    const h = hostState("codex", "p1", {
      phase: "await",
      stepIndex: recall,
      since: 0,
      screens: [],
      answered: [],
      reached: [],
    });
    for (let i = 0; i < 4; i++) await tick(ctx, [h]);
    expect(herdr.sent).toEqual(["p1 prompt Cerrar"]);
  });

  it("crush's footer «ctrl+p commands» is not an open palette", async () => {
    const idle = "crush  ~/w\n> \nctrl+p commands · ctrl+c quit";
    const stillIdle = "crush  ~/w\n> \nctrl+p commands · ctrl+c quit · 1 msg";
    const herdr = fakeHerdr({
      p1: [
        { state: "idle", screen: idle },
        { state: "idle", screen: stillIdle },
      ],
    });
    const ctx = liveCtx(herdr);
    const h = hostState("crush", "p1");
    await tick(ctx, [h]);
    expect(herdr.sent).toEqual(["p1 keys ctrl+p"]);
  });
});

describe("host-run live — fourth review", () => {
  it("a «Commands» line already on screen before ctrl+p does not count as the palette", async () => {
    const before = "crush  ~/w\n  Commands\n> \nctrl+p commands";
    const after = "crush  ~/w\n  Commands\n> \nctrl+p commands · 1";
    const herdr = fakeHerdr({
      p1: [
        { state: "idle", screen: before },
        { state: "idle", screen: after },
      ],
    });
    const ctx = liveCtx(herdr);
    await tick(ctx, [hostState("crush", "p1")]);
    expect(herdr.sent).toEqual(["p1 keys ctrl+p"]);
  });

  it("a boundary still shown after its answer notifies the person once, and is not answered again", async () => {
    const recall = STEPS.findIndex((st) => st.surface === "host-memory");
    const offer = "Guardo?\n\n- **Compactar** — guardar y compactar\n- **Cerrar** — no guardar\n";
    const herdr = fakeHerdr({ p1: [{ state: "idle", screen: offer }] });
    const ctx = liveCtx(herdr);
    const h = hostState("codex", "p1", {
      phase: "await",
      stepIndex: recall,
      since: 0,
      screens: [],
      answered: [],
      reached: [],
    });
    for (let i = 0; i < 3; i++) await tick(ctx, [h]);
    expect(herdr.sent).toEqual(["p1 prompt Cerrar"]);
    expect(
      ctx.notified.filter((n: string) => n.includes("already answered")).length,
    ).toBeGreaterThan(0);
  });
});

describe("host-run live — fifth review", () => {
  it("the run's notifier writes each reason once per host", () => {
    const lines: string[] = [];
    const notify = makeNotifier((l: string) => lines.push(l));
    expect(notify("codex", "a")).toBe(true);
    expect(notify("codex", "a")).toBe(false);
    expect(notify("kimi", "a")).toBe(true);
    expect(notify("codex", "b")).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it("a boundary still shown after its answer notifies exactly once", async () => {
    const recall = STEPS.findIndex((st) => st.surface === "host-memory");
    const offer = "Guardo?\n\n- **Compactar** — guardar y compactar\n- **Cerrar** — no guardar\n";
    const herdr = fakeHerdr({ p1: [{ state: "idle", screen: offer }] });
    const lines: string[] = [];
    const ctx = { ...liveCtx(herdr), notify: makeNotifier((l: string) => lines.push(l)) };
    const h = hostState("codex", "p1", {
      phase: "await",
      stepIndex: recall,
      since: 0,
      screens: [],
      answered: [],
      reached: [],
    });
    for (let i = 0; i < 4; i++) await tick(ctx, [h]);
    expect(herdr.sent).toEqual(["p1 prompt Cerrar"]);
    expect(lines.filter((l) => l.includes("already answered"))).toHaveLength(1);
  });

  it("a workspace pointing outside the root holds the host before it types or answers", async () => {
    const quickIndex = STEPS.findIndex((st) => st.surface === "structured-choice");
    for (const phase of ["send", "await"]) {
      const herdr = fakeHerdr({
        p1: [
          {
            state: phase === "send" ? "idle" : "blocked",
            screen: phase === "send" ? "> " : GATE_SELECTOR,
          },
        ],
        p2: [{ state: "idle", screen: "> " }],
      });
      const ctx = {
        ...liveCtx(herdr),
        guard: (h: { id: string }) =>
          h.id === "claude-code"
            ? ["a declared source points outside the root: /Users/x/repo"]
            : [],
      };
      const h = hostState("claude-code", "p1", {
        phase,
        stepIndex: quickIndex,
        since: 0,
        screens: [],
        answered: [],
        reached: [],
      });
      const other = hostState("codex", "p2");
      await tick(ctx, [h, other]);
      expect(
        herdr.sent.filter((l: string) => l.startsWith("p1")),
        phase,
      ).toEqual([]);
      expect(h.phase, phase).toBe("held");
      expect(herdr.sent).toContain("p2 prompt $w-doctor (no arguments)");
    }
  });
});
