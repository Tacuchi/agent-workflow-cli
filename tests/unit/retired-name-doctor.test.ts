import { expect, it } from "vitest";
import { hubBlockProvider } from "../../src/application/doctor/provider-hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

it("reports the retired heading and conflicting markers without deleting or writing", async () => {
  const fs = new MemFs()
    .file("/hub/.workflow/workline.json", '{"workline":1,"model":"sessions"}')
    .file("/hub/.workflow/agent-workflow.json", '{"agent_workflow":1,"model":"documents"}')
    .file(
      "/hub/AGENTS.md",
      "<!-- WORKFLOW-HUB-START -->\n## Hub\n\nEjemplo\n\n## Workline\n\n<!-- WORKFLOW-HUB-END -->\n",
    );
  const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/hub");
  const ctx = { fs, paths, env: new FakeEnv("/hub", "/home/u") } as CliContext;
  const report = await hubBlockProvider.run({
    ctx,
    hubDir: "/hub",
    hosts: [],
    hostStates: [],
    currentHost: null,
    skipNative: true,
  });
  for (const suffix of ["retired-heading", "marker-conflict"]) {
    const finding = report.findings.find((f) => f.id.endsWith(suffix));
    expect(finding).toBeDefined();
    expect(finding?.remediation.guidance.join(" ")).toContain("aw hub-migrate");
  }
  expect(await fs.exists("/hub/.workflow/workline.json")).toBe(true);
  expect(fs.writes.size).toBe(0);
});
