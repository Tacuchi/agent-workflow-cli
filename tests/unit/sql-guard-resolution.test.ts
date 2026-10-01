import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHub } from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * The SQL guard reads only the user's runtime config, so a hub that cannot be
 * resolved never turns it off: a hook exits 0 on a resolution error, and that
 * exit would let every mutation through.
 *
 * Run after `npm run build`: the guard is reached through the binary's entry.
 */

const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");

let root: string;
let home: string;
let source: string;

function hubBlock(): string {
  return [
    "<!-- WORKFLOW-HUB-START -->",
    "## Hub",
    "",
    "Hub de prueba",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    `| app | ${source} | main |`,
    "<!-- WORKFLOW-HUB-END -->",
    "",
  ].join("\n");
}

async function declaringHub(name: string): Promise<void> {
  const hub = join(root, name);
  mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
  writeFileSync(join(hub, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
  writeFileSync(join(hub, "CLAUDE.md"), hubBlock());
  writeFileSync(join(hub, "AGENTS.md"), hubBlock());
  const namespace = normalizeNamespace("workflow");
  await registerHub(new NodeFileSystem(), new PathsService(namespace, home, hub), hub);
}

/** `namespace: null` leaves AW_NAMESPACE unset, so the folder decides. */
function sqlGuard(cwd: string, sql: string, flags: string[], namespace: string | null) {
  const { AW_NAMESPACE: _inherited, ...inherited } = process.env;
  const env = {
    ...inherited,
    HOME: home,
    ...(namespace === null ? {} : { AW_NAMESPACE: namespace }),
  };
  return spawnSync(process.execPath, [CLI, "hook", "sql-mutation-guard", ...flags], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "mcp__db__execute_sql", tool_input: { sql } }),
    env,
  });
}

function expectGuarded(cwd: string, flags: string[] = [], namespace: string | null = "workflow") {
  const blocked = sqlGuard(cwd, "DELETE FROM data", flags, namespace);
  expect([blocked.status, blocked.stderr]).toEqual([2, expect.stringContaining("DELETE")]);
  expect(sqlGuard(cwd, "SELECT 1", flags, namespace).status).toBe(0);
}

/** The guard's config lives in the user runtime of one namespace. */
function configureSqlGuard(namespace: string): void {
  const config = join(home, `.${namespace}`, "agent-workflow");
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "runtime.json"),
    JSON.stringify({
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      mcpGuards: {
        sqlMutation: { toolPattern: "^mcp__.+__execute_sql$", serverPattern: "^mcp__(.+?)__" },
      },
    }),
  );
}

function markNamespaces(folder: string, namespaces: readonly string[]): void {
  for (const namespace of namespaces) {
    mkdirSync(join(folder, `.${namespace}`, "sessions"), { recursive: true });
    writeFileSync(join(folder, `.${namespace}`, "workline.json"), worklineMarkerContent(namespace));
  }
}

beforeEach(() => {
  // Resolved: on macOS tmpdir() is a symlink, and $HOME must equal the real cwd.
  root = realpathSync(mkdtempSync(join(tmpdir(), "aw-sql-guard-resolution-")));
  home = join(root, "home");
  source = join(root, "app");
  mkdirSync(home);
  mkdirSync(source);
  execFileSync("git", ["init", "-q", "-b", "main", source]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the SQL guard keeps blocking when the hub does not resolve", () => {
  beforeEach(() => configureSqlGuard("workflow"));

  it("in $HOME, which is never a hub though ~/.workflow carries a marker", () => {
    writeFileSync(join(home, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    expectGuarded(home);
  });

  it("in a checkout no hub declares, once the user level carries a marker", () => {
    writeFileSync(join(home, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    expectGuarded(source);
  });

  it("with a --hub that names no hub", () => {
    expectGuarded(source, ["--hub", join(root, "missing")]);
  });

  it("in a folder where two namespaces are marked and none is chosen", () => {
    markNamespaces(source, ["workflow", "other"]);
    expectGuarded(source, [], null);
  });

  it("in a source that two hubs declare", async () => {
    await declaringHub("hub-a");
    await declaringHub("hub-b");
    expectGuarded(source);
  });
});

describe("in a folder where two namespaces are marked, the guard reads the pinned one", () => {
  it("blocks with the config of the namespace `self namespace --pin` chose", () => {
    configureSqlGuard("pinned");
    mkdirSync(join(home, ".config", "agent-workflow"), { recursive: true });
    writeFileSync(join(home, ".config", "agent-workflow", "namespace"), "pinned\n");
    markNamespaces(source, ["workflow", "other"]);
    expectGuarded(source, [], null);
  });
});

describe("a guard that cannot evaluate fails closed", () => {
  function expectFailedClosed(result: ReturnType<typeof sqlGuard>): void {
    expect([result.status, result.stderr]).toEqual([2, expect.stringContaining("guarda SQL")]);
  }

  it("blocks when the user runtime config is not valid JSON", () => {
    mkdirSync(join(home, ".workflow", "agent-workflow"), { recursive: true });
    writeFileSync(join(home, ".workflow", "agent-workflow", "runtime.json"), "{ roto");
    expectFailedClosed(sqlGuard(source, "SELECT 1", [], "workflow"));
  });

  it("blocks when its own arguments are invalid", () => {
    configureSqlGuard("workflow");
    expectFailedClosed(sqlGuard(source, "SELECT 1", ["--format", "bogus"], "workflow"));
  });
});
