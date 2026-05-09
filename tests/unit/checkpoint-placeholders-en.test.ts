import { describe, expect, it } from "vitest";
import { computeCheckpointStatus } from "../../src/application/checkpoint-service.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";

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

class FakeFs implements FileSystemPort {
  constructor(private readonly files: Record<string, string>) {}
  async exists(path: string): Promise<boolean> {
    return path in this.files;
  }
  async readText(path: string): Promise<string> {
    const f = this.files[path];
    if (f === undefined) throw new Error(`ENOENT: ${path}`);
    return f;
  }
  async writeText(): Promise<void> {
    throw new Error("not implemented");
  }
  async list(): Promise<{ name: string; path: string; type: "file" | "dir" }[]> {
    return [];
  }
  async stat(): Promise<{ mtime: Date; size: number; isDir: boolean }> {
    return { mtime: new Date(), size: 0, isDir: false };
  }
  async mkdirp(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
  async copy(): Promise<void> {}
  async chmod(): Promise<void> {}
}

describe("computeCheckpointStatus — EN canon (R3 reader gap fix)", () => {
  it("detects unfilled placeholders in EN headings (## Last action, ## Next step, ## Files touched, ## Critical context)", async () => {
    const path = "/fake/session042/CHECKPOINT.md";
    const fs = new FakeFs({ [path]: EN_CHECKPOINT });
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
    const fs = new FakeFs({ [path]: EN_CHECKPOINT });
    // Pick a "now" far enough in the future to be timezone-agnostic.
    const result = await computeCheckpointStatus(fs, "/fake/session042", {
      now: new Date(2026, 4, 9, 12, 0, 0),
    });

    const age = result.age_seconds;
    expect(age).not.toBeNull();
    expect(age ?? 0).toBeGreaterThan(3000);
  });
});
