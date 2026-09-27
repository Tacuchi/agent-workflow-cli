import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorklineFlow } from "../../src/application/capability/compose.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { type FlowRunState, newRunState } from "../../src/domain/flow/run-state.js";

/**
 * The journeys each released CLI walked, frozen per release under
 * `tests/fixtures/journeys/<version>.json`.
 *
 * A release that changes a journey adds its own file; the compatibility test
 * then proves every position of every older file still continues on the
 * installed build.
 */
export interface JourneyFixture {
  cli_version: string;
  run_state_version: number;
  journeys: Record<WorklineFlow, string[]>;
  repeatable: { "plan-exec": { first: string; last: string } };
}

const DIR = fileURLToPath(new URL("../fixtures/journeys/", import.meta.url));

function semver(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function compareSemver(a: string, b: string): number {
  const [left, right] = [semver(a), semver(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  // A development `-next` snapshot follows the actual release with the same numbers.
  return a.localeCompare(b);
}

/** Every frozen release, oldest first. */
export function loadJourneyFixtures(): JourneyFixture[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as JourneyFixture)
    .sort((a, b) => compareSemver(a.cli_version, b.cli_version));
}

/** Registry-shaped rows for a list of ids: the cursor readers only look at `id`. */
export function decisionsOf(ids: readonly string[]): FlowDecision[] {
  return ids.map((id) => ({
    id,
    scope: "quick",
    title: `frontera ${id} del fixture`,
    authority: "cli" as const,
    ownership: "cli-owned" as const,
    document: "loops/quick-loop/LOOP.md",
  }));
}

/**
 * A sealed state as a released CLI wrote it at `version`, stopped with
 * `applied` behind it and standing on `boundary`. Versions before 12 carry no
 * `journey_base`, exactly as their writers left it.
 */
export function stateWrittenAt(
  version: number,
  flow: WorklineFlow,
  session: string,
  applied: readonly string[],
  boundary: string | null,
  extra: Partial<FlowRunState> = {},
): FlowRunState {
  const { digest: _seal, journey_base, ...fresh } = newRunState(flow, session);
  const state = {
    ...fresh,
    ...(version >= 12 ? { journey_base } : {}),
    ...extra,
    version,
    applied: [...applied],
    boundary,
  };
  return { ...state, digest: semanticDigest(state) } as FlowRunState;
}

/** {@link stateWrittenAt} as the 25.6.1 CLI wrote it: version 11. */
export function v11StateAt(
  flow: WorklineFlow,
  session: string,
  applied: readonly string[],
  boundary: string | null,
  extra: Partial<FlowRunState> = {},
): FlowRunState {
  return stateWrittenAt(11, flow, session, applied, boundary, extra);
}
