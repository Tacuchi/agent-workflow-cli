import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  harnessById,
  harnessForMcpHost,
  resolveGlobalMcpRawPath,
} from "../../src/domain/harnesses.js";

describe("HARNESSES registry — shape invariants", () => {
  it("contiene exactamente los 4 harnesses esperados", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    expect(ids).toContain("warp");
    expect(ids).toContain("oz");
    expect(ids).toHaveLength(4);
  });

  it("cada harness tiene envMarkers no vacío", () => {
    for (const h of HARNESSES) {
      expect(h.envMarkers.length, `${h.id} debe tener al menos un envMarker`).toBeGreaterThan(0);
    }
  });

  it("cada harness tiene skillsDirs no vacío", () => {
    for (const h of HARNESSES) {
      expect(h.skillsDirs.length, `${h.id} debe tener al menos un skillsDir`).toBeGreaterThan(0);
    }
  });

  it("harnesses con mcpHostId tienen globalMcpPaths", () => {
    for (const h of HARNESSES) {
      if (h.mcpHostId !== null) {
        expect(h.globalMcpPaths, `${h.id} tiene mcpHostId pero no globalMcpPaths`).toBeDefined();
      }
    }
  });

  it("oz no tiene mcpHostId ni pluginManifest ni pluginHooksDir", () => {
    const oz = HARNESSES.find((h) => h.id === "oz");
    expect(oz?.mcpHostId).toBeNull();
    expect(oz?.pluginManifest).toBeNull();
    expect(oz?.pluginHooksDir).toBeNull();
  });

  it("warp tiene mcpHostId='warp' y pluginManifest=null (DEC-W2)", () => {
    const warp = HARNESSES.find((h) => h.id === "warp");
    expect(warp?.mcpHostId).toBe("warp");
    expect(warp?.pluginManifest).toBeNull();
    expect(warp?.pluginHooksDir).toBeNull();
  });

  it("oz aparece antes que warp para prioridad first-match (OZ_RUN_ID > WarpTerminal)", () => {
    const ozIdx = HARNESSES.findIndex((h) => h.id === "oz");
    const warpIdx = HARNESSES.findIndex((h) => h.id === "warp");
    expect(ozIdx).toBeLessThan(warpIdx);
  });

  it("no hay ids duplicados", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveGlobalMcpRawPath", () => {
  const warpSpec =
    harnessById("warp") ??
    (() => {
      throw new Error("warp not found");
    })();
  const claudeSpec =
    harnessById("claude-code") ??
    (() => {
      throw new Error("claude-code not found");
    })();
  const ozSpec =
    harnessById("oz") ??
    (() => {
      throw new Error("oz not found");
    })();

  it("warp darwin stable → ~/.warp/.mcp.json", () => {
    expect(resolveGlobalMcpRawPath(warpSpec, "darwin", "stable")).toBe("~/.warp/.mcp.json");
  });

  it("warp darwin preview → ~/.warp-preview/.mcp.json", () => {
    expect(resolveGlobalMcpRawPath(warpSpec, "darwin", "preview")).toBe(
      "~/.warp-preview/.mcp.json",
    );
  });

  it("warp linux stable → ~/.config/warp-terminal/.mcp.json", () => {
    expect(resolveGlobalMcpRawPath(warpSpec, "linux", "stable")).toBe(
      "~/.config/warp-terminal/.mcp.json",
    );
  });

  it("claude darwin stable → ~/.claude.json (plataforma uniforme)", () => {
    expect(resolveGlobalMcpRawPath(claudeSpec, "darwin", "stable")).toBe("~/.claude.json");
  });

  it("oz retorna null (sin globalMcpPaths)", () => {
    expect(resolveGlobalMcpRawPath(ozSpec, "darwin", "stable")).toBeNull();
  });
});

describe("harnessForMcpHost", () => {
  it("'claude' → claude-code spec", () => {
    expect(harnessForMcpHost("claude")?.id).toBe("claude-code");
  });

  it("'codex' → codex spec", () => {
    expect(harnessForMcpHost("codex")?.id).toBe("codex");
  });

  it("'warp' → warp spec", () => {
    expect(harnessForMcpHost("warp")?.id).toBe("warp");
  });
});

describe("harnessById", () => {
  it("devuelve spec correcta por id", () => {
    expect(harnessById("oz")?.id).toBe("oz");
    expect(harnessById("warp")?.id).toBe("warp");
  });
});
