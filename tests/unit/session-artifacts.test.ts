import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FILENAMES,
  type ArtifactKind,
  canonicalArtifactFilename,
  canonicalArtifactPath,
  findArtifact,
  listExistingArtifacts,
} from "../../src/application/session-artifacts.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";

class FakeFs implements FileSystemPort {
  files = new Map<string, string>();
  dirs = new Map<string, DirEntry[]>();
  registerDir = true;

  constructor(initial: Record<string, string> = {}, options: { registerDir?: boolean } = {}) {
    this.registerDir = options.registerDir !== false;
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
      if (this.registerDir) {
        const parent = parentOf(path);
        const list = this.dirs.get(parent) ?? [];
        list.push({ name: baseOf(path), path, type: "file" });
        this.dirs.set(parent, list);
      }
    }
  }

  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, content: string): Promise<void> {
    this.files.set(p, content);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(p: string): Promise<void> {
    if (!this.dirs.has(p)) this.dirs.set(p, []);
  }
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p)) {
      return { mtime: new Date(0), size: 0, type: "file" };
    }
    if (this.dirs.has(p)) {
      return { mtime: new Date(0), size: 0, type: "dir" };
    }
    throw new Error(`ENOENT: ${p}`);
  }
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}
function baseOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

const FOLDER = "/cwd/.workflow/sessions/session042-dev-foo";

describe("ARTIFACT_FILENAMES", () => {
  it("includes EN and ES variants for migrated artifacts", () => {
    expect(ARTIFACT_FILENAMES.objective).toEqual(["OBJECTIVE.md", "OBJETIVO.md"]);
    expect(ARTIFACT_FILENAMES.findings).toEqual(["FINDINGS.md", "HALLAZGOS.md"]);
    expect(ARTIFACT_FILENAMES.decisions).toEqual(["DECISIONS.md", "DECISIONES.md"]);
    expect(ARTIFACT_FILENAMES.evidence).toEqual(["EVIDENCE.md", "EVIDENCIA.md"]);
    expect(ARTIFACT_FILENAMES.conclusions).toEqual(["CONCLUSIONS.md", "CONCLUSIONES.md"]);
    expect(ARTIFACT_FILENAMES.recommendation).toEqual(["RECOMMENDATION.md", "RECOMENDACION.md"]);
    expect(ARTIFACT_FILENAMES.delivery).toEqual(["DELIVERY.md", "ENTREGA.md"]);
    expect(ARTIFACT_FILENAMES.dependencies).toEqual(["DEPENDENCIES.md", "DEPENDENCIAS.md"]);
    expect(ARTIFACT_FILENAMES.problem).toEqual(["PROBLEM.md", "PROBLEMA.md"]);
  });

  it("uses single EN entry for already-English artifacts", () => {
    expect(ARTIFACT_FILENAMES.tasks).toEqual(["TASKS.md"]);
    expect(ARTIFACT_FILENAMES.checkpoint).toEqual(["CHECKPOINT.md"]);
    expect(ARTIFACT_FILENAMES.status).toEqual(["STATUS.md"]);
    expect(ARTIFACT_FILENAMES.requirements).toEqual(["REQUIREMENTS.md"]);
    expect(ARTIFACT_FILENAMES.discovery).toEqual(["DISCOVERY.md"]);
  });

  it("includes the new-model artifact kinds (P2.3)", () => {
    expect(ARTIFACT_FILENAMES.session).toEqual(["SESSION.md"]);
    expect(ARTIFACT_FILENAMES.analysis_file).toEqual(["ANALYSIS-FILE.md"]);
    expect(ARTIFACT_FILENAMES.technical_note).toEqual(["TECHNICAL-NOTE.md"]);
    expect(canonicalArtifactFilename("session")).toBe("SESSION.md");
  });
});

describe("canonicalArtifactFilename / canonicalArtifactPath", () => {
  it("returns EN UPPERCASE filename for new writes", () => {
    expect(canonicalArtifactFilename("objective")).toBe("OBJECTIVE.md");
    expect(canonicalArtifactFilename("findings")).toBe("FINDINGS.md");
    expect(canonicalArtifactFilename("tasks")).toBe("TASKS.md");
  });

  it("joins folder with canonical filename", () => {
    expect(canonicalArtifactPath(FOLDER, "objective")).toBe(`${FOLDER}/OBJECTIVE.md`);
    expect(canonicalArtifactPath(FOLDER, "decisions")).toBe(`${FOLDER}/DECISIONS.md`);
  });
});

describe("findArtifact", () => {
  it("returns null when folder doesn't exist", async () => {
    const fs = new FakeFs();
    expect(await findArtifact(FOLDER, "objective", fs)).toBeNull();
  });

  it("returns null when no candidate is present", async () => {
    const fs = new FakeFs({ [`${FOLDER}/SOMETHING_ELSE.md`]: "x" });
    expect(await findArtifact(FOLDER, "objective", fs)).toBeNull();
  });

  it("resolves legacy ES filename when only ES exists", async () => {
    const fs = new FakeFs({ [`${FOLDER}/OBJETIVO.md`]: "# Objetivo\n" });
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/OBJETIVO.md`);
  });

  it("resolves canonical EN filename when only EN exists", async () => {
    const fs = new FakeFs({ [`${FOLDER}/OBJECTIVE.md`]: "# Objective\n" });
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/OBJECTIVE.md`);
  });

  it("prefers EN over ES when both exist", async () => {
    const fs = new FakeFs({
      [`${FOLDER}/OBJECTIVE.md`]: "# Objective\n",
      [`${FOLDER}/OBJETIVO.md`]: "# Objetivo\n",
    });
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/OBJECTIVE.md`);
  });

  it("matches case-insensitively (lowercase legacy filename)", async () => {
    const fs = new FakeFs({ [`${FOLDER}/objetivo.md`]: "# Objetivo\n" });
    expect(await findArtifact(FOLDER, "objective", fs)).toBe(`${FOLDER}/objetivo.md`);
  });

  it("falls back to fs.exists when fs.list does not register the file", async () => {
    // Simulate a partial fake fs (files set, dirs map empty) — list throws for the folder.
    const fs = new FakeFs(
      { [`${FOLDER}/DECISIONES.md`]: "# Decisiones\n" },
      { registerDir: false },
    );
    expect(await findArtifact(FOLDER, "decisions", fs)).toBe(`${FOLDER}/DECISIONES.md`);
  });

  it("resolves discovery as already-English", async () => {
    const fs = new FakeFs({ [`${FOLDER}/DISCOVERY.md`]: "x" });
    expect(await findArtifact(FOLDER, "discovery", fs)).toBe(`${FOLDER}/DISCOVERY.md`);
  });

  it("resolves problem with bilingual fallback", async () => {
    const fs = new FakeFs({ [`${FOLDER}/PROBLEMA.md`]: "x" });
    expect(await findArtifact(FOLDER, "problem", fs)).toBe(`${FOLDER}/PROBLEMA.md`);
  });
});

describe("listExistingArtifacts", () => {
  it("returns null for every kind on an empty folder", async () => {
    const fs = new FakeFs();
    const result = await listExistingArtifacts(FOLDER, fs);
    for (const kind of Object.keys(ARTIFACT_FILENAMES) as ArtifactKind[]) {
      expect(result[kind]).toBeNull();
    }
  });

  it("returns paths for present artifacts mixing ES and EN", async () => {
    const fs = new FakeFs({
      [`${FOLDER}/OBJETIVO.md`]: "# Objetivo\n",
      [`${FOLDER}/FINDINGS.md`]: "# Findings\n",
      [`${FOLDER}/TASKS.md`]: "- [ ] foo\n",
    });
    const result = await listExistingArtifacts(FOLDER, fs);
    expect(result.objective).toBe(`${FOLDER}/OBJETIVO.md`);
    expect(result.findings).toBe(`${FOLDER}/FINDINGS.md`);
    expect(result.tasks).toBe(`${FOLDER}/TASKS.md`);
    expect(result.decisions).toBeNull();
    expect(result.checkpoint).toBeNull();
  });

  it("uses fs.exists fallback when listing is incomplete", async () => {
    const fs = new FakeFs(
      { [`${FOLDER}/OBJETIVO.md`]: "x", [`${FOLDER}/CHECKPOINT.md`]: "y" },
      { registerDir: false },
    );
    const result = await listExistingArtifacts(FOLDER, fs);
    expect(result.objective).toBe(`${FOLDER}/OBJETIVO.md`);
    expect(result.checkpoint).toBe(`${FOLDER}/CHECKPOINT.md`);
  });
});
