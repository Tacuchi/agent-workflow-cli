/**
 * Lo que la persona lee cuando la vía nativa no rindió una elección.
 *
 * La degradación dejó de ser un aviso de pérdida y pasó a ser accionable, y eso
 * son dos cosas distintas que este módulo produce juntas: la CAUSA —dicha sin
 * atribuirle a nadie una decisión que no tomó— y la frontera ENTERA en markdown
 * etiquetado, sin perder una sola alternativa.
 *
 * Que el markdown se genere del MISMO dato que la solicitud nativa es la garantía
 * de AC-02: si se redactara aparte, las dos presentaciones podrían diferir y la
 * degradada sería la que pierde algo. Acá degrada el mecanismo y nunca el contenido.
 */

import { type BoundaryQuestion, type ElicitationOutcome, orderedOptions } from "./elicitation.js";

/**
 * La frontera entera, en el piso universal.
 *
 * Cada alternativa con su consecuencia, la recomendada primera y el control de
 * flujo entre las opciones — el mismo orden que la vía nativa, porque sale de la
 * misma función que lo ordena.
 */
export function renderLabeledMarkdown(questions: readonly BoundaryQuestion[]): string {
  const lines: string[] = [];
  for (const question of questions) {
    lines.push(`**${question.header} — ${question.question}**`, "");
    for (const option of orderedOptions(question)) {
      const mark = option.recommended === true ? " _(recomendada)_" : "";
      lines.push(`- ${option.label} — ${option.consequence}${mark}`);
    }
    lines.push("");
  }
  lines.push("Answer by label, or with `Aceptar recomendaciones` to take every first option.");
  return lines.join("\n");
}

/**
 * Por qué no hubo elección, dicho para el AGENTE que lo va a presentar.
 *
 * En inglés como el resto del catálogo y del estampado, y no en el idioma de la
 * persona, porque esto es dato de protocolo que el agente relaya: quien traduce a
 * la persona es él, y mezclar los dos idiomas a mitad de oración —que es lo que
 * pasaba al componer castellano alrededor de campos ingleses del catálogo— se lee
 * peor que cualquiera de los dos. Las etiquetas de las alternativas siguen viniendo
 * de quien llama, así que ésas ya están en el idioma de la persona.
 *
 * El protocolo no prueba si una negativa o cancelación vino de una política del
 * host o de una persona. Los dos casos quedan sin atribuir, y ninguno avanza la
 * frontera.
 */
export function degradationNotice(outcome: ElicitationOutcome["kind"]): string {
  switch (outcome) {
    case "declined":
      return "The selector reported a decline, so the boundary stays pending and no transition was applied. Present it below so it can be answered explicitly.";
    case "cancelled":
      return "The selector reported a cancellation without a choice, so the boundary stays pending. Present it below.";
    case "empty":
      return "The selector came back with neither a choice nor any text, so the boundary stays pending. Present it below.";
    default:
      return "";
  }
}
