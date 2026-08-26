/**
 * Qué puede decir la persona sobre la vía MCP en SU host, sin adivinar nada.
 *
 * Son DOS preguntas distintas y por eso van separadas: una vía puede estar
 * disponible sin estar ofrecida —el catálogo la declara pero nadie la instaló—.
 * Que el selector vaya a ser aceptado o no sólo se conoce al intentarlo, y no se
 * representa como un estado especulativo de lectura.
 */

import { isDeepStrictEqual } from "node:util";
import type { HarnessSpec } from "../../domain/harnesses.js";
import { mcpEntryShapeForHost } from "../../domain/mcp-entry.js";
import { WORKLINE_MCP_ENTRY_NAME, worklineMcpEntry } from "../../domain/workline-mcp-entry.js";
import { readMcpEntry } from "../mcp-host-reader.js";

export interface ViaAnswer {
  yes: boolean;
  /** Por qué. Presente siempre, también cuando la respuesta es que sí. */
  reason: string;
}

export interface McpViaState {
  available: ViaAnswer;
  offered: ViaAnswer;
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
    };
  }

  const available: ViaAnswer = { yes: true, reason: via.evidence };
  if (spec.mcpHostId === null) {
    const reason = "este host no tiene una configuración MCP que el CLI sepa escribir";
    return { available, offered: { yes: false, reason } };
  }

  const snapshot = readMcpEntry(spec.mcpHostId, scopeDir, WORKLINE_MCP_ENTRY_NAME, "global");
  if (!snapshot.exists) {
    if (snapshot.present) {
      return {
        available,
        offered: {
          yes: false,
          reason: `la entrada '${WORKLINE_MCP_ENTRY_NAME}' existe, pero su forma no es la generada por Workline: conflicto con una entrada ajena; no se ofrece`,
        },
      };
    }
    const reason = `la entrada '${WORKLINE_MCP_ENTRY_NAME}' no está en la configuración MCP de este host; la instalación de superficies la deja ofrecida`;
    return { available, offered: { yes: false, reason } };
  }

  const expected = mcpEntryShapeForHost(spec.mcpHostId, worklineMcpEntry(spec.mcpHostId));
  if (!isDeepStrictEqual(snapshot.raw, expected)) {
    return {
      available,
      offered: {
        yes: false,
        reason: `la entrada '${WORKLINE_MCP_ENTRY_NAME}' existe, pero su forma no es la generada por Workline: conflicto con una entrada ajena; no se ofrece`,
      },
    };
  }

  return {
    available,
    offered: { yes: true, reason: `la entrada '${WORKLINE_MCP_ENTRY_NAME}' está registrada` },
  };
}
