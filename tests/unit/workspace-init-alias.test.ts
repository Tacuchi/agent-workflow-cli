import { describe, expect, it } from "vitest";
import { dedupeAlias, deriveAlias } from "../../src/cli/tui/components/workspace-init-alias.js";

describe("deriveAlias", () => {
  it("toma el último segmento de un path posix", () => {
    expect(deriveAlias("/Users/me/Git/agent-workflow-cli")).toBe("agent-workflow-cli");
  });

  it("toma el nombre de la carpeta en rutas Windows (en cualquier host)", () => {
    expect(deriveAlias("C:\\Source\\msextranet_front_angular")).toBe("msextranet_front_angular");
    expect(deriveAlias("C:/Source/mscore-solicitud-spring")).toBe("mscore-solicitud-spring");
  });

  it("ignora barras finales", () => {
    expect(deriveAlias("/a/b/cli/")).toBe("cli");
    expect(deriveAlias("C:\\Source\\app\\")).toBe("app");
  });

  it("conserva el nombre tal cual (no transforma a kebab)", () => {
    expect(deriveAlias("C:\\repos\\ms_pasarela_spring")).toBe("ms_pasarela_spring");
  });
});

describe("dedupeAlias", () => {
  it("devuelve el alias si no colisiona", () => {
    expect(dedupeAlias("core", new Set())).toBe("core");
  });

  it("sufija -2, -3 ante carpetas con el mismo nombre", () => {
    expect(dedupeAlias("core", new Set(["core"]))).toBe("core-2");
    expect(dedupeAlias("core", new Set(["core", "core-2"]))).toBe("core-3");
  });
});
