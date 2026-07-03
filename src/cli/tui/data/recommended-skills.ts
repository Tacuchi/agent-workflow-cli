// Semilla de skills externas recomendadas para el [Skills] tab — hardcoded para
// evitar I/O en render (patrón workflow-content).
//
// Punto de drift: espejo de qtc-plugins-marketplace/README.md § "Skills externas
// recomendadas" — si esa sección cambia, actualizar este archivo (y viceversa).
// Los counts se derivan con `.length` — NO hardcodear cantidades en strings.
//
// Una recomendada nunca desaparece de la lista: `Remove` quita su registro y la
// devuelve a este estado `recommended` (la semilla es data, no registro).

import type { SeedSkill } from "../../../application/self/skills-manager.js";

export const RECOMMENDED_SKILLS: readonly SeedSkill[] = [
  // Procesamiento de documentos / MCP — anthropics/skills
  { name: "pdf", source: "anthropics/skills", description: "Create, edit and analyze PDF files." },
  { name: "docx", source: "anthropics/skills", description: "Create and edit Word documents." },
  { name: "xlsx", source: "anthropics/skills", description: "Create and edit Excel spreadsheets." },
  {
    name: "pptx",
    source: "anthropics/skills",
    description: "Create and edit PowerPoint presentations.",
  },
  {
    name: "mcp-builder",
    source: "anthropics/skills",
    description: "Guide to build MCP servers correctly.",
  },
  {
    name: "webapp-testing",
    source: "anthropics/skills",
    description: "Drive and test web apps end-to-end.",
  },
  // Disciplina de ingeniería — mattpocock/skills (MIT)
  {
    name: "diagnosing-bugs",
    source: "mattpocock/skills",
    description: "Systematic bug diagnosis before fixing.",
  },
  {
    name: "codebase-design",
    source: "mattpocock/skills",
    description: "Principles for structuring codebases.",
  },
  {
    name: "domain-modeling",
    source: "mattpocock/skills",
    description: "Model the domain before writing code.",
  },
  {
    name: "writing-great-skills",
    source: "mattpocock/skills",
    description: "Author effective agent skills.",
  },
  {
    name: "grill-me",
    source: "mattpocock/skills",
    description: "Socratic grilling of design decisions.",
  },
  // Meta / descubrimiento — vercel-labs
  {
    name: "find-skills",
    source: "vercel-labs/skills",
    description: "Discover and install agent skills on demand.",
  },
  {
    name: "react-best-practices",
    source: "vercel-labs/agent-skills",
    description: "React/Next.js performance rules from Vercel.",
  },
  // Anti over-engineering — DietrichGebert/ponytail (MIT)
  {
    name: "ponytail",
    source: "DietrichGebert/ponytail",
    description: "Lazy-senior-dev mode: YAGNI, stdlib first, minimal code.",
  },
  {
    name: "ponytail-review",
    source: "DietrichGebert/ponytail",
    description: "Review diffs hunting over-engineering to delete.",
  },
  // Documentación y calidad de skills — softaworks/agent-toolkit
  {
    name: "c4-architecture",
    source: "softaworks/agent-toolkit",
    description: "C4 architecture diagrams with Mermaid.",
  },
  {
    name: "skill-judge",
    source: "softaworks/agent-toolkit",
    description: "Evaluate SKILL.md design quality.",
  },
] as const;
