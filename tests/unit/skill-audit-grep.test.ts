import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "agent-workflow");

const SCANNED_SUBFOLDERS = [
  "doctrine",
  "workflows",
  "specialties",
  "exports",
  "standards",
  "commands",
  "hooks",
];

// Files exempted from the audit (legitimate documentation that mentions legacy
// names for back-compat purposes; explained in T2.3 of session083).
const EXEMPT_FILES = new Set([
  "commands/README.md", // legacy alias example
  "references/legacy-anchors.md", // qtc:* alias table (not scanned anyway — references/ excluded)
  "references/profile-parametrization.md", // documents QTC profile behavior
]);

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

async function relativeFiles(): Promise<string[]> {
  const all: string[] = [];
  for (const sub of SCANNED_SUBFOLDERS) {
    const dir = join(SKILL_ROOT, sub);
    const files = await listFiles(dir);
    all.push(...files);
  }
  return all.map((f) => f.slice(SKILL_ROOT.length + 1));
}

async function gatherHits(pattern: RegExp): Promise<{ relpath: string; line: number }[]> {
  const files = await relativeFiles();
  const hits: { relpath: string; line: number }[] = [];
  for (const relpath of files) {
    if (EXEMPT_FILES.has(relpath)) continue;
    const text = await readFile(join(SKILL_ROOT, relpath), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i] ?? "")) hits.push({ relpath, line: i + 1 });
    }
  }
  return hits;
}

describe("SKILL audit grep — hard-coded QTC refs (R2 mitigation)", () => {
  it("skills/agent-workflow/ folder exists", async () => {
    const stats = await stat(SKILL_ROOT);
    expect(stats.isDirectory()).toBe(true);
  });

  it("zero hits of `QTC-PROJECT` (use profile.claude_md_block)", async () => {
    const hits = await gatherHits(/QTC-PROJECT/);
    expect(hits).toEqual([]);
  });

  it("zero hits of `qtc-cert` or `qtc-prod` (use profile.mcp_databases)", async () => {
    const hits = await gatherHits(/qtc-(cert|prod)/);
    expect(hits).toEqual([]);
  });

  it("zero hits of `qtc:<anchor>` (use agent-workflow:<anchor>)", async () => {
    const hits = await gatherHits(/qtc:[a-z]/);
    expect(hits).toEqual([]);
  });

  it("zero hits of `/qtc:<slash-command>` (use /agent-workflow:<cmd>)", async () => {
    const hits = await gatherHits(/\/qtc:/);
    expect(hits).toEqual([]);
  });

  it("zero hits of `MCP_QTC_*_URL` env var (use generic MCP_*_URL)", async () => {
    const hits = await gatherHits(/MCP_QTC/);
    expect(hits).toEqual([]);
  });

  it("zero hits of `qtc-workflow-plugin` path (use agent-workflow)", async () => {
    const hits = await gatherHits(/qtc-workflow-plugin/);
    expect(hits).toEqual([]);
  });

  it("residuales esperados (QTC-WORKFLOW legacy detector) están presentes", async () => {
    // Sanity: these legitimate references SHOULD still be present in migrate/hub-init/project-init
    const hits = await gatherHits(/QTC-WORKFLOW/);
    expect(hits.length).toBeGreaterThan(0);
    // Locked-in count: 10 hits per audit T2.3.
    expect(hits.length).toBe(10);
  });
});
