/**
 * Una frontera humana, dicha en el vocabulario que un cliente MCP sabe renderizar.
 *
 * El problema que resuelve: en un host cuya herramienta de preguntas no figura
 * entre las del turno, una frontera degradaba a markdown aunque el host SÍ supiera
 * rendir un selector nativo. Su cliente anuncia `elicitation`, y una solicitud
 * genérica del protocolo —sin un solo campo interno del host— renderiza un
 * selector con título, descripción, alternativas navegables, confirmación y
 * cancelación. Esto traduce una frontera a esas solicitudes y traduce de vuelta lo
 * que responden.
 *
 * Todo acá es puro: no habla el protocolo ni toca entrada o salida. La respuesta
 * sólo acredita lo que trae el protocolo; no se infiere quién la produjo por su
 * tiempo de llegada.
 */

/**
 * El control de flujo, que la doctrina exige en TODA frontera con alternativas.
 *
 * Lo pone este módulo y no quien llama, y ésa es la garantía: una frontera que
 * nadie puede pausar ni abandonar no es una pregunta, y dejarlo en manos del
 * llamador lo convierte en algo que se puede olvidar. Va DENTRO de las opciones de
 * cada solicitud —no como una pregunta final— porque acá cada pregunta viaja en su
 * propia solicitud: al final llegaría cuando ya no sirve para pausar nada.
 */
export const FLOW_CONTROL: readonly BoundaryOption[] = [
  {
    label: "Compactar",
    consequence:
      "se persiste el CHECKPOINT y la corrida retoma en esta misma frontera después de compactar el contexto",
  },
  {
    label: "Cerrar",
    consequence: "se cierra la sesión y se conserva lo pendiente para retomarlo al reabrir",
  },
];

/** Una alternativa: su etiqueta semántica y qué pasa si se elige. */
export interface BoundaryOption {
  label: string;
  consequence: string;
  /** Exactamente una por pregunta, y va primera. */
  recommended?: boolean;
}

export interface BoundaryQuestion {
  /** Rótulo corto de la pregunta. */
  header: string;
  question: string;
  options: readonly BoundaryOption[];
}

/**
 * El campo donde vuelve la elección. Fijo, porque el servidor lee la respuesta por
 * esta clave y una clave por pregunta sería un acuerdo que se puede desincronizar.
 */
export const CHOICE_KEY = "eleccion";

/** Free text travels in a separate request, only after the person asks to write. */
export const FREE_TEXT_KEY = "otra_respuesta";

export const FREE_TEXT_OPTION: BoundaryOption = {
  label: "Escribir otra respuesta",
  consequence: "abre un campo para responder con tus propias palabras",
};

export interface ElicitationRequest {
  message: string;
  requestedSchema: {
    type: "object";
    /** Each request asks for a single field: either a selection or free text. */
    required?: readonly string[];
    properties: Record<string, unknown>;
  };
}

/** `true` cuando la etiqueta es del control de flujo y no una alternativa de contenido. */
export function isFlowControl(label: string): boolean {
  return FLOW_CONTROL.some((option) => option.label === label);
}

/**
 * Las alternativas de una pregunta en el orden en que se muestran.
 *
 * La recomendada va primera —la doctrina pide exactamente una y en primer lugar—,
 * el resto conserva el orden que trajo, y el control de flujo cierra. Se ordena acá
 * y no al renderizar para que el orden sea una propiedad del dato y no un cuidado
 * que cada superficie tenga que repetir.
 */
export function orderedOptions(question: BoundaryQuestion): BoundaryOption[] {
  const recommended = question.options.filter((option) => option.recommended === true);
  const rest = question.options.filter((option) => option.recommended !== true);
  return [...recommended, ...rest, ...FLOW_CONTROL];
}

/**
 * Una solicitud por pregunta, cada una completa en sí misma.
 *
 * Podrían ir todas en una sola —el selector admite varios campos— y aun así van
 * separadas: es la forma elegida para esta vía. Lo que la hace honesta es que el
 * control de flujo viaja en CADA una, así que pausar o cerrar es alcanzable en la
 * primera pregunta y no sólo después de atravesarlas todas.
 *
 * La consecuencia viaja pegada a la etiqueta porque el esquema de elicitation da
 * un solo texto visible por alternativa: no hay campo aparte donde ponerla, y
 * dejarla afuera perdería contenido, que es justo lo que la degradación no puede
 * hacer.
 */
export function elicitationRequestsFor(
  questions: readonly BoundaryQuestion[],
): ElicitationRequest[] {
  return questions.map((question, index) => {
    // Codex renders even optional properties as additional form steps. Keep the
    // ordinary path to one field; the server handles the explicit writing action.
    const options = [...orderedOptions(question), FREE_TEXT_OPTION];
    return {
      message: `${question.question} (${index + 1}/${questions.length})`,
      requestedSchema: {
        type: "object" as const,
        required: [CHOICE_KEY],
        properties: {
          [CHOICE_KEY]: {
            type: "string",
            title: question.header,
            description: question.question,
            enum: options.map((option) => option.label),
            enumNames: options.map((option) => `${option.label} — ${option.consequence}`),
          },
        },
      },
    };
  });
}

/** Preserve the original question and position while asking for the opted-in text. */
export function freeTextRequestFor(message: string): ElicitationRequest {
  return {
    message,
    requestedSchema: {
      type: "object",
      required: [FREE_TEXT_KEY],
      properties: {
        [FREE_TEXT_KEY]: {
          type: "string",
          title: "Otra respuesta",
          description:
            "Escribe tu respuesta. También puedes escribir Compactar o Cerrar para detener el recorrido.",
        },
      },
    },
  };
}

export type ElicitationOutcome =
  /** La persona eligió. `free` es true cuando escribió en vez de elegir. */
  | { kind: "chosen"; choice: string; free: boolean }
  /** El protocolo informó una negativa, sin atribuirla a host ni persona. */
  | { kind: "declined" }
  /** El protocolo informó una cancelación, sin atribuirla a host ni persona. */
  | { kind: "cancelled" }
  /** Aceptó sin contestar nada: ni elección ni texto. */
  | { kind: "empty" };

/**
 * Qué fue lo que volvió, dicho una sola vez para que nadie lo interprete de nuevo.
 *
 * Una respuesta libre no vacía tiene prioridad, porque expresa con más precisión
 * que un enum. Si no la hay, una etiqueta sólo es elección cuando pertenece a la
 * pregunta presentada; una etiqueta inventada nunca avanza la frontera.
 */
export function classifyElicitationReply(
  reply: unknown,
  validChoices: readonly string[],
): ElicitationOutcome {
  const action = actionOf(reply);
  if (action === "accept") {
    const content = contentOf(reply);
    const free = stringAt(content, FREE_TEXT_KEY);
    if (free !== null) return { kind: "chosen", choice: free, free: true };
    const choice = stringAt(content, CHOICE_KEY);
    if (choice !== null && validChoices.includes(choice)) {
      return { kind: "chosen", choice, free: false };
    }
    return { kind: "empty" };
  }
  if (action === "decline") return { kind: "declined" };
  return { kind: "cancelled" };
}

function actionOf(reply: unknown): string {
  if (reply === null || typeof reply !== "object") return "cancel";
  const action = (reply as Record<string, unknown>).action;
  return typeof action === "string" ? action : "cancel";
}

function contentOf(reply: unknown): Record<string, unknown> {
  if (reply === null || typeof reply !== "object") return {};
  const content = (reply as Record<string, unknown>).content;
  return content !== null && typeof content === "object"
    ? (content as Record<string, unknown>)
    : {};
}

/** El texto de una clave, o `null` cuando falta o está en blanco. */
function stringAt(content: Record<string, unknown>, key: string): string | null {
  const value = content[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
