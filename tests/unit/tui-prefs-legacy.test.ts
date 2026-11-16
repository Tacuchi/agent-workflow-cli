import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { App } from "../../src/cli/tui/app.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";

it("un tui-prefs.json viejo que abre en MCP con otro acento no cambia la pantalla y queda intacto", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "tui-prefs-legacy-")));
  try {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), home, home);
    const file = join(paths.userLibConfigDir(), "tui-prefs.json");
    const old = '{"initialScreen":"mcp","accentColor":"red","disabledHosts":["codex"]}\n';
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, old);
    const ctx = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, home),
      git: new RecordingGit(),
      paths,
      process: { run: async () => ({ code: 0, stdout: "{}", stderr: "" }) },
      runtime: { binName: "aw", packageName: "@scope/cli" },
    } as unknown as CliContext;

    const { lastFrame } = render(createElement(App, { version: "1.0.0", ctx, onResult: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("PENDIENTES");
    expect(frame).toContain("FUENTES");
    expect(frame).not.toMatch(/MCP|error/i);
    expect(await readFile(file, "utf8")).toBe(old);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
