import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type McpStdioProbeExpectedTool,
  type McpStdioProbeSpawnOptions,
  runMcpStdioProbe,
} from "../../src/application/mcp-stdio-probe.js";

const DESCRIPTOR = {
  command: "/usr/local/bin/node",
  args: ["/opt/workline/dist/cli/main.js", "mcp", "serve-db", "--instance", "qtc-cert"],
  env: { WORKLINE_MARKER: "persisted" },
};

const EXPECTED_TOOLS: readonly McpStdioProbeExpectedTool[] = [
  {
    name: "execute_sql",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "search_objects",
    inputSchema: {
      type: "object",
      properties: { object_type: { type: "string" } },
      additionalProperties: false,
    },
  },
];

interface IncomingRpc {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

class FakeMcpChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 41_001;
  readonly requests: IncomingRpc[] = [];
  readonly killed: Array<NodeJS.Signals | number | undefined> = [];
  private buffer = "";

  constructor(
    private readonly tools: readonly McpStdioProbeExpectedTool[] = EXPECTED_TOOLS,
    private readonly protocolVersion = "2025-06-18",
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => this.acceptChunk(String(chunk)));
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal);
    return true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  private acceptChunk(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.acceptMessage(JSON.parse(line) as IncomingRpc);
    }
  }

  private acceptMessage(message: IncomingRpc): void {
    this.requests.push(message);
    if (message.method === "initialize" && typeof message.id === "number") {
      this.reply(message.id, {
        protocolVersion: this.protocolVersion,
        capabilities: { tools: {} },
      });
      return;
    }
    if (message.method === "tools/list" && typeof message.id === "number") {
      this.reply(message.id, { tools: this.tools });
      return;
    }
    if (message.method === "tools/call" && typeof message.id === "number") {
      this.reply(message.id, {
        content: [
          {
            type: "text",
            mimeType: "application/json",
            text: '{"success":true,"data":{"statements":[{"sql":"SELECT 1 AS ok","rows":[{"ok":1}],"count":1}]}}',
          },
        ],
      });
    }
  }

  private reply(id: number, result: unknown): void {
    queueMicrotask(() => {
      this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    });
  }
}

function shortTimeouts() {
  return { spawn: 100, initialize: 100, initialized: 100, toolsList: 100, toolsCall: 100 };
}

describe("runMcpStdioProbe", () => {
  it("ejecuta el lifecycle launch contra el descriptor persistido sin shell", async () => {
    const child = new FakeMcpChild();
    let launched: {
      command: string;
      args: readonly string[];
      options: McpStdioProbeSpawnOptions;
    } | null = null;

    const result = await runMcpStdioProbe(
      { descriptor: DESCRIPTOR, expectedTools: EXPECTED_TOOLS, timeouts: shortTimeouts() },
      {
        environment: { BASE_MARKER: "inherited" },
        spawn: (command, args, options) => {
          launched = { command, args, options };
          return child.asChildProcess();
        },
      },
    );

    expect(result).toEqual({
      ok: true,
      mode: "launch",
      protocol_version: "2025-06-18",
      tool_count: 2,
    });
    expect(launched).toMatchObject({
      command: DESCRIPTOR.command,
      args: DESCRIPTOR.args,
      options: {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          BASE_MARKER: "inherited",
          WORKLINE_MARKER: "persisted",
          AW_MCP_PROBE: "1",
        },
      },
    });
    expect(child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("en modo data llama execute_sql, sin volver su payload parte del resultado", async () => {
    const child = new FakeMcpChild();

    const result = await runMcpStdioProbe(
      {
        descriptor: DESCRIPTOR,
        mode: "data",
        expectedTools: EXPECTED_TOOLS,
        timeouts: shortTimeouts(),
      },
      { spawn: () => child.asChildProcess(), environment: {} },
    );

    expect(result).toEqual({
      ok: true,
      mode: "data",
      protocol_version: "2025-06-18",
      tool_count: 2,
      data_verified: true,
    });
    const call = child.requests.find((request) => request.method === "tools/call");
    expect(call).toMatchObject({
      params: { name: "execute_sql", arguments: { sql: "SELECT 1 AS ok" } },
    });
    expect(JSON.stringify(result)).not.toContain("SELECT 1 AS ok");
  });

  it("informa una divergencia de schema sin avanzar al probe de datos", async () => {
    const child = new FakeMcpChild([
      {
        name: "execute_sql",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);

    const result = await runMcpStdioProbe(
      {
        descriptor: DESCRIPTOR,
        mode: "data",
        expectedTools: EXPECTED_TOOLS,
        timeouts: shortTimeouts(),
      },
      { spawn: () => child.asChildProcess(), environment: {} },
    );

    expect(result).toEqual({
      ok: false,
      mode: "data",
      phase: "tools/list",
      code: "TOOL_SCHEMA_MISMATCH",
      error: "Las tools publicadas no coinciden con el catálogo esperado.",
    });
    expect(child.requests.map((request) => request.method)).not.toContain("tools/call");
  });

  it("rechaza una versión de protocolo distinta antes de initialized", async () => {
    const child = new FakeMcpChild(EXPECTED_TOOLS, "2024-11-05");

    const result = await runMcpStdioProbe(
      { descriptor: DESCRIPTOR, expectedTools: EXPECTED_TOOLS, timeouts: shortTimeouts() },
      { spawn: () => child.asChildProcess(), environment: {} },
    );

    expect(result).toEqual({
      ok: false,
      mode: "launch",
      phase: "initialize",
      code: "PROTOCOL_VERSION_MISMATCH",
      error: "El servidor MCP negoció una versión de protocolo incompatible.",
    });
    expect(child.requests.map((request) => request.method)).toEqual(["initialize"]);
  });
});
