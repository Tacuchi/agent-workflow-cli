import { describe, expect, it } from "vitest";
import { computeCheckpointStatus } from "../../src/application/checkpoint-service.js";
import { MemFs } from "../helpers/mem-fs.js";

const EN_CHECKPOINT = `# Checkpoint — session042-dev-foo

- Updated: 2026-05-08 12:00
- Current phase: execution (2/4)
- Progress: 50% (2 of 4 tasks complete)

## Last action

_[AI: 1-3 sentences on the last concrete progress.]_

## Next step

_[AI: 1-2 sentences on what remains.]_

## Recent decisions

_No decisions recorded._

## Files touched (post-last-commit)

_[AI: purpose in 1 line per file]_

## Critical context to resume

_[AI: 2-3 paragraphs.]_

## Refs

- Branches: feature/last
`;

describe("computeCheckpointStatus — EN canon (R3 reader gap fix)", () => {
  it("detects unfilled placeholders in EN headings (## Last action, ## Next step, ## Files touched, ## Critical context)", async () => {
    const path = "/fake/session042/CHECKPOINT.md";
    const fs = new MemFs({ lenient: true }).file(path, EN_CHECKPOINT);
    const result = await computeCheckpointStatus(fs, "/fake/session042", {
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(result.status).toBe("draft");
    expect(result.needs_ai_action).toBe(true);
    expect(result.unfilled_placeholders.length).toBeGreaterThan(0);
    // 4 placeholder sections: last action, next step, files touched, critical context
    expect(result.unfilled_placeholders).toContain("ultimo");
    expect(result.unfilled_placeholders).toContain("proximo");
    expect(result.unfilled_placeholders).toContain("archivos_proposito");
    expect(result.unfilled_placeholders).toContain("contexto");
  });

  it("parses 'Updated:' EN value for actualizado timestamp (returns non-null age)", async () => {
    const path = "/fake/session042/CHECKPOINT.md";
    const fs = new MemFs({ lenient: true }).file(path, EN_CHECKPOINT);
    // Pick a "now" far enough in the future to be timezone-agnostic.
    const result = await computeCheckpointStatus(fs, "/fake/session042", {
      now: new Date(2026, 4, 9, 12, 0, 0),
    });

    const age = result.age_seconds;
    expect(age).not.toBeNull();
    expect(age ?? 0).toBeGreaterThan(3000);
  });
});

// ── the heading the generator emits TODAY, not only the legacy one ───────────

describe("el encabezado vigente de archivos tocados se sigue leyendo", () => {
  // The fixture above pins `## Files touched (post-last-commit)`, which the
  // generator no longer writes: it proves legacy checkpoints still parse, and
  // proves nothing about the heading every NEW checkpoint carries. Both belong
  // to the same alias group, and only a test says so.
  const CURRENT = EN_CHECKPOINT.replace("## Files touched (post-last-commit)", "## Files touched");

  it("`## Files touched` sin sufijo temporal sigue detectando su marcador sin rellenar", async () => {
    const path = "/fake/session043/CHECKPOINT.md";
    const fs = new MemFs({ lenient: true }).file(path, CURRENT);
    const result = await computeCheckpointStatus(fs, "/fake/session043", {
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(CURRENT).not.toContain("post-last-commit");
    expect(result.unfilled_placeholders).toContain("archivos_proposito");
    expect(result.status).toBe("draft");
  });
});
