import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentCallCount, COUNTED_FLOWS, countAgentCalls } from "../helpers/agent-calls.js";

/**
 * How many calls to `aw` each flow asks of the agent, against the 27.0.1
 * reference (plan 082, F1 · spec 061 AC-15).
 *
 * The count comes from walking each flow over the same minimal workspace with a
 * scripted agent that answers whatever boundary the CLI stands on; see
 * `tests/helpers/agent-calls.ts` for how each stop is priced. The reference is
 * frozen once, on 27.0.1, with `AW_FREEZE_AGENT_CALLS=1 npx vitest run
 * tests/unit/flow-agent-calls.test.ts`, and never regenerated to make a
 * regression pass.
 */

const REFERENCE_PATH = join(
  resolve(__dirname, "..", ".."),
  "tests",
  "fixtures",
  "agent-calls-27.0.1.json",
);

interface Reference {
  cli_version: string;
  git_revision: string;
  flows: Record<string, Omit<AgentCallCount, "flow" | "stops">>;
}

let walked: Promise<AgentCallCount[]> | null = null;
/** The five walks, run once and only by a test that asks for them. */
function counted(): Promise<AgentCallCount[]> {
  walked ??= Promise.all(COUNTED_FLOWS.map((flow) => countAgentCalls(flow)));
  return walked;
}

const COMPONENTS = ["opening", "submits", "commands", "proves", "total"] as const;

describe("agent calls per run — never more than 27.0.1", () => {
  it.runIf(process.env.AW_FREEZE_AGENT_CALLS === "1")("freezes the reference", async () => {
    const flows = Object.fromEntries(
      (await counted()).map(({ flow, stops: _stops, ...count }) => [flow, count]),
    );
    const frozen = {
      $comment:
        "REFERENCIA de la 27.0.1 (plan 082, F1): llamadas del agente a `aw` por corrida de cada flujo, contadas por tests/helpers/agent-calls.ts sobre el flujo de directivas. Es el techo del AC-15 de la spec 061. NO se regenera.",
      cli_version: "27.0.1",
      git_revision: "b8290ecc6cd86e890fb77efafc3039954ac9f487",
      flows,
    };
    await writeFile(REFERENCE_PATH, `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
  });

  it("the reference is sealed with its release and covers the five flows", async () => {
    const ref = JSON.parse(await readFile(REFERENCE_PATH, "utf8")) as Reference;
    expect(ref.cli_version).toBe("27.0.1");
    expect(ref.git_revision).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(ref.flows).sort()).toEqual([...COUNTED_FLOWS].sort());
  });

  it("every flow walks to its end", async () => {
    for (const count of await counted()) {
      expect(count.stops.length, count.flow).toBeGreaterThan(0);
      expect(count.stops.at(-1)?.transition, count.flow).toBe("chassis.commit-choice");
    }
  }, 60_000);

  it("no flow asks the agent for more calls of any kind than 27.0.1", async () => {
    // Per kind, not only in total: fewer proves must never pay for more submits.
    const ref = JSON.parse(await readFile(REFERENCE_PATH, "utf8")) as Reference;
    for (const count of await counted()) {
      const frozen = ref.flows[count.flow];
      for (const kind of COMPONENTS) {
        expect(count[kind], `${count.flow} ${kind}`).toBeLessThanOrEqual(frozen?.[kind] ?? 0);
      }
    }
  }, 60_000);

  it("every flow asks the agent for strictly fewer calls than 27.0.1", async () => {
    // Plan 082 F8 · AC-15: not merely no worse — the release has to save calls.
    const ref = JSON.parse(await readFile(REFERENCE_PATH, "utf8")) as Reference;
    for (const count of await counted()) {
      expect(count.total, count.flow).toBeLessThan(ref.flows[count.flow]?.total ?? 0);
    }
  }, 60_000);
});
