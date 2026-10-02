import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHubsStatus } from "../../src/application/hubs-status-service.js";
import { hubsCommand } from "../../src/cli/commands/hubs.js";
import { statusNotices } from "../../src/cli/commands/status.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { FakeEnv } from "../helpers/fake-env.js";

/** `aw hubs status` over a registry with one hub of each state (plan 088 F3). */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-hubs-status-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".workflow"), { recursive: true });
  const hub = (name: string) => {
    const path = join(root, name);
    mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(path, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    return path;
  };
  const healthy = hub("sano");
  mkdirSync(join(healthy, "docs", "specs"), { recursive: true });
  writeFileSync(
    join(healthy, "docs", "specs", "001-spec-correo.md"),
    "---\nstatus: draft\n---\n# Spec 001 — correo\n",
  );
  const unreadable = hub("ilegible");
  const unmarked = join(root, "sin-marcador");
  mkdirSync(unmarked);
  const gone = join(root, "borrado");
  const registry = join(home, ".workflow", "hubs.json");
  writeFileSync(
    registry,
    JSON.stringify({ version: 1, roots: [healthy, gone, unmarked, unreadable] }),
  );
  return { home, healthy, gone, unmarked, unreadable, registry };
}

/** Reads of one hub fail past its marker, as a hub whose files cannot be read. */
function failingUnder(root: string): FileSystemPort {
  const real = new NodeFileSystem();
  return new Proxy(real, {
    get(target, name, receiver) {
      const member = Reflect.get(target, name, receiver);
      if (typeof member !== "function" || name === "stat" || name === "exists") return member;
      return (path: unknown, ...rest: unknown[]) => {
        if (typeof path === "string" && path.startsWith(root)) throw new Error(`EACCES: ${path}`);
        return member.call(target, path, ...rest);
      };
    },
  });
}

describe("aw hubs status", () => {
  it("da el estado compacto del hub sano y sólo la razón de los demás, sin escribir", async () => {
    const { home, healthy, gone, unmarked, registry } = fixture();
    const before = readFileSync(registry, "utf8");
    const out = await runHubsStatus(
      { fs: new NodeFileSystem(), env: new FakeEnv(home, home) },
      "workflow",
      (board) => statusNotices(board).length,
    );
    const [sano, borrado, sinMarcador] = out.hubs;
    expect(sano).toMatchObject({ name: "sano", root: healthy, ok: true, pending: 1 });
    expect(sano).toHaveProperty("next");
    expect(Object.keys(sano ?? {}).sort()).toEqual(
      ["last_activity", "name", "next", "notices", "ok", "pending", "root"].sort(),
    );
    expect(borrado).toEqual({ name: "borrado", root: gone, ok: false, reason: "missing" });
    expect(sinMarcador).toEqual({
      name: "sin-marcador",
      root: unmarked,
      ok: false,
      reason: "not-a-hub",
    });
    expect(out.counts).toMatchObject({ hubs: 4, pending: 1 });
    expect(readFileSync(registry, "utf8")).toBe(before);
  });

  it("un hub ilegible queda ok:false con reason y no corta a los demás", async () => {
    const { home, unreadable } = fixture();
    mkdirSync(join(unreadable, "docs", "specs"), { recursive: true });
    const out = await runHubsStatus(
      { fs: failingUnder(unreadable), env: new FakeEnv(home, home) },
      "workflow",
      (board) => statusNotices(board).length,
    );
    expect(out.hubs.at(-1)).toEqual({
      name: "ilegible",
      root: unreadable,
      ok: false,
      reason: "unreadable",
    });
    expect(out.hubs[0]).toMatchObject({ name: "sano", ok: true });
  });

  it("la vista humana da una línea por hub", async () => {
    const { home } = fixture();
    const data = await runHubsStatus(
      { fs: new NodeFileSystem(), env: new FakeEnv(home, home) },
      "workflow",
      (board) => statusNotices(board).length,
    );
    const text =
      hubsCommand.renderHuman?.(
        { ok: true, data: { action: "status", ...data }, exitCode: 0 },
        { detail: false },
      ) ?? "";
    expect(text.trimEnd().split("\n")).toHaveLength(4);
    expect(text).toMatch(/^sano {2}1 pendientes · 0 avisos · /m);
    expect(text).toMatch(/^borrado {2}missing /m);
  });
});
