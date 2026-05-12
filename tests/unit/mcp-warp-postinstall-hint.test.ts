import { describe, expect, it } from "vitest";
import {
  buildWarpPostInstallHint,
  formatWarpPostInstallHint,
} from "../../src/application/mcp-warp-postinstall-hint.js";

describe("buildWarpPostInstallHint", () => {
  it("incluye el path y nombre del MCP en la primera línea (scope workspace)", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "workspace", "/repo/.warp/.mcp.json");
    expect(hint.lines[0]).toContain("qtc-cert");
    expect(hint.lines[0]).toContain("/repo/.warp/.mcp.json");
    expect(hint.lines[0]).toContain("project");
  });

  it("para scope global incluye etiqueta global y consejo de reinicio de app", () => {
    const hint = buildWarpPostInstallHint("qtc-prod", "global", "/home/u/.warp/.mcp.json");
    expect(hint.lines[0]).toContain("global");
    const last = hint.lines[hint.lines.length - 1] ?? "";
    expect(last).toMatch(/reinici/i);
  });

  it("para scope workspace recuerda reabrir el tab del repo", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "workspace", "/repo/.warp/.mcp.json");
    const last = hint.lines[hint.lines.length - 1] ?? "";
    expect(last).toMatch(/reabr/i);
    expect(last).toContain("/repo/.warp/.mcp.json");
  });

  it("siempre menciona el toggle 'File-based MCP Servers'", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "workspace", "/repo/.warp/.mcp.json");
    const allText = hint.lines.join("\n");
    expect(allText).toContain("File-based MCP Servers");
  });

  it("expone doc_url estable hacia docs.warp.dev", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "workspace", "/repo/.warp/.mcp.json");
    expect(hint.doc_url).toMatch(/^https:\/\/docs\.warp\.dev\//);
  });

  it("preserva metadata estructural (scope, file, name)", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "global", "/home/u/.warp/.mcp.json");
    expect(hint.scope).toBe("global");
    expect(hint.file).toBe("/home/u/.warp/.mcp.json");
    expect(hint.name).toBe("qtc-cert");
  });
});

describe("formatWarpPostInstallHint", () => {
  it("numera los pasos a partir del segundo elemento de lines", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "workspace", "/repo/.warp/.mcp.json");
    const formatted = formatWarpPostInstallHint(hint);
    expect(formatted).toMatch(/ {2}1\. /);
    expect(formatted).toMatch(/ {2}2\. /);
    expect(formatted).toMatch(/ {2}3\. /);
    expect(formatted).toMatch(/ {2}4\. /);
  });

  it("incluye la URL de documentación al final", () => {
    const hint = buildWarpPostInstallHint("qtc-cert", "workspace", "/repo/.warp/.mcp.json");
    const formatted = formatWarpPostInstallHint(hint);
    expect(formatted).toContain(`Doc: ${hint.doc_url}`);
  });
});
