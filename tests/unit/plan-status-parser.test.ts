import { describe, expect, it } from "vitest";
import { parsePlanStatus } from "../../src/application/parsers/plan-status.js";

/** A plan-doc whose preamble (under the title) holds the given lines. */
const planWithPreamble = (...preamble: string[]) =>
  [
    "# Plan 007 — checkout",
    "",
    ...preamble,
    "",
    "## Tasks",
    "",
    "### F1 — El carrito acepta un cupón",
    "> Estado: validada",
    "- [x] T1.1",
    "",
  ].join("\n");

describe("parsePlanStatus — the plan's own state, told apart by position", () => {
  it("a plan that declares nothing is absent, not open by assumption", () => {
    expect(parsePlanStatus(planWithPreamble("> Derived from docs/specs/003-spec-foo.md"))).toEqual({
      declared: "absent",
      closure: null,
      legacy: false,
    });
  });

  it("reads the normalized pair: a bare value plus its own closure line", () => {
    expect(
      parsePlanStatus(planWithPreamble("> Estado: done", "> Cierre: 2026-07-27 · sesión 123")),
    ).toEqual({ declared: "done", closure: "2026-07-27 · sesión 123", legacy: false });
  });

  it("reads the legacy one-line form and flags it for migration", () => {
    // Compatibility is for READING old plans; `legacy: true` is what tells the
    // loop to rewrite the mark the next time it touches the document.
    expect(parsePlanStatus(planWithPreamble("> Estado: done — 2026-07-27 · sesión 123"))).toEqual({
      declared: "done",
      closure: "2026-07-27 · sesión 123",
      legacy: true,
    });
  });

  it("a phase state never reaches the plan level — position is the discriminator", () => {
    // The `### F1` block below declares `validada`; reading both marks with one
    // rule would let a single validated phase close the whole plan.
    expect(parsePlanStatus(planWithPreamble("> Estado: open")).declared).toBe("open");
    const noPreamble = ["# Plan 008", "", "## Tasks", "### F1 — x", "> Estado: validada"].join(
      "\n",
    );
    expect(parsePlanStatus(noPreamble).declared).toBe("absent");
  });

  it("an unreadable value is a contradiction to surface, never a silent open", () => {
    for (const raw of [
      "> Estado: cerrado",
      "> Estado: done pero falta el deploy",
      "> Estado: 100%",
    ]) {
      expect(parsePlanStatus(planWithPreamble(raw)).declared, raw).toBe("unknown");
    }
  });

  it("tolerates casing and a bolded label, like the phase parser", () => {
    expect(parsePlanStatus(planWithPreamble("> **Estado:** DONE")).declared).toBe("done");
  });

  it("the first state line wins; a later one is prose", () => {
    expect(parsePlanStatus(planWithPreamble("> Estado: open", "> Estado: done")).declared).toBe(
      "open",
    );
  });

  it("a status line quoted inside a fence is an example, never the declaration", () => {
    const doc = [
      "# Plan 009 — ejemplo",
      "",
      "```markdown",
      "> Estado: done",
      "> Cierre: 2026-07-27 · sesión 1",
      "```",
      "",
      "## Tasks",
    ].join("\n");
    expect(parsePlanStatus(doc)).toEqual({ declared: "absent", closure: null, legacy: false });
  });
});
