import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { type SelfUpdateDeps, selfUpdate } from "../../src/application/self/update-self.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type {
  ProcessPort,
  RunBinaryResult,
  RunOptions,
  RunResult,
} from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

const PACKAGE = "@tacuchi/agent-workflow-cli";

/** One ustar block per entry, enough for the reader: name, size, type, magic. */
function tarball(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(entries)) {
    const body = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

interface Registry {
  version: string;
  /** null = the tarball does not ship a changelog. */
  changelog: string | null;
  packFails?: boolean;
}

/**
 * Serves `npm pack` from an in-test tarball and records every npm call, in
 * order, next to the notices the update emits.
 */
class RegistryProcess implements ProcessPort {
  public events: string[] = [];
  constructor(private readonly registry: Registry) {}

  async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
    this.events.push(`${cmd} ${args.join(" ")}`);
    if (args[0] !== "pack") return { code: 0, stdout: "ok", stderr: "" };
    if (this.registry.packFails === true) {
      return { code: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };
    }
    const destination = args[args.indexOf("--pack-destination") + 1] ?? "";
    const { version } = this.registry;
    const filename = `tacuchi-agent-workflow-cli-${version}.tgz`;
    const files: Record<string, string> = { "package/package.json": "{}" };
    if (this.registry.changelog !== null) files["package/CHANGELOG.md"] = this.registry.changelog;
    writeFileSync(join(destination, filename), tarball(files));
    return {
      code: 0,
      stdout: JSON.stringify([{ id: `${PACKAGE}@${version}`, version, filename }]),
      stderr: "",
    };
  }
  async runBinary(cmd: string, args: string[], opts?: RunOptions): Promise<RunBinaryResult> {
    const { code, stdout, stderr } = await this.run(cmd, args, opts);
    return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }

  installs(): string[] {
    return this.events.filter((event) => event.startsWith("npm install"));
  }
}

const CHANGELOG_N_TO_N2 = `# Changelog

## [25.9.0] — 2026-10-09

### Contrato

Ninguno.

## [25.8.0] — 2026-10-08

### Contrato

- **Deja de valer:** el estado de corrida v11. **Lo reemplaza:** el estado de corrida v12. **Qué hacer:** cerrá las corridas en vuelo antes de actualizar.

## [25.7.0] — 2026-10-07

### Contrato

Ninguno.
`;

const N_TO_N2: Registry = { version: "25.9.0", changelog: CHANGELOG_N_TO_N2 };

const CHANGELOG_NONE = CHANGELOG_N_TO_N2.replace(/- \*\*Deja de valer:\*\*[^\n]*/, "Ninguno.");
const CHANGELOG_UNDECLARED = CHANGELOG_N_TO_N2.replace(
  /### Contrato\n\n- \*\*Deja de valer:\*\*[^\n]*/,
  "### Fixed\n\n- Algo.",
);

function buildArgs(flags: string[]): ParsedArgs {
  return {
    rest: ["update"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(),
    valuesMulti: new Map(),
  };
}

function buildCtx(process: ProcessPort): CliContext {
  const ns = normalizeNamespace("workflow");
  const paths = new PathsService(ns, "/home/u", "/cwd");
  const runtime: ResolvedRuntime = {
    packageName: PACKAGE,
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: {} as never,
    env: new FakeEnv("/home/u", "/cwd"),
    process,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

/** Installed 25.7.0 (it already carries the notice), 25.9.0 published. */
function scenario(registry: Registry) {
  const proc = new RegistryProcess(registry);
  const notices: string[] = [];
  const deps: SelfUpdateDeps = {
    installedVersion: () => "25.7.0",
    notify: (text) => {
      notices.push(text);
      proc.events.push("notice");
    },
  };
  return { proc, notices, deps, ctx: buildCtx(proc) };
}

function withFakeTty<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  return fn().finally(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: original });
  });
}

describe("selfUpdate — the contract notice before installing (AC-03)", () => {
  it("N → N+2 shows N+1's change, what stops and what to do, before npm install runs", async () => {
    const { proc, notices, deps, ctx } = scenario(N_TO_N2);
    const result = await selfUpdate(buildArgs([]), ctx, undefined, deps);

    expect(proc.events.indexOf("notice")).toBeLessThan(
      proc.events.findIndex((event) => event.startsWith("npm install")),
    );
    expect(notices[0]).toContain("25.8.0");
    expect(notices[0]).toContain("Deja de valer: el estado de corrida v11.");
    expect(notices[0]).toContain("Qué hacer: cerrá las corridas en vuelo antes de actualizar.");
    expect(notices[0]).not.toContain("- 25.9.0");
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.contract_changes).toMatchObject({
      status: "read",
      installed: "25.7.0",
      target: "25.9.0",
      versions: [
        { version: "25.8.0", state: "changes" },
        { version: "25.9.0", state: "none" },
      ],
    });
  });

  it("says so when no version in the range changes a contract", async () => {
    const { notices, deps, ctx } = scenario({ version: "25.9.0", changelog: CHANGELOG_NONE });
    await selfUpdate(buildArgs([]), ctx, undefined, deps);
    expect(notices[0]).toContain("Ninguna versión declara cambios de contrato.");
  });

  it("names a version without its section as undeclared, never as unchanged", async () => {
    const { notices, deps, ctx } = scenario({ version: "25.9.0", changelog: CHANGELOG_UNDECLARED });
    await selfUpdate(buildArgs([]), ctx, undefined, deps);
    expect(notices[0]).toContain("- 25.8.0: sin declarar; no se sabe si cambia algún contrato.");
    expect(notices[0]).not.toContain("Ninguna versión declara cambios de contrato.");
  });

  it("declares a failed npm pack with its reason and still leaves the update to the person", async () => {
    const { proc, notices, deps, ctx } = scenario({ ...N_TO_N2, changelog: null, packFails: true });
    const result = await selfUpdate(buildArgs([]), ctx, undefined, deps);
    expect(notices[0]).toContain("hacia la versión de destino: no se pudieron determinar");
    expect(notices[0]).toContain("E404");
    expect(notices[0]).toContain("Eso no significa que no haya cambios de contrato.");
    expect(notices[0]).not.toContain("Ninguna versión");
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.contract_changes?.status).toBe("unavailable");
    expect(result.data.target_version).toBeNull();
    expect(proc.installs()).toEqual([`npm install -g ${PACKAGE}@latest`]);
  });

  it("declares a tarball without CHANGELOG.md and installs the version npm named", async () => {
    const { proc, notices, deps, ctx } = scenario({ version: "25.9.0", changelog: null });
    await selfUpdate(buildArgs([]), ctx, undefined, deps);
    expect(notices[0]).toContain(
      "hacia 25.9.0: no se pudieron determinar (el paquete no trae CHANGELOG.md)",
    );
    expect(proc.installs()).toEqual([`npm install -g ${PACKAGE}@25.9.0`]);
  });

  it("installs exactly the version the notice named, not @latest", async () => {
    const { proc, deps, ctx } = scenario(N_TO_N2);
    const result = await selfUpdate(buildArgs([]), ctx, undefined, deps);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.target_version).toBe("25.9.0");
    expect(proc.installs()).toEqual([`npm install -g ${PACKAGE}@25.9.0`]);
    expect(result.data.command).toBe(`npm install -g ${PACKAGE}@25.9.0`);
  });
});

describe("selfUpdate — --dry-run (H-05)", () => {
  it("shows the notice and does NOT install", async () => {
    const { proc, notices, deps, ctx } = scenario(N_TO_N2);
    const result = await selfUpdate(buildArgs(["--dry-run"]), ctx, undefined, deps);
    expect(proc.installs()).toEqual([]);
    expect(notices[0]).toContain("25.8.0");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.would_run).toBe(true);
      expect(result.data.command).toBe(`npm install -g ${PACKAGE}@25.9.0`);
      expect(result.data.exit_code).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(result.data.contract_changes?.status).toBe("read");
    }
  });
});

describe("selfUpdate — confirm (TTY)", () => {
  it("shows the notice inside the confirmation, before installing", async () => {
    const { proc, notices, deps, ctx } = scenario(N_TO_N2);
    const confirm = vi.fn(async (message: string) => {
      proc.events.push("confirm");
      return message.includes("Deja de valer: el estado de corrida v11.");
    });
    await withFakeTty(() => selfUpdate(buildArgs([]), ctx, confirm, deps));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    expect(proc.events.slice(-2)).toEqual(["confirm", `npm install -g ${PACKAGE}@25.9.0`]);
  });

  it("Ctrl-C / Esc en el confirm (rechaza la promise) cae como cancelled, no UNHANDLED", async () => {
    const { proc, deps, ctx } = scenario(N_TO_N2);
    const result = await withFakeTty(() =>
      selfUpdate(
        buildArgs([]),
        ctx,
        async () => {
          throw new Error("User force closed the prompt with 0 null");
        },
        deps,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.command).toBe("(cancelled)");
      expect(result.data.exit_code).toBe(0);
      expect(result.exitCode).toBe(0);
    }
    expect(proc.installs()).toEqual([]);
  });

  it("'no' explícito en el confirm también devuelve cancelled", async () => {
    const { proc, deps, ctx } = scenario(N_TO_N2);
    const result = await withFakeTty(() => selfUpdate(buildArgs([]), ctx, async () => false, deps));
    if (result.ok) expect(result.data.command).toBe("(cancelled)");
    expect(proc.installs()).toEqual([]);
  });

  it("--yes salta el confirm aunque haya TTY, y el aviso sale igual antes de instalar", async () => {
    const { proc, deps, ctx } = scenario(N_TO_N2);
    const confirmSpy = vi.fn();
    await withFakeTty(() => selfUpdate(buildArgs(["--yes"]), ctx, confirmSpy, deps));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(proc.events.slice(-2)).toEqual(["notice", `npm install -g ${PACKAGE}@25.9.0`]);
  });

  it("-y también salta el confirm", async () => {
    const { proc, deps, ctx } = scenario(N_TO_N2);
    const confirmSpy = vi.fn();
    await withFakeTty(() => selfUpdate(buildArgs(["-y"]), ctx, confirmSpy, deps));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(proc.installs()).toHaveLength(1);
  });
});
