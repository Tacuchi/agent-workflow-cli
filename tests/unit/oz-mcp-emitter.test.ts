import { describe, expect, it } from "vitest";
import {
  buildOzMcpInvocation,
  mcpEntryToOzServer,
} from "../../src/application/multiroot/oz.js";

describe("buildOzMcpInvocation", () => {
  it("genera comando oz con --mcp y JSON minificado", () => {
    const result = buildOzMcpInvocation(["--agent", "myAgent"], {
      cert: { command: "agent-workflow", args: ["mcp", "dbhub", "cert"], env: { READONLY: "true" } },
    });
    expect(result.command).toContain("oz agent run");
    expect(result.command).toContain("--mcp");
    expect(result.command).toContain("--agent myAgent");
    const jsonPart = result.mcpJson;
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    expect((parsed.cert as Record<string, unknown>).command).toBe("agent-workflow");
  });

  it("mcpJson es parseable para múltiples servidores", () => {
    const result = buildOzMcpInvocation([], {
      cert: { command: "agent-workflow", args: ["mcp", "dbhub", "cert"] },
      prod: { command: "agent-workflow", args: ["mcp", "dbhub", "prod"] },
    });
    const parsed = JSON.parse(result.mcpJson) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(2);
    expect(parsed.cert).toBeDefined();
    expect(parsed.prod).toBeDefined();
  });

  it("no escribe ningún archivo — solo retorna estructura con command/mcpJson/hint", () => {
    const result = buildOzMcpInvocation([], { srv: { command: "x", args: [] } });
    expect(typeof result.command).toBe("string");
    expect(typeof result.mcpJson).toBe("string");
    expect(typeof result.hint).toBe("string");
  });

  it("escapa comillas simples en el JSON embebido en el shell command", () => {
    const result = buildOzMcpInvocation([], { srv: { command: "x's", args: [] } });
    expect(result.command).not.toMatch(/'x's'/);
  });
});

describe("mcpEntryToOzServer", () => {
  it("mapea command, args, env a OzMcpServer", () => {
    const server = mcpEntryToOzServer({
      command: "agent-workflow",
      args: ["mcp", "dbhub", "cert"],
      env: { READONLY: "true", TRANSPORT: "stdio" },
    });
    expect(server.command).toBe("agent-workflow");
    expect(server.args).toEqual(["mcp", "dbhub", "cert"]);
    expect(server.env).toEqual({ READONLY: "true", TRANSPORT: "stdio" });
  });

  it("omite la clave env cuando el objeto env está vacío", () => {
    const server = mcpEntryToOzServer({ command: "x", args: [], env: {} });
    expect(server.env).toBeUndefined();
  });
});
