#!/usr/bin/env node
// Reproducible per-level host validation.
//
// For every host in the catalog it probes the RUNTIME (binary reachable, version
// readable). For every OFFICIAL host it additionally verifies the INSTALLATION:
// it installs into a throwaway HOME and checks that the artifacts on disk are
// exactly the ones the catalog promises — bundle, command surface, hooks — then
// uninstalls and checks they are gone.
//
// The result is written to `src/domain/host-verification.ts`. That file is the
// ONLY place a "verified on <date> against <version>" claim comes from, and only
// this script writes it: no surface can assert a verification that no run backs.
//
// Usage:  npm run smoke:hosts            (verify + write the ledger)
//         npm run smoke:hosts -- --check (verify only; fail on drift, write nothing)
//
// Scope: macOS is where the runtimes live and where this is expected to pass.
// Windows stays best-effort on the existing launch smokes; Linux is documented
// without a guarantee.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli", "main.js");
const LEDGER = join(ROOT, "src", "domain", "host-verification.ts");
const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(CLI)) {
  console.error(`dist not built: ${CLI} is missing. Run 'npm run build' first.`);
  process.exit(1);
}

const { HARNESSES } = await import(join(ROOT, "dist", "domain", "harnesses.js"));
const { TARGET_ROOTS, COMMAND_SKILLS_HOSTS, HOOKS_MANAGED_TARGETS } = await import(
  join(ROOT, "dist", "application", "self", "install-targets.js")
);
const { USER_COMMANDS_BY_TARGET } = await import(
  join(ROOT, "dist", "application", "self", "install-skill.js")
);

const today = new Date().toISOString().slice(0, 10);
const results = [];
let failures = 0;

function expandHome(p, home) {
  return p.startsWith("~") ? join(home, p.slice(1)) : p;
}

/** Is the runtime reachable, and what version does it report? */
function probeRuntime(spec) {
  const { bins, fallbackBinPaths = [], versionArgs } = spec.runtime;
  if (bins.length === 0) {
    return { state: "not-probeable", bin: null, version: null };
  }
  const home = process.env.HOME ?? "";
  let bin = null;
  for (const candidate of bins) {
    const which = spawnSync("command", ["-v", candidate], { shell: true, encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim().length > 0) {
      bin = which.stdout.trim().split("\n")[0];
      break;
    }
  }
  if (bin === null) {
    for (const candidate of fallbackBinPaths) {
      const abs = expandHome(candidate, home);
      if (existsSync(abs)) {
        bin = abs;
        break;
      }
    }
  }
  if (bin === null) return { state: "missing", bin: null, version: null };
  const run = spawnSync(bin, versionArgs, { encoding: "utf8", timeout: 15000 });
  const version = /\d+\.\d+[\w.\-+]*/.exec(`${run.stdout}\n${run.stderr}`)?.[0] ?? null;
  return { state: "available", bin, version };
}

function runCli(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 120000,
  });
}

/**
 * What the catalog promises this host, as three independent observations. The
 * SAME three are checked after install (all must be present) and after uninstall
 * (all must be gone) — checking only the bundle on the way out would let a
 * regression that strands hooks or wrappers pass green.
 */
function observeArtifacts(spec, home) {
  const target = spec.installTarget;
  const skillsRoot = join(home, ...TARGET_ROOTS[target]);
  const bundle = join(skillsRoot, "w");

  const observations = [
    { what: `bundle ${bundle}/SKILL.md`, present: existsSync(join(bundle, "SKILL.md")) },
  ];

  const nativeCommands = USER_COMMANDS_BY_TARGET[target];
  if (nativeCommands !== null) {
    const dir = join(home, ...nativeCommands.relpath.split("/"));
    observations.push({
      what: `command wrappers in ${dir}`,
      present: existsSync(dir) && readdirSync(dir).length > 0,
    });
  }
  if (COMMAND_SKILLS_HOSTS.has(target)) {
    observations.push({
      what: `synthesized 'w-<command>' skills under ${skillsRoot}`,
      present: existsSync(skillsRoot) && readdirSync(skillsRoot).some((d) => d.startsWith("w-")),
    });
  }
  if (HOOKS_MANAGED_TARGETS.has(target)) {
    const configs = [
      join(home, ".claude", "settings.json"),
      join(home, ".kimi-code", "config.toml"),
    ].filter(existsSync);
    observations.push({
      what: `hooks armed for ${target}`,
      present: configs.some((f) => readFileSync(f, "utf8").includes("agent-workflow")),
    });
  }
  return observations;
}

function verifyInstall(spec) {
  const target = spec.installTarget;
  const home = mkdtempSync(join(tmpdir(), `aw-smoke-${target}-`));
  const problems = [];
  try {
    const install = runCli(["self", "install", "--target", target, "--force"], home);
    if (install.status !== 0) {
      problems.push(`install exited ${install.status}: ${install.stderr.trim().slice(0, 300)}`);
      return problems;
    }
    for (const o of observeArtifacts(spec, home)) {
      if (!o.present) problems.push(`promised but missing after install: ${o.what}`);
    }

    const uninstall = runCli(
      ["self", "uninstall", "--target", target, "--with-hooks", "--legacy"],
      home,
    );
    if (uninstall.status !== 0) {
      problems.push(`uninstall exited ${uninstall.status}`);
      return problems;
    }
    for (const o of observeArtifacts(spec, home)) {
      if (o.present) problems.push(`left behind after uninstall: ${o.what}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return problems;
}

for (const spec of HARNESSES) {
  const runtime = probeRuntime(spec);
  const official = spec.support.tier === "official";
  const line = `${spec.id.padEnd(12)} ${spec.support.tier.padEnd(11)} runtime=${runtime.state.padEnd(14)} v=${runtime.version ?? "—"}`;

  if (!official) {
    // best-effort: the runtime is recorded, its installation is not gated.
    console.log(`  ·  ${line}  (best-effort: install not gated)`);
    if (runtime.state === "available") {
      results.push({ id: spec.id, version: runtime.version, at: today, depth: "invocation" });
    }
    continue;
  }

  if (runtime.state === "missing") {
    console.log(`  ✗  ${line}  → official host with no runtime on this machine`);
    failures += 1;
    continue;
  }

  const problems = verifyInstall(spec);
  if (problems.length > 0) {
    console.log(`  ✗  ${line}`);
    for (const p of problems) console.log(`        ${p}`);
    failures += 1;
    continue;
  }
  console.log(`  ✓  ${line}  install + uninstall verified`);
  results.push({ id: spec.id, version: runtime.version, at: today, depth: "install" });
}

const officials = HARNESSES.filter((h) => h.support.tier === "official").length;
const verified = results.filter((r) => r.depth === "install").length;
console.log(`\n${verified}/${officials} official hosts verified on ${process.platform}.`);

if (CHECK_ONLY) {
  process.exit(failures > 0 ? 1 : 0);
}

const body = `// VERIFICATION LEDGER — written by \`npm run smoke:hosts\`, never by hand.
//
// It is deliberately a separate module from the catalog: \`harnesses.ts\` is
// hand-authored (ids, dirs, tiers — what we DECIDE), this file records what a
// run actually PROVED. Keeping the two apart is what lets every projection say
// "verified against X on date Y" without a surface ever claiming a verification
// that no run backs (spec 010, criterion 10).
//
// A host absent from this record has simply never been verified by a run.

import type { HarnessId } from "./harnesses.js";

export interface HarnessVerification {
  /** Host version the run probed. null = the host exposes no CLI version (Warp is an app). */
  version: string | null;
  /** ISO date (YYYY-MM-DD) of the run that produced this entry. */
  at: string;
  /**
   * How far that run went:
   * - \`invocation\` — runtime present and its version read;
   * - \`install\`    — the above PLUS the installed artifacts matched what the catalog promises.
   */
  depth: "invocation" | "install";
}

export const HOST_VERIFICATIONS: Partial<Record<HarnessId, HarnessVerification>> = {
${results
  .map((r) => {
    // Quote only ids that are not valid identifiers, so the generated file is
    // already formatter-clean and `npm run lint` never fails on a smoke run.
    const key = /^[A-Za-z_$][\w$]*$/.test(r.id) ? r.id : `"${r.id}"`;
    const version = r.version === null ? "null" : `"${r.version}"`;
    return `  ${key}: { version: ${version}, at: "${r.at}", depth: "${r.depth}" },`;
  })
  .join("\n")}
};
`;

writeFileSync(LEDGER, body, "utf8");
console.log(`ledger written: ${LEDGER}`);
process.exit(failures > 0 ? 1 : 0);
