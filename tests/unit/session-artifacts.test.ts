import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FILENAMES,
  type ArtifactKind,
  canonicalArtifactFilename,
  canonicalArtifactPath,
  findArtifact,
  listExistingArtifacts,
} from "../../src/application/session-artifacts.js";
import { MemFs } from "../helpers/mem-fs.js";

// MemFs whose list() always throws — reproduces the legacy fake's `registerDir:false`
// mode, forcing findArtifact/listExistingArtifacts down the fs.exists() fallback.
class NoListFs extends MemFs {
  override async list(): Promise<never> {
    throw new Error("ENOENT");
  }
}

const FOLDER = "/cwd/.workflow/sessions/session042-dev-foo";

describe("ARTIFACT_FILENAMES (new model)", () => {
  it("exposes exactly the final kind set", () => {
    expect(new Set(Object.keys(ARTIFACT_FILENAMES))).toEqual(
      new Set([
        "session",
        "objective",
        "decisions",
        "conclusions",
        "tasks",
        "checkpoint",
        "backlog",
        "scripts_sql",
        "analysis_file",
        "technical_note",
      ]),
    );
  });

  it("session writes SESSION.md (replaces the legacy objective kind)", () => {
    expect(ARTIFACT_FILENAMES.session).toEqual(["SESSION.md"]);
    expect(canonicalArtifactFilename("session")).toBe("SESSION.md");
  });

  it("keeps objective only as a legacy read fallback (EN + ES)", () => {
    expect(ARTIFACT_FILENAMES.objective).toEqual(["OBJECTIVE.md", "OBJETIVO.md"]);
  });

  it("decisions canonical is DECISION.md with DECISIONS/DECISIONES legacy fallbacks", () => {
    expect(ARTIFACT_FILENAMES.decisions).toEqual(["DECISION.md", "DECISIONS.md", "DECISIONES.md"]);
    expect(canonicalArtifactFilename("decisions")).toBe("DECISION.md");
  });

  it("carries the new-model research / quick kinds", () => {
    expect(ARTIFACT_FILENAMES.analysis_file).toEqual(["ANALYSIS-FILE.md"]);
    expect(ARTIFACT_FILENAMES.technical_note).toEqual(["TECHNICAL-NOTE.md"]);
  });

  it("uses single EN entry for the already-English kinds", () => {
    expect(ARTIFACT_FILENAMES.tasks).toEqual(["TASKS.md"]);
    expect(ARTIFACT_FILENAMES.checkpoint).toEqual(["CHECKPOINT.md"]);
    expect(ARTIFACT_FILENAMES.backlog).toEqual(["BACKLOG.md"]);
    expect(ARTIFACT_FILENAMES.scripts_sql).toEqual(["SCRIPTS.sql"]);
    expect(ARTIFACT_FILENAMES.conclusions).toEqual(["CONCLUSIONS.md", "CONCLUSIONES.md"]);
  });
});

describe("canonicalArtifactFilename / canonicalArtifactPath", () => {
  it("returns the EN UPPERCASE filename for new writes", () => {
    expect(canonicalArtifactFilename("session")).toBe("SESSION.md");
    expect(canonicalArtifactFilename("decisions")).toBe("DECISION.md");
    expect(canonicalArtifactFilename("tasks")).toBe("TASKS.md");
    expect(canonicalArtifactFilename("analysis_file")).toBe("ANALYSIS-FILE.md");
  });

  it("joins folder with canonical filename", () => {
    expect(canonicalArtifactPath(FOLDER, "session")).toBe(`${FOLDER}/SESSION.md`);
    expect(canonicalArtifactPath(FOLDER, "decisions")).toBe(`${FOLDER}/DECISION.md`);
  });
});

describe("findArtifact", () => {
  it("returns null when folder doesn't exist", async () => {
    const fs = new MemFs();
    expect(await findArtifact(FOLDER, "session", fs)).toBeNull();
  });

  it("returns null when no candidate is present", async () => {
    const fs = new MemFs().file(`${FOLDER}/SOMETHING_ELSE.md`, "x");
    expect(await findArtifact(FOLDER, "session", fs)).toBeNull();
  });

  it("resolves SESSION.md for the session kind", async () => {
    const fs = new MemFs().file(`${FOLDER}/SESSION.md`, "# SESSION\n");
    expect(await findArtifact(FOLDER, "session", fs)).toBe(`${FOLDER}/SESSION.md`);
  });

  it("resolves legacy ES filename when only ES exists (objective fallback)", async () => {
    const fs = new MemFs().file(`${FOLDER}/OBJETIVO.md`, "# Objetivo\n");
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/OBJETIVO.md`);
  });

  it("prefers EN over ES when both exist (objective fallback)", async () => {
    const fs = new MemFs()
      .file(`${FOLDER}/OBJECTIVE.md`, "# Objective\n")
      .file(`${FOLDER}/OBJETIVO.md`, "# Objetivo\n");
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/OBJECTIVE.md`);
  });

  it("matches case-insensitively (lowercase legacy filename)", async () => {
    const fs = new MemFs().file(`${FOLDER}/objetivo.md`, "# Objetivo\n");
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/objetivo.md`);
  });

  it("prefers DECISION.md over the legacy ES filename", async () => {
    const fs = new MemFs()
      .file(`${FOLDER}/DECISION.md`, "# Decision\n")
      .file(`${FOLDER}/DECISIONES.md`, "# Decisiones\n");
    expect(await findArtifact(FOLDER, "decisions", fs)).toBe(`${FOLDER}/DECISION.md`);
  });

  it("falls back to fs.exists when fs.list does not register the file", async () => {
    // Simulate a partial fake fs (file present, list throws) — forces the exists() fallback.
    const fs = new NoListFs().file(`${FOLDER}/DECISIONES.md`, "# Decisiones\n");
    expect(await findArtifact(FOLDER, "decisions", fs)).toBe(`${FOLDER}/DECISIONES.md`);
  });
});

describe("listExistingArtifacts", () => {
  it("returns null for every kind on an empty folder", async () => {
    const fs = new MemFs();
    const result = await listExistingArtifacts(FOLDER, fs);
    for (const kind of Object.keys(ARTIFACT_FILENAMES) as ArtifactKind[]) {
      expect(result[kind]).toBeNull();
    }
  });

  it("returns paths for present artifacts (new model)", async () => {
    const fs = new MemFs()
      .file(`${FOLDER}/SESSION.md`, "# SESSION\n")
      .file(`${FOLDER}/TASKS.md`, "- [ ] foo\n")
      .file(`${FOLDER}/CHECKPOINT.md`, "# Checkpoint\n")
      .file(`${FOLDER}/BACKLOG.md`, "# Backlog\n");
    const result = await listExistingArtifacts(FOLDER, fs);
    expect(result.session).toBe(`${FOLDER}/SESSION.md`);
    expect(result.tasks).toBe(`${FOLDER}/TASKS.md`);
    expect(result.checkpoint).toBe(`${FOLDER}/CHECKPOINT.md`);
    expect(result.backlog).toBe(`${FOLDER}/BACKLOG.md`);
    expect(result.decisions).toBeNull();
    expect(result.analysis_file).toBeNull();
  });

  it("resolves the objective legacy fallback alongside new artifacts", async () => {
    const fs = new MemFs()
      .file(`${FOLDER}/OBJETIVO.md`, "# Objetivo\n")
      .file(`${FOLDER}/TASKS.md`, "- [ ] foo\n");
    const result = await listExistingArtifacts(FOLDER, fs);
    expect(result.objective).toBe(`${FOLDER}/OBJETIVO.md`);
    expect(result.tasks).toBe(`${FOLDER}/TASKS.md`);
    expect(result.session).toBeNull();
  });

  it("uses fs.exists fallback when listing is incomplete", async () => {
    const fs = new NoListFs()
      .file(`${FOLDER}/SESSION.md`, "x")
      .file(`${FOLDER}/CHECKPOINT.md`, "y");
    const result = await listExistingArtifacts(FOLDER, fs);
    expect(result.session).toBe(`${FOLDER}/SESSION.md`);
    expect(result.checkpoint).toBe(`${FOLDER}/CHECKPOINT.md`);
  });
});
