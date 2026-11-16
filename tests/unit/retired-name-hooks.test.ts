import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from "../../src/application/self/hooks-toml.js";
import { selfInstallHooks } from "../../src/application/self/install-hooks.js";
import type { CliContext } from "../../src/cli/types.js";
import { isAgentWorkflowTopic } from "../../src/domain/host-memory/topic.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

it("replaces the historical Kimi hook markers with exactly one current block", async () => {
  const home = await mkdtemp(join(tmpdir(), "aw-retired-hooks-"));
  const file = join(home, ".kimi-code", "config.toml");
  const template = join(home, "hooks.json");
  await mkdir(join(home, ".kimi-code"));
  const old =
    '# >>> agent-workflow (Workline) managed hooks — do not edit inside this block >>>\n[[hooks]]\nevent = "Stop"\ncommand = "agent-workflow hook stop"\n# <<< agent-workflow (Workline) managed hooks <<<\n';
  await writeFile(file, `default_model = "example"\n${old}`);
  await writeFile(
    template,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "agent-workflow hook stop", timeout: 5 }] }],
      },
    }),
  );
  const ctx = {
    fs: new NoScanFs(),
    env: new FakeEnv(home, home),
    process: new FakeProcess(),
    paths: new PathsService(normalizeNamespace("workflow"), home, home),
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    },
  } as CliContext;
  const args = {
    rest: ["install-hooks"],
    flags: new Set<string>(),
    values: new Map([
      ["target", "kimi"],
      ["template", template],
    ]),
  };
  expect((await selfInstallHooks(args, ctx)).ok).toBe(true);
  const current = await readFile(file, "utf8");
  expect(current).not.toContain("Workline");
  expect(current.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2);
  expect(current.split(MANAGED_BLOCK_END)).toHaveLength(2);
  expect((parse(current) as { hooks: unknown[] }).hooks).toHaveLength(1);
  expect(current).toContain('default_model = "example"');
  expect((await selfInstallHooks(args, ctx)).data?.status).toBe("noop");
  expect(await readFile(file, "utf8")).toBe(current);
});

it("still identifies historical host memories without rewriting them", () => {
  expect(isAgentWorkflowTopic("Workline conserva la evidencia del checkout", new Set())).toBe(true);
  expect(isAgentWorkflowTopic("agent-workflow conserva la evidencia del checkout", new Set())).toBe(
    true,
  );
  expect(isAgentWorkflowTopic("A unrelated worklineage entry", new Set())).toBe(false);
});
