import { describe, expect, it } from "vitest";
import {
  type BoundaryQuestion,
  CHOICE_KEY,
  FLOW_CONTROL,
  FREE_TEXT_KEY,
  classifyElicitationReply,
  elicitationRequestsFor,
  isFlowControl,
  orderedOptions,
} from "../../src/domain/elicitation.js";

/**
 * La traducción de una frontera al vocabulario que un cliente MCP renderiza, y la
 * lectura de lo que responde.
 *
 * Lo que estas pruebas defienden no es la forma del JSON: es que una frontera
 * presentada por esta vía NO pierda nada de lo que la doctrina exige —cada
 * alternativa con su consecuencia, la recomendada primera, el control de flujo
 * alcanzable y la posibilidad de responder algo distinto— y que ninguna respuesta
 * que no sea una elección se lea como una.
 */
const FRONTERA: BoundaryQuestion[] = [
  {
    header: "Commit",
    question: "¿Aprobás los commits del batch?",
    options: [
      { label: "Dejar sin commitear", consequence: "los cambios quedan en el árbol de trabajo" },
      {
        label: "Aprobar los commits",
        consequence: "un commit por fuente afectada",
        recommended: true,
      },
    ],
  },
  {
    header: "Integrar",
    question: "¿Integro la unidad?",
    options: [
      { label: "Integrar", consequence: "se mergea a la rama de trabajo", recommended: true },
      { label: "Dejar separada", consequence: "queda sin integrar en esta iteración" },
    ],
  },
];

const VALID_CHOICES = orderedOptions(FRONTERA[0] as BoundaryQuestion).map((option) => option.label);

describe("una frontera dicha en el vocabulario de elicitation", () => {
  it("emite UNA solicitud por pregunta, numerada sobre el total", () => {
    const requests = elicitationRequestsFor(FRONTERA);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.message).toBe("¿Aprobás los commits del batch? (1/2)");
    expect(requests[1]?.message).toBe("¿Integro la unidad? (2/2)");
  });

  it("pone la recomendada primera, aunque venga segunda", () => {
    const options = orderedOptions(FRONTERA[0] as BoundaryQuestion);

    // La doctrina pide exactamente una recomendada y en primer lugar: si llegara
    // en el medio, la persona leería primero una alternativa que nadie sugirió.
    expect(options[0]?.label).toBe("Aprobar los commits");
    expect(options[1]?.label).toBe("Dejar sin commitear");
  });

  it("lleva el control de flujo DENTRO de cada solicitud, no al final del recorrido", () => {
    const requests = elicitationRequestsFor(FRONTERA);

    for (const request of requests) {
      const values = (request.requestedSchema.properties[CHOICE_KEY] as { enum: string[] }).enum;
      // Con una solicitud por pregunta, un control de flujo que llegara último
      // aparecería cuando ya no sirve para pausar nada: tiene que estar en la
      // primera pregunta y en todas.
      expect(values).toContain("Compactar");
      expect(values).toContain("Cerrar");
    }
    expect(FLOW_CONTROL.every((option) => isFlowControl(option.label))).toBe(true);
    expect(isFlowControl("Aprobar los commits")).toBe(false);
  });

  it("no pierde ninguna consecuencia: cada alternativa la lleva pegada a su etiqueta", () => {
    const [first] = elicitationRequestsFor(FRONTERA);
    const names = (first?.requestedSchema.properties[CHOICE_KEY] as { enumNames: string[] })
      .enumNames;

    // El esquema da UN solo texto visible por alternativa, así que la consecuencia
    // viaja ahí. Dejarla afuera sería degradar el contenido, no el mecanismo.
    expect(names[0]).toBe("Aprobar los commits — un commit por fuente afectada");
    expect(names[1]).toBe("Dejar sin commitear — los cambios quedan en el árbol de trabajo");
    expect(names).toHaveLength(4);
  });

  it("conserva la respuesta libre, y como campo aparte en vez de una alternativa falsa", () => {
    const [first] = elicitationRequestsFor(FRONTERA);
    const schema = first?.requestedSchema;

    // Un `enum` rinde un selector cerrado. Sin este segundo campo la frontera
    // perdería «responder algo distinto», que la doctrina exige.
    expect(schema?.properties[FREE_TEXT_KEY]).toBeDefined();
    expect(schema?.required).toBeUndefined();
    const values = (schema?.properties[CHOICE_KEY] as { enum: string[] }).enum;
    expect(values).not.toContain("Otra");
  });
});

describe("qué volvió: una elección, o por qué no la hubo", () => {
  it("una aceptación con la elección puesta ES la elección", () => {
    const outcome = classifyElicitationReply(
      { action: "accept", content: { [CHOICE_KEY]: "Aprobar los commits" } },
      VALID_CHOICES,
    );

    expect(outcome).toEqual({ kind: "chosen", choice: "Aprobar los commits", free: false });
  });

  it("una aceptación con SOLO texto libre también es una elección, y se marca como tal", () => {
    const outcome = classifyElicitationReply(
      { action: "accept", content: { [FREE_TEXT_KEY]: "  commiteá pero sin integrar  " } },
      VALID_CHOICES,
    );

    expect(outcome).toEqual({ kind: "chosen", choice: "commiteá pero sin integrar", free: true });
  });

  it("una aceptación vacía no es una elección", () => {
    const outcome = classifyElicitationReply(
      { action: "accept", content: { [CHOICE_KEY]: "   " } },
      VALID_CHOICES,
    );

    // AC-05: una respuesta vacía no avanza la frontera ni deja registrada una
    // elección que la persona no hizo.
    expect(outcome).toEqual({ kind: "empty" });
  });

  it("una respuesta libre tiene prioridad sobre una elección válida", () => {
    const outcome = classifyElicitationReply(
      {
        action: "accept",
        content: { [CHOICE_KEY]: "Aprobar los commits", [FREE_TEXT_KEY]: "hacelo sin push" },
      },
      VALID_CHOICES,
    );

    expect(outcome).toEqual({ kind: "chosen", choice: "hacelo sin push", free: true });
  });

  it("una etiqueta que no estaba entre las alternativas no avanza la frontera", () => {
    const outcome = classifyElicitationReply(
      { action: "accept", content: { [CHOICE_KEY]: "inventada" } },
      VALID_CHOICES,
    );

    expect(outcome).toEqual({ kind: "empty" });
  });

  it("un decline queda sin atribución temporal", () => {
    const outcome = classifyElicitationReply({ action: "decline" }, VALID_CHOICES);

    expect(outcome).toEqual({ kind: "declined" });
  });

  it("una cancelación queda sin atribución temporal", () => {
    const outcome = classifyElicitationReply({ action: "cancel" }, VALID_CHOICES);

    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("una respuesta que no tiene forma de respuesta no inventa una elección", () => {
    for (const basura of [null, undefined, 42, "accept", {}, { action: 7 }]) {
      const outcome = classifyElicitationReply(basura, VALID_CHOICES);
      expect(outcome.kind).not.toBe("chosen");
    }
  });
});
