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

    it("npm with only a build script and no entry (bin/main) → not launchable", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.command).toBeNull();
      expect(d.build).toBeNull();
    });

    it("npm with a serve script → npm run serve", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ scripts: { serve: "http-server" } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.args).toEqual(["run", "serve"]);
      expect(d.build).toBeNull();
      expect(d.mode).toBe("server"); // a (dev) server → background + log
    });

    it("npm CLI (object bin) with a build script → build first, then node <first entry>", async () => {
      const dir = source("cli", {
        "package.json": JSON.stringify({
          bin: { mytool: "dist/main.js", mt: "dist/main.js" },
          scripts: { build: "tsc" },
        }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "cli");
      expect(d.command).toBe("node");
      expect(d.args).toEqual(["dist/main.js"]);
      expect(d.build).toEqual({ command: "npm", args: ["run", "build"] });
      expect(d.mode).toBe("interactive"); // a CLI/app entry owns the terminal
    });

    it("npm CLI with a string bin and no build script → node <bin>, no build", async () => {
      const dir = source("cli", { "package.json": JSON.stringify({ bin: "cli.js" }) });
      const d = await detectLaunchDescriptor(fs, dir, "cli");
      expect(d.command).toBe("node");
      expect(d.args).toEqual(["cli.js"]);
      expect(d.build).toBeNull();
    });

    it("npm with a main entry + build script (no bin) → build then node <main>", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ main: "dist/index.js", scripts: { build: "tsc" } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.command).toBe("node");
      expect(d.args).toEqual(["dist/index.js"]);
      expect(d.build).toEqual({ command: "npm", args: ["run", "build"] });
    });

    it("a run script wins over bin (dev server is self-contained → no build step)", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ bin: "cli.js", scripts: { dev: "vite", build: "tsc" } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "app");
      expect(d.args).toEqual(["run", "dev"]);
      expect(d.build).toBeNull();
      expect(d.mode).toBe("server");
    });

    it("--mode override forces the launch mode over the heuristic", async () => {
      const dir = source("app", {
        "package.json": JSON.stringify({ scripts: { dev: "vite" } }), // heuristic → server
      });
      const d = await detectLaunchDescriptor(fs, dir, "app", { mode: "interactive" });
      expect(d.mode).toBe("interactive");
      expect(d.args).toEqual(["run", "dev"]); // command unchanged
    });

    it("--command override replaces command+args and drops the auto build", async () => {
      const dir = source("cli", {
        "package.json": JSON.stringify({ bin: "dist/main.js", scripts: { build: "tsc" } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "cli", { command: "node dist/cli/main.js" });
      expect(d.command).toBe("node");
      expect(d.args).toEqual(["dist/cli/main.js"]);
      expect(d.build).toBeNull(); // custom command is self-contained
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

    it("run.sh runs the build step before exec when the descriptor has one", async () => {
      const dir = source("cli", {
        "package.json": JSON.stringify({ bin: "dist/main.js", scripts: { build: "tsc" } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "cli");
      const sh = renderRunSh(d);
      expect(sh).toContain("npm run build");
      expect(sh).toContain("exec node dist/main.js");
      expect(sh.indexOf("npm run build")).toBeLessThan(sh.indexOf("exec node"));
    });

    it("run.ps1 runs the build step (with an exit-code guard) before the launch", async () => {
      const { renderRunPs1 } = await import(
        "../../src/application/source-launch-scripts-service.js"
      );
      const dir = source("cli", {
        "package.json": JSON.stringify({ bin: "dist/main.js", scripts: { build: "tsc" } }),
      });
      const d = await detectLaunchDescriptor(fs, dir, "cli");
      const ps1 = renderRunPs1(d);
      expect(ps1).toContain("& npm run build");
      expect(ps1).toContain("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
      expect(ps1.indexOf("npm run build")).toBeLessThan(ps1.indexOf("& node dist/main.js"));
    });
  });

  describe("Windows command form", () => {
    // Regression: the descriptor carried the bash wrapper (./gradlew) into
    // run.ps1 and the win32 terminal spawn, where PowerShell can't run it —
    // the whole gradle/maven family failed to launch on Windows.
    it("winLaunchCommand maps the JVM wrappers to their .bat/.cmd twins", async () => {
      const { winLaunchCommand } = await import(
        "../../src/application/source-launch-scripts-service.js"
      );
      expect(winLaunchCommand("./gradlew")).toBe("./gradlew.bat");
      expect(winLaunchCommand("./mvnw")).toBe("./mvnw.cmd");
      expect(winLaunchCommand("npm")).toBe("npm");
      expect(winLaunchCommand(null)).toBeNull();
    });

    it("run.ps1 invokes the .bat wrapper while run.sh keeps the bash one", async () => {
      const { renderRunPs1 } = await import(
        "../../src/application/source-launch-scripts-service.js"
      );
      const dir = source("svc", { "build.gradle.kts": "", gradlew: "#!/bin/sh\n" });
      const d = await detectLaunchDescriptor(fs, dir, "svc");
      expect(renderRunSh(d)).toContain("exec ./gradlew bootRun");
      expect(renderRunPs1(d)).toContain("& ./gradlew.bat bootRun");
    });
  });

  describe("generateSourceLaunchArtifacts (idempotency)", () => {
    it("first run creates, second run regenerates pristine files", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");

      const first = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");
      expect(first.outcomes).toEqual({
        launchJson: "created",
        runSh: "created",
        runPs1: "created",
      });
      expect(first.launchable).toBe(true);

      const second = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");
      expect(second.outcomes).toEqual({
        launchJson: "regenerated",
        runSh: "regenerated",
        runPs1: "regenerated",
      });
    });

    it("preserves a user-edited run.sh (hash mismatch) but regenerates the rest", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");
      await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");

      const runShPath = join(launchDir, "app", "run.sh");
      const edited = `${readFileSync(runShPath, "utf-8")}\n# my custom tweak\n`;
      writeFileSync(runShPath, edited);

      const out = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");
      expect(out.outcomes.runSh).toBe("preserved");
      expect(out.outcomes.launchJson).toBe("regenerated");
      expect(readFileSync(runShPath, "utf-8")).toBe(edited); // untouched
    });

    it("a file without a marker is treated as user-owned and preserved", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");
      const appLaunch = join(launchDir, "app");
      mkdirSync(appLaunch, { recursive: true });
      writeFileSync(join(appLaunch, "run.sh"), "#!/bin/sh\necho hand-written\n");

      const out = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");
      expect(out.outcomes.runSh).toBe("preserved");
      expect(readFileSync(join(appLaunch, "run.sh"), "utf-8")).toContain("hand-written");
    });
  });

  describe("generateSourceLaunchArtifacts (dry-run + force)", () => {
    it("dry-run classifies as created but writes nothing to disk", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");

      const out = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app", { dryRun: true });
      expect(out.outcomes).toEqual({
        launchJson: "created",
        runSh: "created",
        runPs1: "created",
      });
      expect(await fs.exists(join(launchDir, "app"))).toBe(false);
    });

    it("dry-run over a user-edited file reports preserved and leaves it untouched", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");
      await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");
      const runShPath = join(launchDir, "app", "run.sh");
      const edited = `${readFileSync(runShPath, "utf-8")}\n# tweak\n`;
      writeFileSync(runShPath, edited);

      const out = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app", { dryRun: true });
      expect(out.outcomes.runSh).toBe("preserved");
      expect(out.outcomes.launchJson).toBe("regenerated");
      expect(readFileSync(runShPath, "utf-8")).toBe(edited);
    });

    it("force overwrites a user-edited file (reported overwritten)", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");
      await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");
      const runShPath = join(launchDir, "app", "run.sh");
      writeFileSync(runShPath, `${readFileSync(runShPath, "utf-8")}\n# tweak\n`);

      const out = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app", { force: true });
      expect(out.outcomes.runSh).toBe("overwritten");
      expect(readFileSync(runShPath, "utf-8")).not.toContain("# tweak"); // clobbered
    });

    it("force on a pristine file still reports regenerated (nothing to clobber)", async () => {
      const dir = source("app", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
      const launchDir = join(root, "ws", ".workflow", "launch");
      await generateSourceLaunchArtifacts(fs, launchDir, dir, "app");

      const out = await generateSourceLaunchArtifacts(fs, launchDir, dir, "app", { force: true });
      expect(out.outcomes).toEqual({
        launchJson: "regenerated",
        runSh: "regenerated",
        runPs1: "regenerated",
      });
    });
  });
});
