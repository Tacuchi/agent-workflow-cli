import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDoctorBatch } from "../../src/application/doctor/apply.js";
import { prepareDoctorBatch } from "../../src/application/doctor/prepare.js";
import { pluginsHooksProvider } from "../../src/application/doctor/provider-plugins-hooks.js";
import { runDoctor } from "../../src/application/doctor/report.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  resolveBundledHookTemplate,
  selfInstallHooks,
} from "../../src/application/self/install-hooks.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

/**
 * A hook of ours that runs a command the template no longer has (plan 087, F6):
 * `aw doctor` blocks, `prepare` offers `self.install-hooks` over that host's
 * file, and `apply` leaves the host without the block.
 */

const OLD_TEMPLATE = {
  hooks: {
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "agent-workflow auto-compact-on-close" }],
      },
    ],
    PreCompact: [
      { matcher: "", hooks: [{ type: "command", command: "agent-workflow checkpoint-write" }] },
    ],
    PostCompact: [
      { matcher: "", hooks: [{ type: "command", command: "agent-workflow resume-summary" }] },
    ],
  },
};

const DEPS = { providers: [pluginsHooksProvider] };
const RETIRED = (host: string) => `${host}/plugins-hooks/hooks:comandos-retirados`;

let root: string;
let home: string;
let ctx: CliContext;

function context(): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  return {
    fs: new NoScanFs(),
    env: new FakeEnv(home, join(root, "hub")),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    },
    paths: new PathsService(ns, home, join(root, "hub")),
  } as CliContext;
}

async function install(target: string, template: string): Promise<void> {
  const args: ParsedArgs = {
    rest: ["install-hooks"],
    plugin: {},
    flags: new Set(),
    values: new Map([
      ["target", target],
      ["template", template],
    ]),
    valuesMulti: new Map(),
  };
  const result = await selfInstallHooks(args, ctx);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

async function bundled(): Promise<string> {
  const path = await resolveBundledHookTemplate();
  if (path === null) throw new Error("la plantilla del bundle no se resolvió");
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-retired-hooks-"));
  home = join(root, "home");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".kimi-code"), { recursive: true });
  await mkdir(join(root, "hub"), { recursive: true });
  await writeFile(join(home, ".kimi-code", "config.toml"), 'default_model = "k3"\n');
  ctx = context();
  const old = join(root, "old.json");
  await writeFile(old, JSON.stringify(OLD_TEMPLATE));
  await install("claude", old);
  await install("kimi", old);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("aw doctor bloquea un hook que apunta a un comando retirado", () => {
  it("Claude Code y Kimi con los nombres viejos dan el bloqueo y exit 1", async () => {
    const report = await runDoctor(ctx, {}, DEPS);
    for (const host of ["claude-code", "kimi"]) {
      const finding = report.findings.find((item) => item.id === RETIRED(host));
      expect(finding?.state, host).toBe("blocking");
      expect(finding?.ownership).toBe("ours");
      expect(finding?.evidence.join("\n")).toContain("agent-workflow resume-summary");
      expect(finding?.remediation.kind).toBe("supported");
      expect(finding?.remediation.action?.op).toBe("self.install-hooks");
    }
    expect(report.verdict.exit_code).toBe(1);
  });

  it("prepare los lista como automatizables y sella el archivo de hooks de cada host", async () => {
    const listing = await prepareDoctorBatch(ctx, {}, DEPS);
    if (!listing.ok || listing.kind !== "listing") throw new Error("esperaba un listado");
    const ids = listing.listing.actionable.map((action) => action.finding_id);
    expect(ids).toEqual(expect.arrayContaining([RETIRED("claude-code"), RETIRED("kimi")]));

    const sealed = await prepareDoctorBatch(ctx, { select: [RETIRED("kimi")] }, DEPS);
    if (!sealed.ok || sealed.kind !== "sealed") throw new Error("esperaba una propuesta sellada");
    const read = sealed.proposal.read_set.map((entry) => entry.id);
    expect(read).toContain(join(home, ".kimi-code", "config.toml"));
    expect(read).not.toContain(join(home, ".claude", "settings.json"));
  });

  it("apply reescribe los hooks y el doctor queda sin el bloqueo", async () => {
    const select = [RETIRED("claude-code"), RETIRED("kimi")];
    const sealed = await prepareDoctorBatch(ctx, { select }, DEPS);
    if (!sealed.ok || sealed.kind !== "sealed") throw new Error("esperaba una propuesta sellada");
    const applied = await applyDoctorBatch(ctx, { select, approval: sealed.proposal.digest }, DEPS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejection));
    expect(applied.result.status).toBe("completed");
    const after = await runDoctor(ctx, {}, DEPS);
    expect(after.findings.filter((item) => item.id.endsWith("hooks:comandos-retirados"))).toEqual(
      [],
    );
    expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toContain(
      "agent-workflow hook pre-compact",
    );
  });

  it("una instalación vigente no da ningún hallazgo nuevo", async () => {
    await install("claude", await bundled());
    await install("kimi", await bundled());
    const report = await runDoctor(ctx, {}, DEPS);
    expect(report.findings.filter((item) => item.id.endsWith("hooks:comandos-retirados"))).toEqual(
      [],
    );
  });
});

describe("sólo cuenta lo que vive bajo la clave de hooks de cada host", () => {
  it("la entrada MCP de Workline en crush.json y un hook ajeno de agy no son hooks retirados", async () => {
    const { reportInstalledHookCommands } = await import(
      "../../src/application/self/host-states.js"
    );
    const { crushGlobalMcpFile } = await import("../../src/application/mcp-host-paths.js");
    const crush = crushGlobalMcpFile(home);
    await mkdir(join(crush, ".."), { recursive: true });
    await writeFile(
      crush,
      JSON.stringify({ mcp: { "agent-workflow": { type: "stdio", command: "agent-workflow" } } }),
    );
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      join(home, ".agents", "hooks.json"),
      JSON.stringify({
        mio: { PreToolUse: [{ hooks: [{ command: "agent-workflow checkpoint-write" }] }] },
      }),
    );
    const reports = await reportInstalledHookCommands(ctx);
    expect(reports.find((report) => report.target === "crush")?.commands).toEqual([]);
    expect(reports.find((report) => report.target === "gemini")?.commands).toEqual([]);
  });
});
