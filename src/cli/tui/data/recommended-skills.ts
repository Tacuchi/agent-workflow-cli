// Curated catalog of external skills for the [Skills] tab (Spec 043) —
// hardcoded to avoid I/O during render (workflow-content pattern).
//
// `SKILL_CATALOG` is the WHOLE reviewed record, withdrawn entries included:
// dropping a row from the recommendation must not erase the reason it was
// dropped, and an installation that stops being recommended stays readable in
// the full inventory. `RECOMMENDED_SKILLS` is DERIVED from it — the habitual
// set the list opens on.
//
// Drift point: this CLI catalog is the source of truth; the companion marketplace
// README § "Skills externas recomendadas" reflects it via its captured catalog.
// Counts are derived with `.length` — do NOT hardcode counts in strings.
//
// A recommended skill never leaves the list: `Remove` drops its registration
// and returns it to this `recommended` state (the catalog is data, not registry).
//
// `reviewedRef` is the revision this review INSPECTED. It is not the ref an
// acquisition resolves, and it is not a promise that upstream still matches.

import {
  type CatalogReserve,
  type SeedSkill,
  isRecommendedEntry,
} from "../../../application/self/skills-catalog.js";

/** Revisions the 2026-09-09 review inspected, one per upstream. */
const REF = {
  anthropics: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
  mattpocock: "3cca18b368ae95cdbdebbff572ccafa662551015",
  vercelAgentSkills: "063bee94c3f4df8453406c830b0a7df0f2860278",
  awesomeCopilot: "7568a482ce2df38f8965ab5336a3220db796a4ba",
  grafana: "51d33e71e191b409bbd25fc7be2684c610d18166",
  trailofbits: "d3323cefbcf645678b8dc481de204b02ad3d02dc",
  antfu: "a74f281a27dadc02397bc1a174b0f2c97531b6ae",
  openai: "49f948faa9258a0c61caceaf225e179651397431",
  cortex: "bb47af79ad3befe01ae01940fcf5f16e30a1b6df",
  firecrawl: "261fc257d17c3eab0f673be31c408fd9fdc2171a",
  archify: "851b279f3710c3ed6f152f4b044a504ca4eb207c",
} as const;

const RESEARCH = "Workline skills research 2026-09-09";
/** The later review that added the two document/diagram entries. */
const SPEC_044 = "Spec 044 · ajustes operativos del arnés";
const CONTEXT_COLLECTION = "muratcankoylan/agent-skills-for-context-engineering";

/**
 * Every entry the 2026-09-09 curation reviewed: the 24 seed rows, the seven
 * prioritized context leaves and the two new candidates — plus the two Spec 044
 * added afterwards (`anydoc`, `archify`), each in the group it belongs to.
 */
export const SKILL_CATALOG: readonly SeedSkill[] = [
  // Document processing / MCP — firecrawl/anydoc (into Markdown) and anthropics/skills (out of it)
  {
    name: "anydoc",
    source: "firecrawl/anydoc",
    description:
      "Convert Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV and PDF to Markdown from the command line.",
    disposition: "keep",
    useWhen:
      "A document ARRIVES in a foreign format and the work needs its content as Markdown — reading it, quoting it, bringing it into a spec. The direction is INTO Markdown: the anthropics document skills below go the other way, producing the .pdf/.docx/.xlsx/.pptx somebody asked for.",
    knownLimits:
      "A scanned page is not resolved locally: it exits with code 3, and converting it means sending the document to an external service.",
    skillName: "convert-documents-to-markdown",
    path: "skills/convert-documents-to-markdown",
    evidence: SPEC_044,
    reviewedRef: REF.firecrawl,
  },
  {
    name: "pdf",
    source: "anthropics/skills",
    description: "Create, edit and analyze PDF files.",
    disposition: "conditional",
    useWhen:
      "A PDF has to be PRODUCED or edited. Reading one to get its text as Markdown is `anydoc`.",
    reason: "Adds nothing to the habitual Markdown cycle.",
    knownLimits: "These document skills declare their own terms; not MIT/Apache by repo.",
    reviewedRef: REF.anthropics,
  },
  {
    name: "docx",
    source: "anthropics/skills",
    description: "Create and edit Word documents.",
    disposition: "conditional",
    useWhen: "A Word document has to be produced or edited; reading one is `anydoc`.",
    reason: "SPEC/PLAN are not converted to Word by default.",
    knownLimits: "These document skills declare their own terms; not MIT/Apache by repo.",
    reviewedRef: REF.anthropics,
  },
  {
    name: "xlsx",
    source: "anthropics/skills",
    description: "Create and edit Excel spreadsheets.",
    disposition: "conditional",
    useWhen: "A spreadsheet has to be produced or edited; reading one is `anydoc`.",
    reason: "Its mandatory recalculation does not belong to tasks without sheets.",
    knownLimits: "These document skills declare their own terms; not MIT/Apache by repo.",
    reviewedRef: REF.anthropics,
  },
  {
    name: "pptx",
    source: "anthropics/skills",
    description: "Create and edit PowerPoint presentations.",
    disposition: "conditional",
    useWhen: "A presentation has to be produced or edited; reading one is `anydoc`.",
    knownLimits: "These document skills declare their own terms; not MIT/Apache by repo.",
    reviewedRef: REF.anthropics,
  },
  {
    name: "mcp-builder",
    source: "anthropics/skills",
    description: "Guide to build MCP servers correctly.",
    disposition: "keep",
    useWhen: "Building or extending an MCP server, within the approved scope.",
    knownLimits: "Recommends Zod and ten evaluations; this repo validates manually (DEC-001).",
    evidence: `${RESEARCH} · H5`,
    reviewedRef: REF.anthropics,
  },
  {
    name: "webapp-testing",
    source: "anthropics/skills",
    description: "Drive and test web apps end-to-end.",
    disposition: "conditional",
    useWhen: "A web application with the pertinent tooling.",
    knownLimits: "Does not replace the terminal verification an Ink TUI needs.",
    reviewedRef: REF.anthropics,
  },
  // Engineering discipline — mattpocock/skills (MIT)
  {
    name: "diagnosing-bugs",
    source: "mattpocock/skills",
    description: "Systematic bug diagnosis before fixing.",
    disposition: "keep",
    useWhen: "A hard bug with a pertinent reproduction.",
    knownLimits: "Six-phase process that may stop without a repro; not a universal gate.",
    reviewedRef: REF.mattpocock,
  },
  {
    name: "codebase-design",
    source: "mattpocock/skills",
    description: "Principles for structuring codebases.",
    disposition: "keep",
    useWhen: "Designing interfaces and modules.",
    knownLimits: "Its references link a subagent variant; that is not delegation authority.",
    reviewedRef: REF.mattpocock,
  },
  {
    name: "domain-modeling",
    source: "mattpocock/skills",
    description: "Model the domain before writing code.",
    disposition: "conditional",
    useWhen: "A real vocabulary or domain change.",
    knownLimits: "Writes CONTEXT/ADR at once; the work's destination and authorization prevail.",
    evidence: `${RESEARCH} · H5`,
    reviewedRef: REF.mattpocock,
  },
  {
    name: "writing-great-skills",
    source: "mattpocock/skills",
    description: "Author effective agent skills.",
    disposition: "keep",
    useWhen: "Authoring or rewriting a skill.",
    knownLimits: "Its invocation claims have to be checked against each host.",
    reviewedRef: REF.mattpocock,
  },
  {
    name: "grill-me",
    source: "mattpocock/skills",
    description: "Socratic grilling of design decisions.",
    disposition: "withdrawn",
    reason: "Seven-line wrapper pointing at `/grilling`, absent from the inspected roots.",
    knownLimits: "The interview is optional; it is not a new SPEC step. `grilling` is a reserve.",
    evidence: `${RESEARCH} · H2`,
    reviewedRef: REF.mattpocock,
  },
  // Meta / discovery — vercel-labs
  {
    name: "find-skills",
    source: "vercel-labs/skills",
    description: "Discover and install agent skills on demand.",
    disposition: "keep",
    useWhen: "Discovering candidate skills.",
    knownLimits: "Its `npx skills add/update` examples never replace this installation's owner.",
  },
  {
    name: "react-best-practices",
    source: "vercel-labs/agent-skills",
    description: "React/Next.js performance rules from Vercel.",
    disposition: "conditional",
    useWhen: "React web rules that actually apply to the change.",
    reason: "Directory, frontmatter name and catalog label differ — they are not equivalent.",
    knownLimits: "Written for React web; an Ink TUI is not a DOM.",
    skillName: "vercel-react-best-practices",
    path: "skills/react-best-practices",
    evidence: `${RESEARCH} · H3`,
    reviewedRef: REF.vercelAgentSkills,
  },
  // Anti over-engineering — DietrichGebert/ponytail (MIT)
  {
    name: "ponytail",
    source: "DietrichGebert/ponytail",
    description: "Lazy-senior-dev mode: YAGNI, stdlib first, minimal code.",
    disposition: "withdrawn",
    reason: "Persistent mode that duplicates the chassis' own minimality criterion.",
    knownLimits: "Also imposes answers and a test strategy; ambiguous against a closed PLAN.",
    evidence: `${RESEARCH} · H1`,
  },
  {
    name: "ponytail-review",
    source: "DietrichGebert/ponytail",
    description: "Review diffs hunting over-engineering to delete.",
    disposition: "keep",
    useWhen: "A requested complexity review, with a limited scope.",
    knownLimits: "Its verdict is not approval of correctness, performance or security.",
  },
  // Skill documentation and quality — softaworks/agent-toolkit
  {
    name: "c4-architecture",
    source: "softaworks/agent-toolkit",
    description: "C4 architecture diagrams with Mermaid.",
    disposition: "conditional",
    useWhen:
      "The diagram has to live INSIDE a Markdown document, as Mermaid. Structurizr DSL as code is `structurizr-c4`; a browsable HTML page is `archify`.",
    knownLimits:
      "Its mandatory levels add deliverables; three skills now cover architecture diagrams — choose one by delivery format, never load them together.",
  },
  {
    name: "skill-judge",
    source: "softaworks/agent-toolkit",
    description: "Evaluate SKILL.md design quality.",
    disposition: "keep",
    useWhen: "Judging a skill's design, on demand.",
    knownLimits: "752 lines; an editorial score is not proof of efficacy.",
  },
  // Stack gaps (research 001) — on-stack coverage the companion plugins do not provide
  {
    name: "spring-boot-testing",
    source: "github/awesome-copilot",
    description: "Spring Boot testing: slices, MockMvc, DataJpaTest, Testcontainers.",
    disposition: "conditional",
    useWhen: "Java/Spring work.",
    reason: "Out of the general recommendation: it is a specialty, not a utility for this CLI.",
    knownLimits: "Upstream targets Spring Boot 4 / JUnit 6 — check the project's versions.",
    path: "skills/spring-boot-testing",
    reviewedRef: REF.awesomeCopilot,
  },
  {
    name: "postgresql-optimization",
    source: "github/awesome-copilot",
    description: "Postgres query performance: EXPLAIN, indexing, pagination anti-patterns.",
    disposition: "conditional",
    useWhen: "PostgreSQL work.",
    knownLimits: "Covers DDL and EXPLAIN ANALYZE; authorizes no SQL, read-only policy stands.",
    path: "skills/postgresql-optimization",
    reviewedRef: REF.awesomeCopilot,
  },
  {
    name: "prometheus",
    source: "grafana/skills",
    description: "PromQL, metrics and alerting for Prometheus at runtime.",
    disposition: "conditional",
    useWhen: "PromQL or observability present in the task.",
    knownLimits: "No evidence it is a dependency of developing this CLI.",
    path: "skills/grafana-lgtm/prometheus",
    reviewedRef: REF.grafana,
  },
  // Agent behavior (research 002) — portable behaviors the harness doctrine does not enforce
  {
    name: "condition-based-waiting",
    source: "nickcrew/claude-ctx-plugin",
    description: "Forbid guessed sleep(); poll the actual state with a bounded timeout.",
    disposition: "repair",
    useWhen: "Replacing a guessed sleep() with polling the real state.",
    reason: "The installation comes from obra/superpowers-skills and declares another identity.",
    knownLimits: "The proposed variant adds extensions; installing Cortex whole is not the fix.",
    skillName: "condition-based-waiting",
    proposedSource: "NickCrew/Claude-Cortex",
    path: "skills/condition-based-waiting",
    evidence: `${RESEARCH} · H3`,
    reviewedRef: REF.cortex,
  },
  {
    name: "context-engineering-collection",
    source: CONTEXT_COLLECTION,
    description: "Offload context to files and re-read on demand to keep the window lean.",
    disposition: "withdrawn",
    reason: "The whole-package recommendation is replaced by explicitly chosen leaves.",
    knownLimits: "One row can bring 21 identities, examples and a template included.",
    evidence: `${RESEARCH} · H4`,
  },
  {
    name: "checklist-discipline",
    source: "erichowens/some_claude_skills",
    description: "Guard against skipping steps in long multi-step procedures/runbooks.",
    disposition: "withdrawn",
    reason: "Aimed at medicine/aviation/construction and excludes simple tasks.",
    knownLimits: "Workline already carries its own criteria and gates.",
  },
  // Architecture as code — Tacuchi/structurizr-c4-skill
  {
    name: "structurizr-c4",
    source: "Tacuchi/structurizr-c4-skill",
    description: "C4 diagrams as code with Structurizr DSL: viewer, validate, export. No Docker.",
    disposition: "keep",
    useWhen:
      "The architecture is kept AS CODE in Structurizr DSL, to validate and export from that source. Mermaid inside a document is `c4-architecture`; an interactive HTML page or a snapshot comparison is `archify`.",
    knownLimits:
      "Choose by delivery format; three skills now cover architecture diagrams and none of them replaces another.",
  },
  // Interactive architecture rendering — tt-a1i/archify
  {
    name: "archify",
    source: "tt-a1i/archify",
    description:
      "Compile a typed JSON architecture spec into interactive HTML with inline SVG, and compare two validated snapshots.",
    disposition: "keep",
    useWhen:
      "The delivery is a diagram somebody OPENS and navigates in a browser, or two snapshots have to be read side by side as Before / Delta / After. Neither of the other two answers that: `structurizr-c4` keeps the architecture as DSL code and `c4-architecture` draws Mermaid inside a document.",
    knownLimits:
      "The inspected revision declares version 2.17 and labels itself development; what is stated here is what was inspected, never a promise about upstream. Its input is a typed JSON spec, so the architecture has to be written in that shape first.",
    path: "archify",
    evidence: SPEC_044,
    reviewedRef: REF.archify,
  },
  // Context engineering — the seven leaves that replace the whole-collection row.
  // Each one is addressable by its own path inside the collection.
  {
    name: "tool-design",
    source: CONTEXT_COLLECTION,
    description: "Tool contracts, selection, errors and catalog consolidation.",
    disposition: "conditional",
    useWhen: "Designing or consolidating tool contracts.",
    path: "skills/tool-design",
    evidence: `${RESEARCH} · context collection`,
  },
  {
    name: "filesystem-context",
    source: CONTEXT_COLLECTION,
    description: "Selective reads and file-backed evidence to keep the window lean.",
    disposition: "conditional",
    useWhen: "Large evidence has to be read selectively.",
    knownLimits: "Must respect Workline's session locations and recovery.",
    path: "skills/filesystem-context",
    evidence: `${RESEARCH} · context collection`,
  },
  {
    name: "context-compression",
    source: CONTEXT_COLLECTION,
    description: "Compression and summary techniques for long-running continuity.",
    disposition: "conditional",
    useWhen: "Continuity or summarization IS the task.",
    knownLimits: "Does not replace the host's own compaction.",
    path: "skills/context-compression",
    evidence: `${RESEARCH} · context collection`,
  },
  {
    name: "context-optimization",
    source: CONTEXT_COLLECTION,
    description: "Measured optimization of what a turn actually loads.",
    disposition: "conditional",
    useWhen: "Optimizing context with a measurement to show.",
    knownLimits: "Promises no access to the model's internal caches.",
    path: "skills/context-optimization",
    evidence: `${RESEARCH} · context collection`,
  },
  {
    name: "context-degradation",
    source: CONTEXT_COLLECTION,
    description: "Diagnose context loss and conflict before choosing a fix.",
    disposition: "conditional",
    useWhen: "Diagnosing lost or conflicting context.",
    path: "skills/context-degradation",
    evidence: `${RESEARCH} · context collection`,
  },
  {
    name: "evaluation",
    source: CONTEXT_COLLECTION,
    description: "Design comparisons and regressions of agent behavior.",
    disposition: "conditional",
    useWhen: "Designing a behavior comparison or regression.",
    knownLimits: "Not a campaign to run on every task.",
    path: "skills/evaluation",
    evidence: `${RESEARCH} · context collection`,
  },
  {
    name: "harness-engineering",
    source: CONTEXT_COLLECTION,
    description: "Edit boundaries, continuity and evaluation of an agent harness.",
    disposition: "conditional",
    useWhen: "Developing Workline itself.",
    knownLimits: "Do not install a second execution controller.",
    path: "skills/harness-engineering",
    evidence: `${RESEARCH} · context collection`,
  },
  // Candidates for a bounded trial (Spec 043 AC-06) — Trail of Bits, CC-BY-SA-4.0.
  {
    name: "property-based-testing",
    source: "trailofbits/skills",
    description: "Properties and invariants instead of tautological or empty tests.",
    disposition: "candidate",
    useWhen: "Properties of a parser, serialization, normalization or an invariant.",
    reason: "Bounded trial first: one concrete property of an existing component.",
    knownLimits: "Adding fast-check is a separate decision; a directory audit reported a Fail.",
    path: "plugins/property-based-testing/skills/property-based-testing",
    evidence: `${RESEARCH} · new candidates`,
    reviewedRef: REF.trailofbits,
  },
  {
    name: "sharp-edges",
    source: "trailofbits/skills",
    description: "Review defaults, ambiguous options and permission limits.",
    disposition: "candidate",
    useWhen: "Reviewing a sensitive surface: defaults, options, permission limits.",
    reason: "Bounded trial on a sensitive surface, analyzed inline.",
    knownLimits: "Its optional agent is not authorized; a deliberate warning is not a blocker.",
    path: "plugins/sharp-edges/skills/sharp-edges",
    evidence: `${RESEARCH} · new candidates`,
    reviewedRef: REF.trailofbits,
  },
];

/**
 * Reviewed alternatives that are NOT recommended and are not rows either:
 * they are documented so a pertinent request can reach them with its identity
 * and its limit already known.
 */
export const CATALOG_RESERVES: readonly CatalogReserve[] = [
  {
    name: "differential-review",
    source: "trailofbits/skills",
    path: "plugins/differential-review/skills/differential-review",
    reviewedRef: REF.trailofbits,
    availability: "on-request",
    reason: "Requested audit only: demands a report and mentions a plugin agent.",
  },
  {
    name: "grilling",
    source: "mattpocock/skills",
    path: "skills/productivity/grilling",
    reviewedRef: REF.mattpocock,
    availability: "on-request",
    reason: "Optional replacement for the withdrawn grill-me wrapper, if that style is asked for.",
  },
  {
    name: "cli-creator",
    source: "openai/skills",
    path: "skills/.curated/cli-creator",
    reviewedRef: REF.openai,
    availability: "on-request",
    reason: "For a NEW CLI: its runtime and scaffolding defaults do not fit maintaining this one.",
  },
  {
    name: "vitest",
    source: "antfu/skills",
    path: "skills/vitest",
    reviewedRef: REF.antfu,
    availability: "incompatible",
    reason: "The reviewed revision declares Vitest 5.x beta; this repo runs 2.x.",
  },
  // The collection's examples and template: never an incidental operational skill.
  {
    name: "book-sft-pipeline",
    source: CONTEXT_COLLECTION,
    path: "skills/book-sft-pipeline",
    availability: "not-operational",
    reason: "Literary training example, not a technique for this work.",
  },
  {
    name: "digital-brain",
    source: CONTEXT_COLLECTION,
    path: "skills/digital-brain",
    availability: "not-operational",
    reason: "Personal-operation example over its own files and memory.",
  },
  {
    name: "reasoning-trace-optimizer",
    source: CONTEXT_COLLECTION,
    path: "skills/reasoning-trace-optimizer",
    availability: "not-operational",
    reason: "Example whose commands and trace access are not demonstrated here.",
  },
  {
    name: "comprehensive-research-agent",
    source: CONTEXT_COLLECTION,
    path: "skills/comprehensive-research-agent",
    availability: "not-operational",
    reason: "Generated example that adds reasoning ceremony to any multi-step research.",
  },
  {
    name: "skill-template",
    source: CONTEXT_COLLECTION,
    path: "skills/skill-template",
    availability: "not-operational",
    reason: "Authoring material, not a skill to discover as operational.",
  },
];

/**
 * The habitual recommended set — derived, never a second list to maintain:
 * a withdrawn entry keeps its metadata in {@link SKILL_CATALOG} and leaves
 * this projection.
 */
export const RECOMMENDED_SKILLS: readonly SeedSkill[] = SKILL_CATALOG.filter(isRecommendedEntry);
