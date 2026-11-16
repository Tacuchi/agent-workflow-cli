import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";
import {
  OUTSIDE_HUB_TEXT,
  insideHub,
  shouldShowInteractiveMenu,
} from "../../src/cli/interactive-menu.js";
import { agentWorkflowMarkerContent } from "../../src/runtime/agent-workflow-marker.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("shouldShowInteractiveMenu", () => {
  it("true when no command + TTY + no help flag", () => {
    expect(shouldShowInteractiveMenu({ command: undefined, isTTY: true, hasHelp: false })).toBe(
      true,
    );
  });
  it("false when command provided", () => {
    expect(shouldShowInteractiveMenu({ command: "sessions", isTTY: true, hasHelp: false })).toBe(
      false,
    );
  });
  it("false when --help flag", () => {
    expect(shouldShowInteractiveMenu({ command: undefined, isTTY: true, hasHelp: true })).toBe(
      false,
    );
  });
  it("false when not TTY", () => {
    expect(shouldShowInteractiveMenu({ command: undefined, isTTY: false, hasHelp: false })).toBe(
      false,
    );
  });
});

describe("aw sin argumentos fuera de un hub", () => {
  let home: string;
  let dir: string;
  const fs = new NodeFileSystem();
  const pathsAt = (root: string) =>
    new PathsService(normalizeNamespace("agent-workflow"), home, root);

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "aw-menu-home-")));
    dir = join(home, "trabajo");
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("el texto nombra aw hub-init y no ofrece formulario", () => {
    expect(OUTSIDE_HUB_TEXT).toContain("aw hub-init");
    expect(OUTSIDE_HUB_TEXT.trim().split("\n")).toHaveLength(1);
  });

  it("una carpeta sin marcador ni bloque no es un hub, y $HOME nunca lo es", async () => {
    expect(await insideHub({ fs, paths: pathsAt(dir) })).toBe(false);
    expect(await insideHub({ fs, paths: pathsAt(home) })).toBe(false);
  });

  it("el marcador o el bloque del hub en AGENTS.md abren la TUI", async () => {
    const marked = join(dir, "marcado");
    await mkdir(join(marked, ".agent-workflow"), { recursive: true });
    await writeFile(
      join(marked, ".agent-workflow", "agent-workflow.json"),
      agentWorkflowMarkerContent("agent-workflow"),
    );
    expect(await insideHub({ fs, paths: pathsAt(marked) })).toBe(true);

    const paths = pathsAt(dir);
    const block = renderHubBlock({
      proyecto: "Hub",
      fuentes: [],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      markers: paths.blockMarkers(),
    });
    await writeFile(join(dir, "AGENTS.md"), block, "utf8");
    expect(await insideHub({ fs, paths })).toBe(true);
  });
});
