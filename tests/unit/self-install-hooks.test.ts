import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfInstallHooks } from "../../src/application/self/install-hooks.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

const VALID_TEMPLATE = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear",
        hooks: [{ type: "command", command: "agent-workflow hook session-start", timeout: 5 }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: "agent-workflow hook branch-check", timeout: 15 }],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "agent-workflow auto-compact-on-close", timeout: 10 }],
      },
    ],
  },
};

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["install-hooks"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new NoScanFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("selfInstallHooks", () => {
  let workdir: string;
  let home: string;
  let templatePath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-hooks-test-"));
    home = join(workdir, "home");
    templatePath = join(workdir, "hooks.template.json");
    await mkdir(home, { recursive: true });
    await writeFile(templatePath, JSON.stringify(VALID_TEMPLATE), "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("--target required → TARGET_REQUIRED", async () => {
    const result = await selfInstallHooks(buildArgs({ template: templatePath }), buildCtx(home));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TARGET_REQUIRED");
  });

  it("--target invalid → INVALID_TARGET", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "bogus", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_TARGET");
  });

  // Every non-claude target resolves to the explanatory "unsupported" result
  // (warning + null config_path), not a generic INVALID_TARGET — the
  // daily-status documents them as valid hosts.
  it.each(["codex", "warp", "oz", "gemini", "opencode", "crush"])(
    "--target %s → unsupported (not INVALID_TARGET)",
    async (target) => {
      const result = await selfInstallHooks(
        buildArgs({ target, template: templatePath }),
        buildCtx(home),
      );
      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(result.data.status).toBe("unsupported");
        expect(result.data.warning).toContain(target);
        expect(result.data.config_path).toBeNull();
      }
    },
  );

  it("--target claude (no existing settings) → installs all events", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.events_installed).toEqual(
        expect.arrayContaining(["SessionStart", "PreToolUse", "SessionEnd"]),
      );
      expect(result.data.events_already_present).toEqual([]);
      expect(result.data.backup_path).toBeNull();
      expect(result.data.config_path).toBe(join(home, ".claude", "settings.json"));
    }
    const content = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(content.hooks.SessionStart).toBeDefined();
    expect(content.hooks.PreToolUse).toBeDefined();
    expect(content.hooks.SessionEnd).toBeDefined();
  });

  it("--target claude with same hooks → noop (idempotent)", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: VALID_TEMPLATE.hooks }, null, 2),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("noop");
      expect(result.data.events_installed).toEqual([]);
      expect(result.data.events_already_present.length).toBe(3);
    }
  });

  it("--target claude preserves OTHER top-level keys in settings.json", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: ["Bash"], additionalDirectories: ["/extra"] },
          customField: "preserved",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) expect(result.data.status).toBe("installed");

    const after = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(after.permissions.allow).toEqual(["Bash"]);
    expect(after.permissions.additionalDirectories).toEqual(["/extra"]);
    expect(after.customField).toBe("preserved");
    expect(after.hooks.SessionStart).toBeDefined();
  });

  it("--target claude with existing different hooks → backup created", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "old", hooks: [] }] } }, null, 2),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.backup_path).not.toBeNull();
    }
  });

  it("--target claude --dry-run reports plan, does not write", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }, ["--dry-run"]),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.events_installed.length).toBeGreaterThan(0);
    }
    // settings.json should not be created
    let existed = false;
    try {
      await stat(join(home, ".claude", "settings.json"));
      existed = true;
    } catch {
      // expected
    }
    expect(existed).toBe(false);
  });

  it("invalid JSON in settings.json → SETTINGS_INVALID_JSON", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{not valid", "utf8");
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SETTINGS_INVALID_JSON");
  });

  it("missing template → TEMPLATE_NOT_FOUND", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: "/non/existent.json" }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TEMPLATE_NOT_FOUND");
  });

  it("invalid JSON in template → TEMPLATE_INVALID_JSON", async () => {
    const bad = join(workdir, "bad.json");
    await writeFile(bad, "{not valid", "utf8");
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: bad }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TEMPLATE_INVALID_JSON");
  });

  it("template missing 'hooks' key → TEMPLATE_INVALID_SCHEMA", async () => {
    const bad = join(workdir, "bad-schema.json");
    await writeFile(bad, JSON.stringify({ other: {} }), "utf8");
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: bad }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TEMPLATE_INVALID_SCHEMA");
  });
});
