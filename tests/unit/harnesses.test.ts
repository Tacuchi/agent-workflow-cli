import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  harnessById,
  harnessForMcpHost,
  resolveGlobalMcpRawPath,
} from "../../src/domain/harnesses.js";

describe("HARNESSES registry — shape invariants", () => {
  it("contiene los 7 harnesses esperados (claude/codex/oz/warp + gemini/opencode/crush)", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    expect(ids).toContain("warp");
    expect(ids).toContain("oz");
    expect(ids).toContain("gemini");
    expect(ids).toContain("opencode");
    expect(ids).toContain("crush");
    expect(ids).toHaveLength(7);
  });

  it("codex expone skills en .agents/skills (estándar abierto, no solo .codex/skills)", () => {
    const codex = HARNESSES.find((h) => h.id === "codex");
    expect(codex?.skillsDirs).toContain(".agents/skills");
    // hooks bundled desde hooks/hooks.json en la raíz del plugin (env PLUGIN_ROOT)
    expect(codex?.pluginHooksDir).toBe("hooks");
  });

  it("gemini: mcpHostId + settings.json (mcpServers) + lee .agents/skills", () => {
    const gemini = HARNESSES.find((h) => h.id === "gemini");
    expect(gemini?.mcpHostId).toBe("gemini");
    expect(gemini?.installTarget).toBe("gemini");
    expect(gemini?.projectMcpPath).toBe(".gemini/settings.json");
    expect(gemini?.skillsDirs).toContain(".agents/skills");
  });

  it("opencode: mcpHostId + opencode.json + lee .claude/.agents/.opencode skills", () => {
    const oc = HARNESSES.find((h) => h.id === "opencode");
    expect(oc?.mcpHostId).toBe("opencode");
    expect(oc?.installTarget).toBe("opencode");
    expect(oc?.projectMcpPath).toBe("opencode.json");
    expect(oc?.skillsDirs).toContain(".agents/skills");
    expect(oc?.skillsDirs).toContain(".claude/skills");
  });

  it("crush: mcpHostId + crush.json + lee .agents/.crush/.claude skills", () => {
    const crush = HARNESSES.find((h) => h.id === "crush");
    expect(crush?.mcpHostId).toBe("crush");
    expect(crush?.installTarget).toBe("crush");
    expect(crush?.projectMcpPath).toBe("crush.json");
    expect(crush?.skillsDirs).toContain(".agents/skills");
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

  it("'gemini'/'opencode'/'crush' → sus specs", () => {
    expect(harnessForMcpHost("gemini")?.id).toBe("gemini");
    expect(harnessForMcpHost("opencode")?.id).toBe("opencode");
    expect(harnessForMcpHost("crush")?.id).toBe("crush");
  });
});

describe("harnessById", () => {
  it("devuelve spec correcta por id", () => {
    expect(harnessById("oz")?.id).toBe("oz");
    expect(harnessById("warp")?.id).toBe("warp");
  });
});
