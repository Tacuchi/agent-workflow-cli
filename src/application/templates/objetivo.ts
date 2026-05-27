// Placeholders: {folder}, {origen_block}, {objetivo}, {tipo}, {modalidad}.

const DEFAULT_TEMPLATE = `# Objective — {folder}
{origen_block}
## Requirement
{objetivo}

## Context
<!-- What is NOT in the requirement. Don't repeat the above. Short bullets: motivation, constraints, area affected. -->

## Acceptance criteria
- [ ] <criterion 1>
- [ ] <criterion 2>
`;

const DEV_TEMPLATE = `# Objective — {folder}
{origen_block}
## Type
{tipo}

## Requirement
{objetivo}

## Context
<!-- What is NOT in the requirement. Don't repeat the above. Short bullets: modules affected, motivation, technical constraints. -->

## Acceptance criteria
- [ ] <criterion 1>
- [ ] <criterion 2>

## Topics
<!-- Optional. Slug-kebab: short description, used by /release-scripts. -->
`;

const DESIGN_TEMPLATE = `# Objective — {folder}
{origen_block}
## Type
{tipo}

## Brief
{objetivo}

## Context
<!-- What is NOT in the brief. Don't repeat the above. Short bullets: users, constraints, existing design system, external references. -->

## Acceptance criteria
- [ ] <criterion 1>
- [ ] <criterion 2>
`;

const ANALYZE_TEMPLATE = `# Objective — {folder}
{origen_block}
## Modality
{modalidad}

## Question
{objetivo}

## Context
<!-- What is NOT in the question. Don't repeat the above. Short bullets: systems/sources involved, constraints, stakeholders. -->

## Success criteria
<!-- What turns this investigation into "answered". Checklist \`- [ ]\`. -->
- [ ] <criterion 1>
- [ ] <criterion 2>
`;

// Modo --lite (flow=dev): OBJECTIVE condensado para el micro-lifecycle /patch.
// Solo Type + Requirement; sin Context/Acceptance/Topics (una tarea pequeña no los necesita).
const PATCH_TEMPLATE = `# Objective — {folder}
{origen_block}
## Type
{tipo}

## Requirement
{objetivo}
`;

const TEMPLATES_BY_FLOW: Record<string, string> = {
  dev: DEV_TEMPLATE,
  design: DESIGN_TEMPLATE,
  analyze: ANALYZE_TEMPLATE,
  default: DEFAULT_TEMPLATE,
};

export function getObjetivoTemplate(flow: string | null | undefined, lite = false): string {
  const key = (flow ?? "").trim().toLowerCase();
  if (lite && key === "dev") return PATCH_TEMPLATE;
  return TEMPLATES_BY_FLOW[key] ?? DEFAULT_TEMPLATE;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [k, v] of Object.entries(values)) {
    result = result.split(`{${k}}`).join(v);
  }
  return result;
}
