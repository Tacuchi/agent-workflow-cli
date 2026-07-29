import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  harnessById,
  harnessForMcpHost,
  resolveGlobalMcpRawPath,
} from "../../src/domain/harnesses.js";

describe("HARNESSES registry — shape invariants", () => {
  it("contiene los 8 harnesses esperados (claude/codex/oz/warp + gemini/opencode/crush + kimi)", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    expect(ids).toContain("warp");
    expect(ids).toContain("oz");
    expect(ids).toContain("gemini");
    expect(ids).toContain("opencode");
    expect(ids).toContain("crush");
    expect(ids).toContain("kimi");
    expect(ids).toHaveLength(8);
  });

  it("codex expone skills en .agents/skills (estándar abierto, no solo .codex/skills)", () => {
    const codex = HARNESSES.find((h) => h.id === "codex");
    expect(codex?.skillsDirs).toContain(".agents/skills");
    // hooks bundled from hooks/hooks.json at the plugin root (PLUGIN_ROOT env)
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

  it("crush: mcpHostId + crush.json + skills XDG (~/.config/crush) primero; .crush/skills solo proyecto", () => {
    const crush = HARNESSES.find((h) => h.id === "crush");
    expect(crush?.mcpHostId).toBe("crush");
    expect(crush?.installTarget).toBe("crush");
    expect(crush?.projectMcpPath).toBe("crush.json");
    expect(crush?.skillsDirs).toEqual([
      ".config/crush/skills",
      ".config/agents/skills",
      ".agents/skills",
      ".crush/skills",
      ".claude/skills",
    ]);
  });

  // Antes se exigía envMarkers no vacío en TODOS. Kimi Code no exporta ninguno a
  // sus subprocesos (probe 2026-07-29: `env | grep ^KIMI` vacío dentro de su
  // propia shell), así que el invariante real no es "todos tienen marcador" sino
  // "todo host es detectable de alguna forma": marcadores de entorno o binario.
  it("todo harness es detectable: env markers o un binario que sondear", () => {
    for (const h of HARNESSES) {
      const detectable = h.envMarkers.length > 0 || h.runtime.bins.length > 0;
      expect(detectable, `${h.id} no tiene ni envMarkers ni binario que sondear`).toBe(true);
    }
  });

  it("kimi: sin env markers (verificado) → se detecta por binario + config dir", () => {
    const kimi = HARNESSES.find((h) => h.id === "kimi");
    expect(kimi?.envMarkers).toEqual([]);
    expect(kimi?.runtime.bins).toContain("kimi");
    // Su instalador deja el binario fuera del PATH de una shell no interactiva.
    expect(kimi?.runtime.fallbackBinPaths).toContain("~/.kimi-code/bin/kimi");
    expect(kimi?.configDir).toEqual({ kind: "dir", path: "~/.kimi-code" });
  });

  it("kimi: MCP con shape mcpServers en ~/.kimi-code/mcp.json y skills en 2 tiers", () => {
    const kimi = HARNESSES.find((h) => h.id === "kimi");
    expect(kimi?.mcpHostId).toBe("kimi");
    expect(kimi?.projectMcpPath).toBe(".kimi-code/mcp.json");
    expect(resolveGlobalMcpRawPath(kimi as never, "darwin")).toBe("~/.kimi-code/mcp.json");
    expect(kimi?.skillsDirs).toEqual([".kimi-code/skills", ".agents/skills"]);
  });

  it("cada harness declara nivel de soporte con glifo único", () => {
    const glyphs = HARNESSES.map((h) => h.glyph);
    expect(new Set(glyphs).size, `glifos duplicados: ${glyphs.join(",")}`).toBe(glyphs.length);
    for (const h of HARNESSES) {
      expect(["official", "best-effort"], `${h.id}`).toContain(h.support.tier);
      expect(h.label.length, `${h.id} sin label`).toBeGreaterThan(0);
    }
  });

  it("un host con hooks gestionados declara su mecanismo", () => {
    for (const h of HARNESSES) {
      if (h.hooks?.managed === true) {
        expect(h.hooks.mechanism.length, `${h.id}`).toBeGreaterThan(0);
      }
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

  it("warp darwin → ~/.warp/.mcp.json", () => {
    expect(resolveGlobalMcpRawPath(warpSpec, "darwin")).toBe("~/.warp/.mcp.json");
  });

  it("warp linux → ~/.config/warp-terminal/.mcp.json", () => {
    expect(resolveGlobalMcpRawPath(warpSpec, "linux")).toBe("~/.config/warp-terminal/.mcp.json");
  });

  it("claude darwin → ~/.claude.json (plataforma uniforme)", () => {
    expect(resolveGlobalMcpRawPath(claudeSpec, "darwin")).toBe("~/.claude.json");
  });

  it("oz retorna null (sin globalMcpPaths)", () => {
    expect(resolveGlobalMcpRawPath(ozSpec, "darwin")).toBeNull();
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
