import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  detectLaunchDescriptor,
  generateSourceLaunchArtifacts,
  renderLaunchJson,
  renderRunSh,
} from "../../src/application/source-launch-scripts-service.js";

describe("source-launch-scripts-service", () => {
  let root: string;
  let fs: NodeFileSystem;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "launch-scripts-"));
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function source(name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  describe("detectLaunchDescriptor", () => {
    it("npm with a dev script → npm run dev", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ scripts: { dev: "vite", start: "node ." } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.stack).toBe("npm");
      expect(d.command).toBe("npm");
      expect(d.args).toEqual(["run", "dev"]);
    });

    it("npm with only start → npm start", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ scripts: { start: "node ." } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.args).toEqual(["start"]);
    });

    it("npm without dev/start → no command (not launchable)", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.command).toBeNull();
    });

    it("gradle with wrapper → ./gradlew bootRun", async () => {
      const dir = source("svc", { "build.gradle.kts": "", gradlew: "#!/bin/sh\n" });
      const d = await detectLaunchDescriptor(fs, dir, "svc");
      expect(d.stack).toBe("gradle");
      expect(d.command).toBe("./gradlew");
      expect(d.args).toEqual(["bootRun"]);
    });

    it("unknown stack → no command", async () => {
      const dir = source("misc", { "README.md": "# hi" });
      const d = await detectLaunchDescriptor(fs, dir, "misc");
      expect(d.stack).toBe("unknown");
      expect(d.command).toBeNull();
    });

    it("parses .env params (masking secrets) and .env.<profile> profiles", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
        ".env": "PORT=3000\nAPI_TOKEN=supersecret\n# comment\nNODE_ENV=development\n",
        ".env.dev": "PORT=3001\n",
        ".env.prod": "PORT=80\n",
        ".env.local": "PORT=9999\n",
      });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      const byName = Object.fromEntries(d.params.map((p) => [p.name, p]));
      expect(byName.PORT).toMatchObject({ default: "3000", secret: false });
      expect(byName.API_TOKEN).toMatchObject({ default: "", secret: true });
      expect(byName.NODE_ENV).toMatchObject({ default: "development", secret: false });
      // profiles from .env.dev/.env.prod; .env.local excluded
      expect(d.profiles).toEqual(["dev", "prod"]);
    });
  });

  describe("rendering", () => {
    it("launch.json carries a _generated.sha256 marker", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      const json = JSON.parse(renderLaunchJson(d));
      expect(json._generated.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(json.command).toBe("npm");
    });

    it("run.sh starts with a shebang then the hash marker", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      const sh = renderRunSh(d);
      const lines = sh.split("\n");
      expect(lines[0]).toBe("#!/usr/bin/env bash");
      expect(lines[1]).toMatch(/^# agent-workflow:generated v1 sha256=[a-f0-9]{64}$/);
      expect(sh).toContain("exec npm run dev");
    });
  });

  describe("generateSourceLaunchArtifacts (idempotency)", () => {
    it("first run creates, second run regenerates pristine files", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const toolsDir = join(root, "ws", "docs", "tools");

      const first = await generateSourceLaunchArtifacts(fs, toolsDir, dir, "app");
      expect(first.outcomes).toEqual({
        launchJson: "created",
        runSh: "created",
        runPs1: "created",
      });
      expect(first.launchable).toBe(true);

      const second = await generateSourceLaunchArtifacts(fs, toolsDir, dir, "app");
      expect(second.outcomes).toEqual({
        launchJson: "regenerated",
        runSh: "regenerated",
        runPs1: "regenerated",
      });
    });

    it("preserves a user-edited run.sh (hash mismatch) but regenerates the rest", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const toolsDir = join(root, "ws", "docs", "tools");
      await generateSourceLaunchArtifacts(fs, toolsDir, dir, "app");

      const runShPath = join(toolsDir, "app", "run.sh");
      const edited = `${readFileSync(runShPath, "utf-8")}\n# my custom tweak\n`;
      writeFileSync(runShPath, edited);

      const out = await generateSourceLaunchArtifacts(fs, toolsDir, dir, "app");
      expect(out.outcomes.runSh).toBe("preserved");
      expect(out.outcomes.launchJson).toBe("regenerated");
      expect(readFileSync(runShPath, "utf-8")).toBe(edited); // untouched
    });

    it("a file without a marker is treated as user-owned and preserved", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const toolsDir = join(root, "ws", "docs", "tools");
      const appTools = join(toolsDir, "app");
      mkdirSync(appTools, { recursive: true });
      writeFileSync(join(appTools, "run.sh"), "#!/bin/sh\necho hand-written\n");

      const out = await generateSourceLaunchArtifacts(fs, toolsDir, dir, "app");
      expect(out.outcomes.runSh).toBe("preserved");
      expect(readFileSync(join(appTools, "run.sh"), "utf-8")).toContain("hand-written");
    });
  });
});
