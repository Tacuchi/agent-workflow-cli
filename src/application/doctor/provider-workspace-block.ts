import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
import { RETIRED_SKILL_IDENTITIES, RETIRED_WORKLINE_SKILLS } from "../../domain/skills.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { resolveBundledSkillPath } from "../self/install-skill.js";
import type { DoctorProvider, DoctorProviderInput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "workspace-visibility" as const;
const MIRRORS = ["CLAUDE.md", "AGENTS.md"] as const;
const OWNED_SECTIONS = new Set(["proyecto", "fuentes", "stack", "status", "pipeline"]);

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
  for (const [, skill] of body.matchAll(
    /\b(agent-workflow:[a-z][a-z0-9-]*|ui-design|ui-spec)\b/g,
  )) {
    if (
      skill !== undefined &&
      (RETIRED_WORKLINE_SKILLS.has(skill) || RETIRED_SKILL_IDENTITIES.has(skill))
    )
      return skill;
  }
  return null;
}

/** Sections stop at the next heading or project marker; only whole sections are removed. */
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

export const workspaceBlockProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput) {
    const fs = input.ctx.fs;
    const markers = input.ctx.paths.blockMarkers();
    const files = await Promise.all(
      MIRRORS.map(async (file) => {
        const path = join(input.workspaceDir, file);
        return { file, path, text: (await fs.exists(path)) ? await fs.readText(path) : null };
      }),
    );
    if (files.every((file) => file.text === null))
      return {
        coverage: [coverage(CATEGORY, "workspace", "not-applicable", "sin archivos de proyecto")],
        findings: [],
      };
    const findings: DoctorFinding[] = [];
    const block = (text: string | null): string | null => {
      if (text === null) return null;
      const start = text.indexOf(markers.start);
      const end = text.indexOf(markers.end, start + markers.start.length);
      return start < 0 || end < 0 ? null : text.slice(start, end + markers.end.length);
    };
    const left = block(files[0]?.text ?? null);
    const right = block(files[1]?.text ?? null);
    if (left !== right && (left !== null || right !== null)) {
      findings.push({
        id: doctorFindingId("workspace", CATEGORY, "bloques-divergentes"),
        host: "workspace",
        category: CATEGORY,
        resource: {
          kind: "project-block",
          name: "CLAUDE.md / AGENTS.md",
          locator: input.workspaceDir,
        },
        state: "warning",
        summary: "los bloques de proyecto de CLAUDE.md y AGENTS.md divergen",
        impact: "dos hosts leen declaraciones distintas del mismo workspace",
        evidence: ["los contenidos entre marcadores no coinciden"],
        ownership: "ours",
        remediation: {
          kind: "manual",
          action: null,
          guidance: ["aw project-md-upsert --init reescribe el par tras revisar ambas versiones"],
        },
      });
    }
    const known = await knownCommands();
    for (const file of files) {
      if (file.text === null) continue;
      const sections = retiredSections(file.text, markers, known);
      if (sections.length === 0) continue;
      findings.push({
        id: doctorFindingId("workspace", CATEGORY, `${file.file}:secciones-retiradas`),
        host: "workspace",
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
        proposal: { op: "workspace.remove-retired-section", args: { file: file.file } },
      });
    }
    return { coverage: [coverage(CATEGORY, "workspace", "checked")], findings };
  },
};
