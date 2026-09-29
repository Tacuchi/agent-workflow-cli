import type { WorklineFlow } from "../../application/capability/compose.js";

/**
 * The fixed Success criteria each documentary flow seeds when its session is
 * created (plan 082 F7 · spec 061 AC-09): the convergence checklist its loop
 * closes on. The acceptance criteria of the spec the run rests on are seeded
 * after them; the agent may add its own.
 */
export const FLOW_SUCCESS_CRITERIA: Readonly<Partial<Record<WorklineFlow, readonly string[]>>> = {
  "spec-refine": [
    "El resultado se entiende y el comportamiento actual está establecido.",
    "Si toca comportamiento existente, el cambio de comportamiento está descrito.",
    "Scope In/Out declarado; cada criterio traza al requisito y cada escenario a un criterio, al que agrega GIVEN o bordes.",
    "Cada criterio lleva su rótulo AC-nn y ninguno prescribe la mecánica de verificación.",
    "Sin contradicciones; las decisiones bloqueantes resueltas y el resto con destino.",
    "Minimalidad: nada pesa más de lo que el resultado exige.",
    "PLAN puede continuar sin inventar, con evidencia acotada al checkout.",
  ],
  "plan-new": [
    "Cada criterio de la spec traza a una fase o tarea con su evidencia local.",
    "El Comportamiento final de ## Solution cubre los criterios.",
    "Cada ### Fn deja un estado verificable con su condición de salida.",
    "El orden integra temprano, sin ciclos, e ## Impacted es coherente con ## Solution.",
    "Cada fase declara su evidencia primaria con comando local.",
    "## Execution batches particiona cada fase una sola vez y cruza sólo fronteras elegibles.",
    "El plan es reanudable y mínimo.",
  ],
  "plan-refine": [
    "Contrato, recorrido, fases, fuentes, simulación, evidencia y lotes son ejecutables.",
    "El plan queda alineado con lo que cambió, sin tocar estados ni casillas.",
    "Cada criterio de la spec sigue trazando a una fase con su evidencia local.",
    "El plan es reanudable y mínimo.",
  ],
};
