import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpSetup } from "../../src/application/mcp-setup-service.js";
import {
  buildMcpEntry,
  knownLegacyMcpEntries,
  mcpEntryShapeForHost,
} from "../../src/domain/mcp-entry.js";
import { worklineMcpEntry } from "../../src/domain/workline-mcp-entry.js";
import { FakeEnv } from "../helpers/fake-env.js";

const ALPHA = { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" };
const BETA = { name: "beta", dsnVar: "BETA_DATABASE_URL" };

describe("runMcpSetup", () => {
  let workspace: string;
  let home: string;
  let env: FakeEnv;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "mcp-setup-svc-"));
    home = join(workspace, "home");
    env = new FakeEnv(home, workspace);
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("aplica las 4 combinaciones host×conexión en una corrida", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude", "codex"],
      connections: [ALPHA, BETA],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dry_run).toBe(false);
    expect(result.scope).toBe("workspace");
  });

  it("idempotencia: segunda corrida marca todo como skipped", () => {
    runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });
    const second = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });
    if ("ok" in second) throw new Error("did not expect refusal");
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
  });

  it("dry-run no escribe", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude", "codex"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
      dryRun: true,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied.every((r) => r.action === "dry-run")).toBe(true);
    expect(result.dry_run).toBe(true);
  });

  it("una entrada homónima de forma ajena se informa como conflicto y no se escribe", () => {
    const file = join(workspace, ".mcp.json");
    const foreign = `${JSON.stringify(
      { mcpServers: { alpha: { command: "node", args: ["foreign.js"], env: {} } } },
      null,
      2,
    )}\n`;
    writeFileSync(file, foreign);

    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "workspace",
      workspace,
    });

    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.action).toBe("conflict");
    expect(readFileSync(file, "utf-8")).toBe(foreign);
  });

  it("no reemplaza el servidor legacy de elicitation sin la migración explícita", () => {
    const file = join(workspace, ".mcp.json");
    const legacy = worklineMcpEntry("claude");
    const original = `${JSON.stringify(
      { mcpServers: { "agent-workflow": mcpEntryShapeForHost("claude", legacy) } },
      null,
      2,
    )}\n`;
    writeFileSync(file, original);

    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [{ name: "agent-workflow", dsnVar: "WORKLINE_DATABASE_URL" }],
      scope: "workspace",
      workspace,
    });

    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([expect.objectContaining({ action: "conflict" })]);
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  // A CLI upgrade rewrites nothing on disk, so the descriptor keeps the release
  // that wrote it. Install has to refresh it in place: refusing it as somebody
  // else's server leaves the user with an entry no Workline command can touch.
  it("install reemplaza un descriptor propio escrito por otra release", () => {
    const current = buildMcpEntry("alpha", "ALPHA_DATABASE_URL", {
      host: "claude",
      scope: "global",
      namespace: "workflow",
    });
    const prior = { ...current, args: [...current.args.slice(0, -1), "0.0.1"] };
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      `${JSON.stringify({ mcpServers: { alpha: mcpEntryShapeForHost("claude", prior) } }, null, 2)}\n`,
      "utf-8",
    );

    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
      globalApproval: "explicit-cli-force",
    });

    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.conflicts).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([expect.objectContaining({ action: "written" })]);
    const written = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    expect(written.mcpServers.alpha).toEqual(mcpEntryShapeForHost("claude", current));
  });

  // The boundary of that refresh: install owns a version bump, never a shape
  // migration. An `mcp dbhub`-era entry still goes through `aw mcp migrate`,
  // which previews what it is about to replace.
  it("install NO migra una forma histórica distinta: sigue en conflicto", () => {
    const legacy = knownLegacyMcpEntries("alpha", "ALPHA_DATABASE_URL")[0];
    if (legacy === undefined) throw new Error("expected a known legacy shape");
    mkdirSync(home, { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { alpha: mcpEntryShapeForHost("claude", legacy) } }, null, 2)}\n`;
    writeFileSync(join(home, ".claude.json"), original, "utf-8");

    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
      globalApproval: "explicit-cli-force",
    });

    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([expect.objectContaining({ action: "conflict" })]);
    expect(readFileSync(join(home, ".claude.json"), "utf-8")).toBe(original);
  });

  // The pre-read that decides whether a legacy may be replaced is an
  // optimization over what the writer re-derives; if it throws, the operation
  // must still end in the writer's typed conflict on the exact file, not in a
  // raw filesystem error.
  it("un config ilegible no rompe el install: sigue siendo el conflicto tipado del writer", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    // A directory where the historic settings file goes: readFileSync throws EISDIR.
    mkdirSync(join(home, ".claude", "settings.json"), { recursive: true });

    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
      globalApproval: "explicit-cli-force",
    });

    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        action: "conflict",
        target: join(home, ".claude", "settings.json"),
      }),
    ]);
  });

  it("acepta conexiones custom y normaliza el nombre del server", () => {
    const result = runMcpSetup(env, {
      hosts: ["codex"],
      connections: [{ name: "reporting", dsnVar: "REPORTING_DATABASE_URL" }],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.name).toBe("reporting");
  });

  it("incluye la variable DSN exacta registrada", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [{ name: "reporting", dsnVar: "REPORTING_DATABASE_URL" }],
      scope: "workspace",
      workspace,
    });
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.applied[0]?.name).toBe("reporting");
  });

  it("scope=global sin --force ni --dry-run retorna refusal con exit 2", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
    });
    expect("ok" in result).toBe(true);
    if (!("ok" in result)) throw new Error("expected refusal");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("global_requires_force");
    expect(result.exitCode).toBe(2);
  });

  it("scope=global con consentimiento CLI explícito escribe en el home inyectado (EnvPort), no en el real", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
      globalApproval: "explicit-cli-force",
      workspace,
    });
    expect("ok" in result).toBe(false);
    if ("ok" in result) throw new Error("did not expect refusal");
    expect(result.scope_dir).toBe(home);
    expect(result.applied[0]?.target).toBe(join(home, ".claude.json"));
  });

  it("scope=global con --dry-run NO retorna refusal", () => {
    const result = runMcpSetup(env, {
      hosts: ["claude"],
      connections: [ALPHA],
      scope: "global",
      dryRun: true,
      workspace,
    });
    expect("ok" in result).toBe(false);
  });
});
