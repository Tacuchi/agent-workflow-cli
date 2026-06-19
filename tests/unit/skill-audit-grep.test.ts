import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The `w` bundle (new stages+loops model). This audit asserts the bundle carries
// NO hard-coded legacy QTC references (R2 mitigation, carried over from the old
// bundle audit — the new bundle must be clean from the start).
const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");

const SCANNED_SUBFOLDERS = ["commands", "loops", "exports", "roles", "artifacts", "hooks"];

// No exemptions: the new bundle must be entirely free of legacy QTC refs.
const EXEMPT_FILES = new Set<string>();

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
    } else if (
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".json") ||
      entry.name.endsWith(".sql")
    ) {
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

describe("SKILL audit grep — hard-coded legacy refs (R2 mitigation)", () => {
  it("skills/w/ folder exists", async () => {
    const stats = await stat(SKILL_ROOT);
    expect(stats.isDirectory()).toBe(true);
  });

  it("zero hits of `QTC-PROJECT` (use the namespaced project block)", async () => {
    expect(await gatherHits(/QTC-PROJECT/)).toEqual([]);
  });

  it("zero hits of `qtc-cert` or `qtc-prod` (use generic MCP names)", async () => {
    expect(await gatherHits(/qtc-(cert|prod)/)).toEqual([]);
  });

  it("zero hits of `qtc:<anchor>`", async () => {
    expect(await gatherHits(/qtc:[a-z]/)).toEqual([]);
  });

  it("zero hits of `/qtc:<slash-command>` (use /w:<cmd>)", async () => {
    expect(await gatherHits(/\/qtc:/)).toEqual([]);
  });

  it("zero hits of `MCP_QTC_*_URL` env var (use generic MCP_*_URL)", async () => {
    expect(await gatherHits(/MCP_QTC/)).toEqual([]);
  });

  it("zero hits of `QTC-WORKFLOW` legacy detector (clean bundle)", async () => {
    expect(await gatherHits(/QTC-WORKFLOW/)).toEqual([]);
  });

  it("zero hits of the legacy `/agent-workflow:` slash namespace (use /w:)", async () => {
    expect(await gatherHits(/\/agent-workflow:/)).toEqual([]);
  });
});
