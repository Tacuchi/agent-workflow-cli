/**
 * Qué puede decir la persona sobre la vía MCP en SU host, sin adivinar nada.
 *
 * Son TRES preguntas distintas y por eso van separadas: una vía puede estar
 * disponible sin estar ofrecida —el catálogo la declara pero nadie la instaló— y
 * ofrecida sin ser utilizable —está registrada pero la política con que arrancó el
 * host la anula—. Colapsarlas en un sí o un no dejaría a la persona sin saber cuál
 * de las tres arreglar.
 */

import type { HarnessSpec } from "../../domain/harnesses.js";
import { WORKLINE_MCP_ENTRY_NAME } from "../../domain/workline-mcp-entry.js";
import { readMcpEntry } from "../mcp-host-reader.js";

export interface ViaAnswer {
  yes: boolean;
  /** Por qué. Presente siempre, también cuando la respuesta es que sí. */
  reason: string;
}

export interface McpViaState {
  available: ViaAnswer;
  offered: ViaAnswer;
  usable: ViaAnswer;
}

export function readMcpViaState(spec: HarnessSpec, scopeDir: string): McpViaState {
  const via = spec.structuredChoice.mcpElicitation;
  if (!via.available) {
    // No disponible y NO desconocido: la diferencia importa. Que nadie la haya
    // observado en este host no es lo mismo que haberla observado y que falle, y
    // decir «desconocido» invitaría a suponer la que no se probó.
    const reason = `no se declara en este host: ${via.reason}`;
    return {
      available: { yes: false, reason },
      offered: { yes: false, reason: "no se ofrece una vía que el host no declara" },
      usable: { yes: false, reason },
    };
  }

  const available: ViaAnswer = { yes: true, reason: via.evidence };
  if (spec.mcpHostId === null) {
    const reason = "este host no tiene una configuración MCP que el CLI sepa escribir";
    return { available, offered: { yes: false, reason }, usable: { yes: false, reason } };
  }

  const snapshot = readMcpEntry(spec.mcpHostId, scopeDir, WORKLINE_MCP_ENTRY_NAME, "global");
  if (!snapshot.exists) {
    const reason = `la entrada '${WORKLINE_MCP_ENTRY_NAME}' no está en la configuración MCP de este host; la instalación de superficies la deja ofrecida`;
    return { available, offered: { yes: false, reason }, usable: { yes: false, reason } };
  }

  return {
    available,
    offered: { yes: true, reason: `la entrada '${WORKLINE_MCP_ENTRY_NAME}' está registrada` },
    // Utilizable es lo único que NO se puede afirmar leyendo: lo decide la política
    // con que se arrancó el host, y eso sólo se sabe al pedir la elección. Se
    // contesta que sí y se nombra lo único que puede desmentirlo, en vez de fingir
    // una certeza que ninguna lectura da.
    usable: {
      yes: true,
      reason: `sí, salvo que ${via.blockedBy} — eso sólo se sabe al pedir la primera elección, y si pasa: ${via.recoverBy}`,
    },
  };
}
