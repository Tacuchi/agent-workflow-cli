import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfNamespace } from "../../src/application/self/namespace-info.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("selfNamespace", () => {
  it("returns namespace and source from context", async () => {
    const ctx = {
      namespace: { namespace: normalizeNamespace("workflow"), source: "env" },
      paths: new PathsService(normalizeNamespace("workflow"), "/h", "/c"),
    } as unknown as CliContext;
    const result = await selfNamespace(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ namespace: "workflow", source: "env" });
    }
  });
});
