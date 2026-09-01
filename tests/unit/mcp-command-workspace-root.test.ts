import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertMcpConnection } from "../../src/application/mcp-connections-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  isDoctorReportBlocking,
  mcpCommand,
  safetyFromRoleOutcome,
} from "../../src/cli/commands/mcp.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

function args(
  rest: string[],
  values: Record<string, string> = {},
  flags: readonly string[] = [],
): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

describe("mcp commands use the resolved Workline root", () => {
  let sandbox: string;
  let home: string;
  let workspace: string;
  let sourceChild: string;
  let ctx: CliContext;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "mcp-command-root-"));
    home = join(sandbox, "home");
    workspace = join(sandbox, "workspace");
    sourceChild = join(workspace, "source", "nested");
    mkdirSync(sourceChild, { recursive: true });
    const namespace = normalizeNamespace("workflow");
    const paths = new PathsService(namespace, home, workspace);
    ctx = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, sourceChild),
      paths,
    } as CliContext;
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it("setup, doctor and remove stay at the resolved root rather than a source child", async () => {
    const setup = await mcpCommand.execute(args(["setup"], { host: "claude" }), ctx);
    expect(setup.ok).toBe(true);
    expect(setup.data).toMatchObject({
      scope_dir: workspace,
      materialization: { root: workspace, materialized: true },
    });
    expect(existsSync(join(workspace, ".mcp.json"))).toBe(true);
    expect(existsSync(join(workspace, ".workflow", "sessions"))).toBe(true);
    expect(existsSync(join(sourceChild, ".mcp.json"))).toBe(false);

    const doctor = await mcpCommand.execute(args(["doctor"], { host: "claude" }), ctx);
    expect(doctor.data).toMatchObject({ scope_dir: workspace });

    const remove = await mcpCommand.execute(args(["remove"], { host: "claude" }), ctx);
    expect(remove.ok).toBe(true);
    expect(remove.data).toMatchObject({
      scope_dir: workspace,
      materialization: { root: workspace, materialized: false },
    });
    expect(existsSync(join(sourceChild, ".mcp.json"))).toBe(false);
  });

  it("dry-run previews first materialization but creates neither marker nor host config", async () => {
    const preview = await mcpCommand.execute(
      args(["setup"], { host: "claude" }, ["--dry-run"]),
      ctx,
    );

    expect(preview.ok).toBe(true);
    expect(preview.data).toMatchObject({
      scope_dir: workspace,
      dry_run: true,
      materialization: { root: workspace, materialized: true },
    });
    expect(existsSync(join(workspace, ".workflow", "sessions"))).toBe(false);
    expect(existsSync(join(workspace, ".mcp.json"))).toBe(false);
  });

  it("warp-status reads the resolved root, while --workspace remains an override", async () => {
    const rootFile = join(workspace, ".warp", ".mcp.json");
    const override = join(sandbox, "override");
    const overrideFile = join(override, ".warp", ".mcp.json");
    mkdirSync(join(workspace, ".warp"), { recursive: true });
    mkdirSync(join(override, ".warp"), { recursive: true });
    writeFileSync(rootFile, JSON.stringify({ mcpServers: { root: {} } }));
    writeFileSync(overrideFile, JSON.stringify({ mcpServers: { override: {} } }));

    const rootStatus = await mcpCommand.execute(args(["warp-status"]), ctx);
    expect(rootStatus.data).toEqual(
      expect.objectContaining({
        reports: expect.arrayContaining([
          expect.objectContaining({ scope: "workspace", file: rootFile }),
        ]),
      }),
    );

    const overridden = await mcpCommand.execute(
      args(["warp-status"], { workspace: override }),
      ctx,
    );
    expect(overridden.data).toEqual(
      expect.objectContaining({
        reports: expect.arrayContaining([
          expect.objectContaining({ scope: "workspace", file: overrideFile }),
        ]),
      }),
    );
  });
});

describe("doctor PostgreSQL safety", () => {
  it("marca warning cuando el rol puede usar o asumir un rol de servidor peligroso", () => {
    expect(
      safetyFromRoleOutcome({
        superuser: false,
        canCreateRole: false,
        canCreateDatabase: false,
        canWrite: false,
        unsafeServerRole: true,
        transactionReadOnly: true,
      }),
    ).toEqual({
      status: "warning",
      superuser: false,
      write_capable: false,
      create_role: false,
      create_database: false,
      unsafe_server_role: true,
    });
  });

  it("reporta superuser como warning y no lo trata como fallo de doctor", () => {
    const safety = safetyFromRoleOutcome({
      superuser: true,
      canCreateRole: false,
      canCreateDatabase: false,
      canWrite: false,
      transactionReadOnly: true,
    });

    expect(safety).toMatchObject({ status: "warning", unsafe_server_role: false });
    expect(isDoctorReportBlocking({ status: "ok", safety })).toBe(false);
  });
});
