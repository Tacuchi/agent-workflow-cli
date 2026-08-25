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
import type { HarnessMcpElicitation } from "./harnesses.js";

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
  lines.push("Contestá por etiqueta, o con `Aceptar recomendaciones` para tomar las primeras.");
  return lines.join("\n");
}

/**
 * Por qué no hubo elección, dicho para esta persona y en su idioma.
 *
 * El rechazo automático es el único que nombra una política y una forma de
 * arrancar: es el único que la persona no vio. Los demás describen lo que sí hizo,
 * y ninguno de los cinco avanza la frontera.
 */
export function degradationNotice(
  outcome: ElicitationOutcome["kind"],
  via: HarnessMcpElicitation,
): string {
  switch (outcome) {
    case "refused-by-host": {
      const causa = via.available
        ? `${via.blockedBy}. Para recuperarlo: ${via.recoverBy}`
        : "este host no declara la vía de selector nativo";
      // Ni un veto ni una exigencia: se nombra la causa, se nombra el remedio y el
      // trabajo sigue. Bloquear hasta que alguien cambie su política sería frenar
      // el trabajo por una preferencia de presentación.
      return `El host declinó el selector en el acto y sin mostrarte nada, así que esto NO se leyó como una decisión tuya. La causa es que ${causa}. Mientras tanto la frontera va acá abajo, completa, y el trabajo sigue.`;
    }
    case "declined-by-person":
      return "Rechazaste el selector, así que la frontera sigue pendiente y no se aplicó ninguna transición. Va acá abajo para que la contestes cuando quieras.";
    case "cancelled":
      return "Cerraste el selector sin elegir, así que la frontera sigue pendiente y no se registró ninguna elección. Va acá abajo.";
    case "empty":
      return "El selector volvió sin elección ni texto, así que la frontera sigue pendiente. Va acá abajo.";
    default:
      return "";
  }
}

/**
 * La aprobación que el host pide la primera vez, explicada donde se necesita.
 *
 * No es un impedimento: es una interacción extra que se paga una vez. Decirlo
 * antes evita que se lea como una falla de la vía justo cuando está funcionando.
 */
export const APPROVAL_NOTICE =
  "La primera vez, tu host te va a pedir que autorices esta herramienta. Podés persistir esa autorización para la sesión y no vuelve a interrumpir en las fronteras siguientes.";
