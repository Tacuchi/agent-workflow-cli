import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfDetectHosts } from "../../src/application/self/detect-hosts.js";
import { SKILL_DIR_NAME } from "../../src/application/self/install-skill.js";
import type { CliContext } from "../../src/cli/types.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

/**
 * `which` decides the RUNTIME state; the temp home decides the CONFIG state.
 * Keeping them independent is the whole point of the rewrite: a leftover config
 * dir must not read as a live host, and a host with no config dir of its own
 * (Oz) must still be found through its binary.
 */
function buildCtx(home: string, binsOnPath: readonly string[] = []): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new NoScanFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({
      which: (cmd) => (binsOnPath.includes(cmd) ? `/usr/local/bin/${cmd}` : undefined),
      run: (cmd) => ({ code: 0, stdout: `${cmd} version 1.2.3`, stderr: "" }),
    }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("selfDetectHosts — cuatro estados observables por host", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "self-detect-hosts-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reporta un host por entrada del catálogo, en su orden, y nada más", async () => {
    const result = await selfDetectHosts(buildCtx(home));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) throw new Error("expected data");
    expect(result.data.hosts.map((h) => h.target)).toEqual(HARNESSES.map((h) => h.installTarget));
    // `agents` NO es un host: va en su propia sección.
    expect(result.data.hosts.map((h) => h.target)).not.toContain("agents");
    expect(result.data.shared_destinations.map((d) => d.target)).toEqual(["agents"]);
  });

  it("sin runtime ni config: nada detectado, y los destinos compartidos no suman", async () => {
    const result = await selfDetectHosts(buildCtx(home));
    if (!result.ok || !result.data) throw new Error("expected data");
    expect(result.data.detected_count).toBe(0);
    expect(result.data.installed_count).toBe(0);
    expect(result.data.residual_count).toBe(0);
    expect(result.data.hosts.every((h) => h.status === "absent")).toBe(true);
  });

  it("config presente + runtime ausente = configuración residual, con acción propuesta", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const result = await selfDetectHosts(buildCtx(home)); // ningún binario en PATH
    if (!result.ok || !result.data) throw new Error("expected data");
    const claude = result.data.hosts.find((h) => h.target === "claude");
    expect(claude?.config.present).toBe(true);
    expect(claude?.runtime.state).toBe("missing");
    expect(claude?.status).toBe("residual-config");
    expect(claude?.advice).toMatch(/uninstall --target claude/);
    // Residual NO es "detectado": el host no está.
    expect(result.data.detected_count).toBe(0);
    expect(result.data.residual_count).toBe(1);
  });

  it("runtime disponible + Workline instalado = ready, con la versión sondeada", async () => {
    await mkdir(join(home, ".claude", "skills", SKILL_DIR_NAME), { recursive: true });
    const result = await selfDetectHosts(buildCtx(home, ["claude"]));
    if (!result.ok || !result.data) throw new Error("expected data");
    const claude = result.data.hosts.find((h) => h.target === "claude");
    expect(claude?.runtime.state).toBe("available");
    expect(claude?.runtime.version).toBe("1.2.3");
    expect(claude?.workline.installed).toBe(true);
    expect(claude?.status).toBe("ready");
    expect(claude?.advice).toBeNull();
    expect(result.data.detected_count).toBe(1);
    expect(result.data.installed_count).toBe(1);
  });

  it("oz: sin config dir propio y aun así detectable por su binario (nunca fabrica ~/.oz)", async () => {
    const result = await selfDetectHosts(buildCtx(home, ["oz"]));
    if (!result.ok || !result.data) throw new Error("expected data");
    const oz = result.data.hosts.find((h) => h.target === "oz");
    expect(oz?.config.path).toBeNull();
    expect(oz?.config.reason).toMatch(/Warp/);
    expect(oz?.runtime.state).toBe("available");
    expect(oz?.status).toBe("installable");
  });

  it("warp: sin CLI propio, el runtime no se adivina — su config dir decide", async () => {
    await mkdir(join(home, ".warp"), { recursive: true });
    const result = await selfDetectHosts(buildCtx(home));
    if (!result.ok || !result.data) throw new Error("expected data");
    const warp = result.data.hosts.find((h) => h.target === "warp");
    expect(warp?.runtime.state).toBe("not-probeable");
    expect(warp?.runtime.evidence).toMatch(/no CLI of its own/);
    expect(warp?.status).toBe("installable");
    expect(result.data.detected_count).toBe(1);
  });

  it("kimi: se detecta por la ruta declarada aunque no esté en el PATH", async () => {
    await mkdir(join(home, ".kimi-code", "bin"), { recursive: true });
    // El binario existe en la ruta declarada; `which` no lo ve.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(home, ".kimi-code", "bin", "kimi"), "#!/bin/sh\n", "utf8");
    const result = await selfDetectHosts(buildCtx(home));
    if (!result.ok || !result.data) throw new Error("expected data");
    const kimi = result.data.hosts.find((h) => h.target === "kimi");
    expect(kimi?.runtime.state).toBe("available");
    expect(kimi?.runtime.evidence).toMatch(/declared path/);
  });

  it("el destino compartido se reporta aparte y jamás entra en el conteo de hosts", async () => {
    await mkdir(join(home, ".agents", "skills", SKILL_DIR_NAME), { recursive: true });
    const result = await selfDetectHosts(buildCtx(home));
    if (!result.ok || !result.data) throw new Error("expected data");
    const shared = result.data.shared_destinations[0];
    expect(shared?.installed).toBe(true);
    expect(shared?.note).toMatch(/not a host/);
    expect(shared?.read_by.length).toBeGreaterThan(0);
    expect(result.data.summary).toMatch(/never count as hosts/);
  });

  it("cada host informa solo capacidades que su catálogo respalda", async () => {
    const result = await selfDetectHosts(buildCtx(home));
    if (!result.ok || !result.data) throw new Error("expected data");
    for (const host of result.data.hosts) {
      const ids = host.capabilities.map((c) => c.id).sort();
      expect(ids, host.target).toEqual(["commands", "hooks", "mcp", "skills"]);
      for (const cap of host.capabilities) {
        expect(cap.detail.length, `${host.target}/${cap.id}`).toBeGreaterThan(0);
      }
    }
    // Warp/Oz no tienen sistema de hooks: la superficie lo dice, no lo simula.
    const oz = result.data.hosts.find((h) => h.target === "oz");
    expect(oz?.capabilities.find((c) => c.id === "hooks")?.status).toBe("unsupported");
    // Claude sí: hooks nativos.
    const claude = result.data.hosts.find((h) => h.target === "claude");
    expect(claude?.capabilities.find((c) => c.id === "hooks")?.status).toBe("native");
  });
});
