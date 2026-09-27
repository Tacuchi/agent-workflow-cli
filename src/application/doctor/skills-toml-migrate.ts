import { BUILTIN_DEFAULT_SKILLS } from "../../domain/skills.js";
import type { FileSystemPort } from "../../ports/file-system.js";

/** Migrate only active legacy template lines; comments and user bindings keep their bytes. */
export function migrateSkillsToml(text: string): { text: string; changed: boolean } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hasDesign = hasActiveDesign(lines);
  const output: string[] = [];
  let section = "";
  let changed = false;
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
    if (heading !== null) {
      section = heading[1]?.trim() ?? "";
      if (section === "compaction") {
        changed = true;
        continue;
      }
      output.push(line);
      continue;
    }
    if (section === "compaction") {
      if (line.trim().startsWith("#") || line.trim().length === 0) output.push(line);
      else changed = true;
      continue;
    }
    if (section !== "skills" || line.trim().startsWith("#")) {
      output.push(line);
      continue;
    }
    const rewritten = rewriteBinding(line, hasDesign);
    if (rewritten !== line) changed = true;
    if (rewritten.length > 0) output.push(rewritten);
  }
  return { text: changed ? output.join("") : text, changed };
}

function hasActiveDesign(lines: string[]): boolean {
  let skills = false;
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)\]/.exec(line);
    if (heading !== null) skills = heading[1] === "skills";
    else if (skills && /^\s*design\s*=/.test(line)) return true;
  }
  return false;
}

function rewriteBinding(line: string, hasDesign: boolean): string {
  const binding = /^(\s*)([a-z][a-z-]*)(\s*=\s*)(["'])([^"']+)\4(\s*(?:#.*)?(?:\r?\n)?)$/.exec(
    line,
  );
  if (binding === null) return line;
  const [, indent, role, equals, quote, value, suffix] = binding;
  if (["coding-standards", "writing", "testing", "tools"].includes(role ?? "")) {
    const comment = /(#.*?)(\r?\n)?$/.exec(suffix ?? "");
    return comment === null ? "" : `${indent}${comment[1]}${comment[2] ?? ""}`;
  }
  if (role === "ui-design" && hasDesign) return "";
  const currentRole = role === "ui-design" ? BUILTIN_DEFAULT_SKILLS.design : role;
  const currentValue =
    value === "ui-spec" && currentRole === BUILTIN_DEFAULT_SKILLS.design
      ? BUILTIN_DEFAULT_SKILLS.design
      : value === "workflow" && currentRole === "overview"
        ? BUILTIN_DEFAULT_SKILLS.overview
        : value;
  return `${indent}${currentRole}${equals}${quote}${currentValue}${quote}${suffix}`;
}

export async function applySkillsTomlMigration(fs: FileSystemPort, path: string): Promise<boolean> {
  const migration = migrateSkillsToml(await fs.readText(path));
  if (!migration.changed) return false;
  await fs.writeText(path, migration.text);
  return true;
}
