import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCS_CANON,
  resolveCoreDocsCanon,
  resolveDocsCanon,
} from "../../src/application/docs-canon-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { nodeFromDocPath } from "../../src/domain/workline-node.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");

describe("DocsCanon", () => {
  it("uses the current documentary layout when no configuration exists", async () => {
    const result = await resolveCoreDocsCanon(new MemFs(), paths());
    if (!result.ok) throw new Error(result.error);
    expect(result.canon).toEqual({
      research: DEFAULT_DOCS_CANON.research,
      spec: DEFAULT_DOCS_CANON.spec,
      plan: DEFAULT_DOCS_CANON.plan,
    });
  });

  it("rejects a core relocation until every lifecycle reader adopts the layout", async () => {
    const fs = new MemFs();
    fs.file(
      "/cwd/.workflow/skills.toml",
      '[docs]\nresearch = "knowledge/research"\nspec = "knowledge/specs"\nplan = "knowledge/plans"\n',
    );

    const result = await resolveCoreDocsCanon(fs, paths());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("todavía no admite un destino personalizado");
  });

  it("validates the whole table even when a caller asks for another category", async () => {
    const fs = new MemFs();
    fs.file("/cwd/.workflow/skills.toml", '[docs]\nresearch = "../outside"\n');

    const result = await resolveDocsCanon(fs, paths(), ["manuals"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("[docs].research");
  });

  it("fails closed for an unknown documentary category", async () => {
    const fs = new MemFs();
    fs.file("/cwd/.workflow/skills.toml", '[docs]\nunknown = "docs/unknown"\n');

    const result = await resolveCoreDocsCanon(fs, paths());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no reconoce 'unknown'");
  });

  it("does not let custody create a session when the core canon is invalid", async () => {
    const fs = new MemFs();
    fs.file("/cwd/.workflow/skills.toml", '[docs]\nplan = "knowledge/plans"\n');

    const result = await runSessionCreate(fs, paths(), {
      type: "exec",
      name: "x-plan-exec",
      objetivo: "probar el límite",
    });

    expect(result).toMatchObject({ code: "DOCS_CANON_INVALID" });
    expect(await fs.exists("/cwd/.workflow/sessions")).toBe(false);
  });

  it("lets domain readers receive their roots instead of rebuilding docs/specs|plans", () => {
    const canon = {
      research: "knowledge/research",
      spec: "knowledge/specs",
      plan: "knowledge/plans",
    };

    expect(nodeFromDocPath("knowledge/specs/1000-spec-corte.md", canon)).toEqual({
      kind: "spec",
      key: "1000",
    });
    expect(nodeFromDocPath("docs/specs/1000-spec-corte.md", canon)).toBeNull();
  });
});
