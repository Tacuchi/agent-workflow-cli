import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareVersions, parseVersion } from "../../domain/changelog-contract.js";
import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
import { RETIRED_WORKLINE_SKILLS } from "../../domain/skills.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { HUB_MIGRATE_ACTION } from "../../runtime/hub-resolution.js";
import {
  BLOCK_FILE,
  BLOCK_READ_FILES,
  type HubBlockMarkers,
  LEGACY_BLOCK_FILE,
  legacyBlockMarkers,
} from "../parsers/hub-block.js";
import type { HostStateReport } from "../self/host-states.js";
import { resolveBundledSkillPath } from "../self/install-skill.js";
import type { DoctorProvider, DoctorProviderInput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "hub-visibility" as const;
const OWNED_SECTIONS = new Set(["hub", "workline", "fuentes", "stack", "status", "pipeline"]);
/** First Claude Code release that reads AGENTS.md by itself (code.claude.com/docs/en/memory). */
const CLAUDE_READS_AGENTS_MD = [2, 1, 277] as const;
/** Files that make Claude Code read CLAUDE.md files only, in the hub or any folder above it. */
const CLAUDE_INSTRUCTION_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const AGENTS_IMPORT = "@AGENTS.md";

interface RetiredSection {
  from: number;
  to: number;
  heading: string;
  reference: string;
}

async function knownCommands(): Promise<{ aw: Set<string>; w: Set<string> | null }> {
  // Loaded after command registration: importing index statically from a doctor
  // provider would form a cycle through the `doctor` command itself.
  const { ALL_COMMANDS } = await import("../../cli/commands/index.js");
  const bundle = await resolveBundledSkillPath();
  let w: Set<string> | null = null;
  if (bundle !== null) {
    try {
      w = new Set(
        (await readdir(join(bundle, "commands")))
          .filter((file) => file.endsWith(".md") && file !== "README.md")
          .map((file) => file.slice(0, -3)),
      );
    } catch {
      // Cannot assert that an unknown /w: command is retired without its bundle.
    }
  }
  return { aw: new Set(ALL_COMMANDS.map((command) => command.name)), w };
}

function retiredReference(
  body: string,
  known: Awaited<ReturnType<typeof knownCommands>>,
): string | null {
  for (const [, command] of body.matchAll(/\baw\s+([a-z][a-z0-9-]*)\b/g)) {
    if (command !== undefined && !known.aw.has(command)) return `aw ${command}`;
  }
  if (known.w !== null) {
    for (const [, command] of body.matchAll(/\/w:([a-z][a-z0-9-]*)\b/g)) {
      if (command !== undefined && !known.w.has(command)) return `/w:${command}`;
    }
  }
  return retiredSkillReference(body);
}

/** Sections stop at the next heading or hub marker; only whole sections are removed. */
export function retiredSections(
  text: string,
  markers: { start: string; end: string },
  known: { aw: Set<string>; w: Set<string> | null },
): RetiredSection[] {
  const lines = text.split("\n");
  const boundaries = lines.flatMap((line, index) =>
    /^#{2,6}\s+\S/.test(line) || line.includes(markers.start) || line.includes(markers.end)
      ? [index]
      : [],
  );
  const sections: RetiredSection[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const from = boundaries[i] ?? 0;
    const heading = /^#{2,6}\s+(.+)$/.exec(lines[from] ?? "")?.[1]?.trim();
    if (heading === undefined || OWNED_SECTIONS.has(heading.toLowerCase())) continue;
    const to = boundaries[i + 1] ?? lines.length;
    const reference = retiredReference(lines.slice(from, to).join("\n"), known);
    if (reference !== null) sections.push({ from, to, heading, reference });
  }
  return sections;
}

export function withoutRetiredSections(
  text: string,
  markers: { start: string; end: string },
  known: { aw: Set<string>; w: Set<string> | null },
): string {
  const removed = retiredSections(text, markers, known);
  if (removed.length === 0) return text;
  return text
    .split("\n")
    .filter((_, index) => !removed.some((section) => index >= section.from && index < section.to))
    .join("\n");
}

export async function applyRetiredSectionRemoval(
  fs: FileSystemPort,
  path: string,
  markers: { start: string; end: string },
): Promise<boolean> {
  const before = await fs.readText(path);
  const after = withoutRetiredSections(before, markers, await knownCommands());
  if (after === before) return false;
  await fs.writeText(path, after);
  return true;
}

export const hubBlockProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput) {
    const fs = input.ctx.fs;
    const markers = input.ctx.paths.blockMarkers();
    const files = await Promise.all(
      BLOCK_READ_FILES.map(async (file) => {
        const path = join(input.hubDir, file);
        return { file, path, text: (await fs.exists(path)) ? await fs.readText(path) : null };
      }),
    );
    if (files.every((file) => file.text === null))
      return {
        coverage: [coverage(CATEGORY, "hub", "not-applicable", "sin archivos de proyecto")],
        findings: [],
      };
    const findings = await blockFileFindings(input, files, markers);
    const outdated = outdatedClaudeCode(input.hostStates);
    if (outdated !== null) findings.push(outdatedClaudeFinding(outdated));
    for (const file of files) {
      if (file.text === null || legacyBlockMarkers(file.text) === null) continue;
      findings.push(legacyBlockFinding(file.file, file.path));
    }
    const known = await knownCommands();
    for (const file of files) {
      if (file.text === null) continue;
      const sections = retiredSections(file.text, markers, known);
      if (sections.length === 0) continue;
      findings.push({
        id: doctorFindingId("hub", CATEGORY, `${file.file}:secciones-retiradas`),
        host: "hub",
        category: CATEGORY,
        resource: { kind: "project-file", name: file.file, locator: file.path },
        state: "warning",
        summary: `${file.file} cita comandos o skills retirados en ${sections.length} sección(es)`,
        impact: "sus instrucciones pueden dirigir a herramientas que ya no existen",
        evidence: sections.map((section) => `${section.heading}: ${section.reference}`),
        ownership: "ours",
        remediation: {
          kind: "manual",
          action: null,
          guidance: ["aw doctor prepare --select <id> y aw doctor apply --approval <digest>"],
        },
        proposal: { op: "hub.remove-retired-section", args: { file: file.file } },
      });
    }
    return { coverage: [coverage(CATEGORY, "hub", "checked")], findings };
  },
};

/** The legacy CLAUDE.md mirror, or whatever keeps Claude Code from reading AGENTS.md. */
async function blockFileFindings(
  input: DoctorProviderInput,
  files: readonly { file: string; text: string | null }[],
  markers: HubBlockMarkers,
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const agents = files.find((file) => file.file === BLOCK_FILE)?.text ?? null;
  const claude = files.find((file) => file.file === LEGACY_BLOCK_FILE)?.text ?? null;
  const legacyMirror = claude !== null && hasBlock(claude, markers);
  if (legacyMirror) findings.push(legacyMirrorFinding(input.hubDir));
  if (agents === null || !hasBlock(agents, markers)) return findings;
  const home = input.ctx.env.homeDir();
  const shadows = await shadowingFiles(input.ctx.fs, input.hubDir, home, claude);
  // The hub's own CLAUDE.md with the block is already the finding above, with its remedy.
  const legacyPath = join(input.hubDir, LEGACY_BLOCK_FILE);
  const others = shadows.filter((path) => !legacyMirror || path !== legacyPath);
  if (others.length > 0) findings.push(shadowFinding(input.hubDir, others));
  return findings;
}

function hasBlock(text: string, markers: HubBlockMarkers): boolean {
  const start = text.indexOf(markers.start);
  return start >= 0 && text.indexOf(markers.end, start + markers.start.length) >= 0;
}

/**
 * Every CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md in the hub or above it:
 * any of them makes Claude Code read CLAUDE.md files only. `~/.claude/CLAUDE.md`
 * is user scope and does not count; a hub CLAUDE.md that imports AGENTS.md
 * brings the block in, so nothing is shadowed then.
 */
async function shadowingFiles(
  fs: FileSystemPort,
  hubDir: string,
  home: string,
  hubClaude: string | null,
): Promise<string[]> {
  if (hubClaude?.split("\n").some((line) => line.trim() === AGENTS_IMPORT)) return [];
  const found: string[] = [];
  let dir = hubDir;
  for (;;) {
    for (const name of CLAUDE_INSTRUCTION_FILES) {
      const path = join(dir, name);
      if (path === join(home, ".claude", "CLAUDE.md")) continue;
      if (await fs.exists(path)) found.push(path);
    }
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** The Claude Code version the catalog read, when it is older than the AGENTS.md reader. */
function outdatedClaudeCode(states: readonly HostStateReport[]): string | null {
  const raw = states.find((state) => state.host === "claude-code")?.runtime.version ?? null;
  const version = parseVersion(/\d+\.\d+\.\d+/.exec(raw ?? "")?.[0] ?? "");
  if (raw === null || version === null) return null;
  return compareVersions(version, CLAUDE_READS_AGENTS_MD) < 0 ? raw : null;
}

function legacyMirrorFinding(hubDir: string): DoctorFinding {
  const path = join(hubDir, LEGACY_BLOCK_FILE);
  return {
    id: doctorFindingId("hub", CATEGORY, "claude-md-heredado"),
    host: "hub",
    category: CATEGORY,
    resource: { kind: "project-file", name: LEGACY_BLOCK_FILE, locator: path },
    state: "warning",
    summary: "CLAUDE.md conserva el bloque del hub: falta migrarlo a AGENTS.md",
    impact:
      "Claude Code lee CLAUDE.md en lugar de AGENTS.md y ve un bloque que Workline ya no actualiza",
    evidence: [`${path} tiene el bloque del hub`],
    ownership: "ours",
    remediation: {
      kind: "manual",
      action: null,
      guidance: ["aw hub-migrate muestra lo que hará", HUB_MIGRATE_ACTION],
    },
  };
}

function shadowFinding(hubDir: string, shadows: readonly string[]): DoctorFinding {
  return {
    id: doctorFindingId("hub", CATEGORY, "agents-md-tapado"),
    host: "hub",
    category: CATEGORY,
    resource: { kind: "project-file", name: BLOCK_FILE, locator: join(hubDir, BLOCK_FILE) },
    state: "warning",
    summary: "un archivo de instrucciones de Claude tapa el AGENTS.md del hub",
    impact: "Claude Code lee solo los CLAUDE.md y no ve el bloque del hub",
    evidence: shadows.map((path) => `${path} existe`),
    ownership: "foreign",
    remediation: {
      kind: "manual",
      action: null,
      guidance: [
        `crear ${join(hubDir, LEGACY_BLOCK_FILE)} con la línea ${AGENTS_IMPORT}`,
        "o elegir claude-md-and-agents-md en /config > Project instructions de Claude Code",
      ],
    },
  };
}

function outdatedClaudeFinding(version: string): DoctorFinding {
  return {
    id: doctorFindingId("claude-code", CATEGORY, "claude-sin-agents-md"),
    host: "claude-code",
    category: CATEGORY,
    resource: { kind: "host-runtime", name: "Claude Code", locator: version },
    state: "warning",
    summary: `Claude Code ${version} no lee AGENTS.md: hace falta 2.1.277 o posterior`,
    impact: "esa versión no ve el bloque del hub",
    evidence: [`versión detectada: ${version}`],
    ownership: "foreign",
    remediation: {
      kind: "manual",
      action: null,
      guidance: ["actualizar Claude Code", `o crear en el hub un CLAUDE.md con ${AGENTS_IMPORT}`],
    },
  };
}

/** Every hub command fails with HUB_MIGRATION_REQUIRED until the block is migrated. */
function legacyBlockFinding(file: string, path: string): DoctorFinding {
  return {
    id: doctorFindingId("hub", CATEGORY, `${file}:marcadores-anteriores`),
    host: "hub",
    category: CATEGORY,
    resource: { kind: "project-file", name: file, locator: path },
    state: "blocking",
    summary: `${file} lleva el bloque con marcadores anteriores a 29.0.0`,
    impact: "todo comando del hub falla con HUB_MIGRATION_REQUIRED hasta migrarlo",
    evidence: ["el bloque usa <NS>-PROJECT-START/END"],
    ownership: "ours",
    remediation: { kind: "manual", action: null, guidance: [HUB_MIGRATE_ACTION] },
  };
}

function retiredSkillReference(body: string): string | null {
  for (const [, skill] of body.matchAll(
    /\b(agent-workflow:[a-z][a-z0-9-]*|ui-design|ui-spec)\b/g,
  )) {
    if (
      skill !== undefined &&
      (RETIRED_WORKLINE_SKILLS.has(skill) || skill === "ui-design" || skill === "ui-spec")
    )
      return skill;
  }
  return null;
}
