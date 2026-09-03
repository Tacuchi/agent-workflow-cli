import { type DoctorFinding, doctorFindingId } from "../../domain/doctor/model.js";
import { dsnKeyForInstance } from "../dsn-reader-service.js";
/**
 * Tools and authentication — bounded to what Workline itself uses.
 *
 * There is exactly one authenticable thing in this CLI today: the `DB_<X>_DSN`
 * variable behind each registered MCP connection. So this provider checks that,
 * and relays the authentication state the host reports for its own servers —
 * which is a finding about somebody else's resource and therefore never an
 * action.
 *
 * The guidance NAMES THE VARIABLE AND NEVER ITS VALUE, and it comes from
 * `buildEnvHelp`, the same help the setup path already prints. The CLI does not
 * write the DSN anywhere: custody stays with the person, which is the only way
 * a report can promise it never leaks one.
 */
import { readMcpConnections } from "../mcp-connections-service.js";
import { buildEnvHelp, isDsnVisible } from "../self/mcp-config.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "tools-auth" as const;
const SCOPE_HOST = "workspace";

export const toolsAuthProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const connections = readMcpConnections(input.ctx.paths, input.ctx.env);
    if (connections.length === 0) {
      return {
        coverage: [
          coverage(
            CATEGORY,
            SCOPE_HOST,
            "not-applicable",
            "no hay ninguna conexión registrada que requiera autenticación",
          ),
        ],
        findings: [],
      };
    }

    const findings = connections.map((connection) => dsnFinding(input, connection));
    return { coverage: [coverage(CATEGORY, SCOPE_HOST, "checked")], findings };
  },
};

function dsnFinding(
  input: DoctorProviderInput,
  connection: { name: string; dsnVar?: string },
): DoctorFinding {
  const variable = connection.dsnVar ?? dsnKeyForInstance(connection.name);
  const visible = isDsnVisible(input.ctx, variable);
  const base = {
    id: doctorFindingId(SCOPE_HOST, CATEGORY, `env:${connection.name}`),
    host: SCOPE_HOST,
    category: CATEGORY,
    resource: {
      kind: "credential" as const,
      name: variable,
      locator: input.ctx.paths.userDsnFile(),
    },
    // The evidence says PRESENT or ABSENT and stops there. Reading the value to
    // describe it would put it one redaction bug away from the report.
    //
    // The variable name is always PARENTHESIZED, and that is load-bearing: the
    // redactor treats `<something>_DSN` followed by `=`, `:` or a space as an
    // assignment and blanks whatever comes next. Naming the variable is exactly
    // what this finding owes the person, so the one place it appears has to be a
    // shape the redactor cannot read as a value — a closing paren is not a
    // separator, so `(DB_X_DSN)` survives while `DB_X_DSN: visible` does not.
    evidence: [`variable de entorno (${variable}): ${visible ? "presente" : "ausente"}`],
    ownership: "ours" as const,
  };
  if (visible) {
    return {
      ...base,
      state: "healthy",
      summary: `la conexión ${connection.name} tiene visible su variable de entorno (${variable})`,
      impact: "el MCP de esa conexión puede autenticarse cuando el host lo levante",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  const help = buildEnvHelp(variable, connection.name);
  return {
    ...base,
    state: "warning",
    summary: `la conexión ${connection.name} no puede autenticarse: falta su variable de entorno (${variable})`,
    impact: "el MCP levanta pero cualquier consulta fallará por falta de credencial",
    remediation: { kind: "manual", action: null, guidance: survivingGuidance(help) },
  };
}

/**
 * La guía de `buildEnvHelp`, reescrita para que la redacción no la vuelva dañina.
 *
 * `buildEnvHelp` emite `export DB_X_DSN='<DSN>'`, que es correcto y no lleva
 * ningún valor — pero `redactSensitiveText` lee `…_DSN=` como una asignación y
 * reemplaza lo que sigue, así que la línea LLEGA a la persona como
 * `export DB_X_DSN=***`. Quien la copie deja literalmente `***` en su archivo de
 * arranque y el MCP falla con una credencial inválida en vez de con una ausente:
 * una guía que empeora las cosas es peor que ninguna.
 *
 * Así que la línea se parte en dos: el nombre de la variable —lo único
 * accionable que este hallazgo puede dar— va parentizado, y el valor se nombra
 * como lo que es, algo que la persona pega y el CLI nunca ve. `next_step` se
 * releva tal cual: no lleva el nombre pegado a un separador.
 */
function survivingGuidance(help: ReturnType<typeof buildEnvHelp>): string[] {
  return [
    // Ojo con la prosa: cualquier aparición del token de un secreto SEGUIDA de
    // espacio se lleva la palabra siguiente. Por eso acá no se escribe la sigla
    // suelta, y el nombre de la variable va siempre entre paréntesis.
    `exportá en tu entorno la variable (${help.variable}) con la cadena de conexión; el valor lo pegás vos y el CLI no lo guarda en ningún lado`,
    `dejala en tu archivo de arranque (${startupFileOf(help)}) para que sobreviva a la próxima terminal`,
    help.next_step,
  ];
}

/** El archivo de arranque que `buildEnvHelp` nombró, o el genérico si no lo dijo. */
function startupFileOf(help: ReturnType<typeof buildEnvHelp>): string {
  const named = help.commands.find((command) => command.includes(">>"));
  const file = named?.split(">>").pop()?.trim();
  return file === undefined || file.length === 0 ? "el de tu shell" : file;
}
