import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { CAPABILITY_SKILL_MARKER } from "../../src/application/capability/wrapper.js";
import { skillsProvider } from "../../src/application/doctor/provider-skills.js";
import type { DoctorProviderInput, DoctorTargetHost } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

let root: string;
let home: string;
let workspace: string;
let ctx: CliContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-own-skills-"));
  home = join(root, "home");
  workspace = join(root, "workspace");
  mkdirSync(join(home, ".agents"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  ctx = {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, workspace),
    paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
  } as CliContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function host(id: "claude-code" | "codex"): DoctorTargetHost {
  return {
    host: id,
    target: id === "claude-code" ? "claude" : "codex",
    label: id,
    status: "ready",
    current: false,
    runtime: { state: "available", version: null },
    workline_installed: true,
    mcp_host: null,
  };
}
function input(hosts: DoctorTargetHost[]): DoctorProviderInput {
  return {
    ctx,
    hosts,
    hostStates: [],
    currentHost: null,
    workspaceDir: workspace,
    skipNative: false,
  };
}

it("el diagnóstico sólo comprueba la capacidad propia y su wrapper por host, sin inventario ni reparación ajena", async () => {
  const foreign = join(home, ".agents", "skills", "foreign");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: foreign\ndescription: foreign\n---\n");
  const registry = join(home, ".agents", ".skills-registry.json");
  const bytes = '{"skills":{"foreign":{"source":"https://example.test/skill.git"}}}\n';
  writeFileSync(registry, bytes);
  const own = join(home, ".claude", "skills", "design");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "SKILL.md"), CAPABILITY_SKILL_MARKER);
  const output = await skillsProvider.run(input([host("claude-code"), host("codex")]));
  expect(output.findings.map((item) => item.resource.name)).toEqual(["design", "design"]);
  expect(output.findings.map((item) => item.state)).toEqual(["healthy", "warning"]);
  expect(output.findings[1]?.remediation.guidance.join(" ")).toContain("aw self install-skill");
  expect(output.coverage.map((entry) => entry.host)).toEqual(["claude-code", "codex"]);
  expect(JSON.stringify(output)).not.toContain("foreign");
  expect(readFileSync(registry, "utf8")).toBe(bytes);
});

it("sin host participante no escanea registro ni informa skills de terceros", async () => {
  expect(await skillsProvider.run(input([]))).toEqual({ coverage: [], findings: [] });
});

it("un binding antiguo se avisa sin proponer migrar archivos ni acreditar al contribuyente", async () => {
  const config = ctx.paths.userSkillsToml();
  mkdirSync(join(home, ".workflow"), { recursive: true });
  const bytes = '[skills]\ndesign = "vendor/design"\n[docs]\nspecs = "docs/specs"\n';
  writeFileSync(config, bytes);
  const output = await skillsProvider.run(input([host("codex")]));
  const warning = output.findings.find((item) => item.resource.kind === "binding");
  expect(warning?.state).toBe("warning");
  expect(warning?.remediation.action).toBeNull();
  expect(warning?.evidence.join(" ")).toContain("no aplicable");
  expect(output.findings.find((item) => item.resource.kind === "capability")?.state).toBe(
    "warning",
  );
  expect(readFileSync(config, "utf8")).toBe(bytes);
});
