// Seed of recommended external skills for the [Skills] tab — hardcoded to
// avoid I/O during render (workflow-content pattern).
//
// Drift point: mirror of qtc-plugins-marketplace/README.md § "Skills externas
// recomendadas" — if that section changes, update this file (and vice versa).
// Counts are derived with `.length` — do NOT hardcode counts in strings.
//
// A recommended skill never leaves the list: `Remove` drops its registration
// and returns it to this `recommended` state (the seed is data, not registry).

import type { SeedSkill } from "../../../application/self/skills-manager.js";

export const RECOMMENDED_SKILLS: readonly SeedSkill[] = [
  // Document processing / MCP — anthropics/skills
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
  // Engineering discipline — mattpocock/skills (MIT)
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
  // Meta / discovery — vercel-labs
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
  // Skill documentation and quality — softaworks/agent-toolkit
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
  // Stack gaps (research 001) — on-stack coverage the QTC plugins do not provide
  {
    name: "spring-boot-testing",
    source: "github/awesome-copilot",
    description: "Spring Boot testing: slices, MockMvc, DataJpaTest, Testcontainers.",
  },
  {
    name: "postgresql-optimization",
    source: "github/awesome-copilot",
    description: "Postgres query performance: EXPLAIN, indexing, pagination anti-patterns.",
  },
  {
    name: "prometheus",
    source: "grafana/skills",
    description: "PromQL, metrics and alerting for Prometheus at runtime.",
  },
  // Agent behavior (research 002) — portable behaviors the harness doctrine does not enforce
  {
    name: "condition-based-waiting",
    source: "nickcrew/claude-ctx-plugin",
    description: "Forbid guessed sleep(); poll the actual state with a bounded timeout.",
  },
  {
    name: "context-engineering-collection",
    source: "muratcankoylan/agent-skills-for-context-engineering",
    description: "Offload context to files and re-read on demand to keep the window lean.",
  },
] as const;
