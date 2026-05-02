// Mirrors qtc_core/templates/objetivo_*.md byte-byte.
// Placeholders: {folder}, {origen_block}, {objetivo}, {tipo}, {modalidad}.

const DEFAULT_TEMPLATE = `# Objetivo — {folder}
{origen_block}
## Requerimiento
{objetivo}

## Contexto
<!-- Lo que NO está en el requerimiento. Sin repetir lo de arriba. Bullets cortos: motivación, restricciones, área afectada. -->

## Criterios de aceptación
- [ ] <describir criterio 1>
- [ ] <describir criterio 2>
`;

const DEV_TEMPLATE = `# Objetivo — {folder}
{origen_block}
## Requerimiento
{objetivo}

## Contexto
<!-- Lo que NO está en el requerimiento. Sin repetir lo de arriba. Bullets cortos: módulos afectados, motivación, restricciones técnicas. -->

## Criterios de aceptación
- [ ] <describir criterio 1>
- [ ] <describir criterio 2>

## Temas
<!-- Opcional. Slug-kebab: descripción corta, para /release-scripts. -->
`;

const DESIGN_TEMPLATE = `# Objetivo — {folder}
{origen_block}
## Tipo
{tipo}

## Brief
{objetivo}

## Contexto
<!-- Lo que NO está en el brief. Sin repetir lo de arriba. Bullets cortos: usuarios, constraints, design system existente, referencias externas. -->

## Criterios de aceptación
- [ ] <describir criterio 1>
- [ ] <describir criterio 2>
`;

const ANALYZE_TEMPLATE = `# Objetivo — {folder}
{origen_block}
## Modalidad
{modalidad}

## Pregunta
{objetivo}

## Contexto
<!-- Lo que NO está en la pregunta. Sin repetir lo de arriba. Bullets cortos: sistemas/fuentes involucrados, restricciones, stakeholders. -->

## Criterios de éxito
<!-- Qué convierte esta investigación en "respondida". Checklist \`- [ ]\`. -->
- [ ] <criterio 1>
- [ ] <criterio 2>
`;

const TEMPLATES_BY_FLOW: Record<string, string> = {
  dev: DEV_TEMPLATE,
  design: DESIGN_TEMPLATE,
  analyze: ANALYZE_TEMPLATE,
  default: DEFAULT_TEMPLATE,
};

export function getObjetivoTemplate(flow: string | null | undefined): string {
  const key = (flow ?? "").trim().toLowerCase();
  return TEMPLATES_BY_FLOW[key] ?? DEFAULT_TEMPLATE;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [k, v] of Object.entries(values)) {
    result = result.split(`{${k}}`).join(v);
  }
  return result;
}
