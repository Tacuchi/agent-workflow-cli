import { describe, expect, it } from "vitest";
import { buildAgentWorkflowIndex } from "../../src/application/agent-workflow-index-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The board used to offer a reservation as an executable plan.
 *
 * Reproduced live while this very plan was being written: `docs/plans/036-...md`
 * held nothing but `<!-- aw:reserva 145-... -->`, and `aw status` reported it with
 * `plan_state: "open"` and a pipeline row whose command was
 * `/w:plan-exec docs/plans/036-...md` — inviting somebody to execute a document
 * that did not exist yet. It was NOT only the anonymous legacy placeholder: a
 * marker with a perfectly valid owner did it too. That reproduction is this test.
 */

const NOW = new Date(2026, 7, 24, 12, 0, 0);

const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
const index = (fs: MemFs) =>
  buildAgentWorkflowIndex(fs, new FakeEnv("/home", "/cwd"), paths(), {
    now: NOW,
    sessions: "legacy",
  });

const hub = (): MemFs =>
  new MemFs({ lenient: true })
    .file("/cwd/CLAUDE.md", "# Proyecto\n\n## Fuentes\n\n| Alias | Path | Rama |\n")
    .dir("/cwd/.workflow/sessions")
    .dir("/cwd/docs/specs")
    .dir("/cwd/docs/plans");

describe("el tablero distingue reserva, documento y placeholder legacy", () => {
  it("un documento publicado sigue siendo un documento", async () => {
    const fs = hub().file(
      "/cwd/docs/specs/004-spec-real.md",
      "---\nstatus: ready-for-plan\n---\n\n# Spec 004\n",
    );

    const result = await index(fs);

    expect(result.specs.map((s) => s.number)).toEqual(["004"]);
    expect(result.reservations).toEqual([]);
  });
});
