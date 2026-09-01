import { Client } from "pg";
import Cursor from "pg-cursor";
import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_ROWS } from "../domain/database-tools.js";
import type {
  PostgresQueryOptions,
  PostgresQueryResult,
  PostgresQueryWarning,
  PostgresReadonlyPort,
  PostgresRoleInspection,
} from "../ports/postgres-tools.js";
import { PostgresToolError } from "../ports/postgres-tools.js";

const CONNECTION_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * The PostgreSQL adapter owns the safety envelope for every catalog call:
 * connection lifetime, transaction read-only state, timeout, bounded rows and
 * disposal. It never returns a driver error or DSN to the caller.
 */
export class PostgresReadonlyTools implements PostgresReadonlyPort {
  async execute(
    sql: string,
    dsn: string,
    options: PostgresQueryOptions = {},
  ): Promise<PostgresQueryResult> {
    return await this.readWithRoleWarnings(
      dsn,
      async (client) => await readBoundedCursor(client, sql, [], options.signal),
      ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
    );
  }

  async query(
    sql: string,
    values: readonly unknown[],
    dsn: string,
    options: PostgresQueryOptions = {},
  ): Promise<PostgresQueryResult> {
    return await this.readWithRoleWarnings(
      dsn,
      async (client) => await readBoundedCursor(client, sql, values, options.signal),
      ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
    );
  }

  async inspectRole(dsn: string): Promise<PostgresRoleInspection> {
    return await this.withReadonlyClient(dsn, async (client) => {
      const result = await client.query<{
        superuser: boolean;
        can_create_role: boolean;
        can_create_database: boolean;
        can_write: boolean;
        unsafe_server_role: boolean;
      }>(
        `SELECT
           r.rolsuper AS superuser,
           r.rolcreaterole AS can_create_role,
           r.rolcreatedb AS can_create_database,
           (
             has_database_privilege(current_database(), 'CREATE')
             OR EXISTS (
               SELECT 1 FROM pg_namespace n
               WHERE has_schema_privilege(n.oid, 'CREATE')
             )
             OR EXISTS (
               SELECT 1 FROM pg_class c
               WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
                 AND (
                   has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                   OR has_any_column_privilege(c.oid, 'INSERT, UPDATE')
                 )
             )
             OR EXISTS (
               SELECT 1 FROM pg_class sequence_class
               WHERE sequence_class.relkind = 'S'
                 AND has_sequence_privilege(sequence_class.oid, 'UPDATE')
             )
           ) AS can_write,
           COALESCE(
             (
               SELECT bool_or(
                 pg_has_role(current_user, dangerous_role.oid, 'USAGE')
                 OR pg_has_role(current_user, dangerous_role.oid, 'MEMBER')
               )
               FROM pg_roles dangerous_role
               WHERE dangerous_role.rolname IN (
                 'pg_signal_backend',
                 'pg_signal_autovacuum_worker',
                 'pg_read_server_files',
                 'pg_write_server_files',
                 'pg_execute_server_program'
               )
             ),
             false
           ) AS unsafe_server_role
         FROM pg_roles r
         WHERE r.rolname = current_user`,
      );
      const role = result.rows[0];
      if (role === undefined) {
        throw new PostgresToolError(
          "DATABASE_ROLE_UNKNOWN",
          "No se pudo verificar el rol PostgreSQL.",
        );
      }
      return {
        superuser: role.superuser,
        canCreateRole: role.can_create_role,
        canCreateDatabase: role.can_create_database,
        canWrite: role.can_write,
        unsafeServerRole: role.unsafe_server_role,
        transactionReadOnly: true,
      };
    });
  }

  private async readWithRoleWarnings(
    dsn: string,
    work: (client: Client) => Promise<PostgresQueryResult>,
    options: ReadonlyClientOptions = {},
  ): Promise<PostgresQueryResult> {
    return await this.withReadonlyClient(
      dsn,
      async (client) => {
        const warnings = await inspectExecutionRoleWarnings(client);
        const result = await work(client);
        return warnings.length === 0 ? result : { ...result, warnings };
      },
      options,
    );
  }

  private async withReadonlyClient<T>(
    dsn: string,
    work: (client: Client) => Promise<T>,
    options: ReadonlyClientOptions = {},
  ): Promise<T> {
    const client = new Client({
      connectionString: dsn,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    // A connected pg client can emit a later socket error after rejecting the
    // active query. Keep it from becoming an unhandled EventEmitter error; the
    // awaited operation below still maps it to a secret-free tool failure.
    client.on("error", () => {});
    let transactionStarted = false;
    let connected = false;
    const abort = (): void => {
      // Calls use an isolated client, so destroying it is a reliable PostgreSQL
      // cancellation mechanism. It avoids `pg`'s `Client.cancel` trap, whose
      // receiver must be a separate control client and can otherwise corrupt
      // the active connection. The server rolls the read-only transaction back.
      void client.end().catch(() => undefined);
    };
    if (options.signal?.aborted) throw queryCancelled();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      connected = true;
      await client.query("SET default_transaction_read_only = on");
      await client.query("BEGIN READ ONLY");
      transactionStarted = true;
      const readOnly = await client.query<{ transaction_read_only: string }>(
        "SHOW transaction_read_only",
      );
      if (readOnly.rows[0]?.transaction_read_only !== "on") {
        throw new PostgresToolError(
          "READ_ONLY_POLICY",
          "PostgreSQL no confirmó una transacción de solo lectura.",
        );
      }
      await client.query("SET LOCAL statement_timeout = '30s'");
      return await work(client);
    } catch (error) {
      if (options.signal?.aborted) throw queryCancelled();
      if (error instanceof PostgresToolError) throw error;
      throw safeDriverError(error, connected);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      // An abort tears down this per-call socket, which makes PostgreSQL roll
      // the transaction back itself. Do not issue a query or wait for cursor
      // cleanup on a connection that intentionally cannot become ready again.
      if (transactionStarted && !options.signal?.aborted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      await client.end().catch(() => undefined);
    }
  }
}

async function readBoundedCursor(
  client: Client,
  sql: string,
  values: readonly unknown[],
  signal: AbortSignal | undefined,
): Promise<PostgresQueryResult> {
  if (signal?.aborted) throw queryCancelled();
  const cursor = client.query(new Cursor<Record<string, unknown>>(sql, [...values]));
  const cancel = (): void => {
    // `withReadonlyClient` also observes this signal during connection/setup.
    // Keep the cursor listener so a live read is terminated immediately.
    void client.end().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let closeCursor = true;
  try {
    return await readCursorRows(cursor, signal);
  } catch (error) {
    closeCursor = closesActiveCursorAfter(error);
    if (signal?.aborted) throw queryCancelled();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    // pg-cursor close waits for ReadyForQuery. After explicit cancellation the
    // isolated client socket was destroyed, so waiting here would turn a
    // successful cancel into a hung finally; the client teardown owns cleanup.
    // pg-cursor sends ReadyForQuery itself after a query error. Calling close
    // after its read promise rejects can subscribe too late and wait forever
    // for a second ReadyForQuery. The isolated transaction rollback below owns
    // cleanup in that case; close only when the portal still needs a Close +
    // Sync (normal completion or a local size-bound rejection).
    if (!signal?.aborted && closeCursor) await cursor.close().catch(() => undefined);
  }
}

function closesActiveCursorAfter(error: unknown): boolean {
  // A result-size rejection originates locally while the cursor portal is
  // still active, so Close + Sync is required before ROLLBACK can proceed.
  // PostgreSQL errors already emitted their own Sync; closing then can wait for
  // a second ReadyForQuery that never arrives.
  return error instanceof PostgresToolError && error.code === "RESULT_TOO_LARGE";
}

function queryCancelled(): PostgresToolError {
  return new PostgresToolError("QUERY_CANCELLED", "La consulta fue cancelada.");
}

interface ReadonlyClientOptions {
  signal?: AbortSignal;
}

async function inspectExecutionRoleWarnings(client: Client): Promise<PostgresQueryWarning[]> {
  const result = await client.query<{ superuser: boolean; unsafe_server_role: boolean }>(
    `SELECT
       role_info.rolsuper AS superuser,
       COALESCE(
         (
           SELECT bool_or(
             pg_has_role(current_user, dangerous_role.oid, 'USAGE')
             OR pg_has_role(current_user, dangerous_role.oid, 'MEMBER')
           )
           FROM pg_roles dangerous_role
           WHERE dangerous_role.rolname IN (
             'pg_signal_backend',
             'pg_signal_autovacuum_worker',
             'pg_read_server_files',
             'pg_write_server_files',
             'pg_execute_server_program'
           )
         ),
         false
       ) AS unsafe_server_role
     FROM pg_roles role_info
     WHERE role_info.rolname = current_user`,
  );
  const role = result.rows[0];
  if (role === undefined) {
    throw new PostgresToolError(
      "DATABASE_ROLE_UNKNOWN",
      "No se pudo verificar la seguridad del rol PostgreSQL.",
    );
  }
  return warningsFromExecutionRole(role);
}

export function warningsFromExecutionRole(role: {
  superuser: boolean;
  unsafe_server_role: boolean;
}): PostgresQueryWarning[] {
  if (!role.superuser && !role.unsafe_server_role) return [];
  const risk = role.superuser
    ? role.unsafe_server_role
      ? "es superusuario y dispone de privilegios de servidor peligrosos"
      : "es superusuario"
    : "dispone de privilegios de servidor peligrosos";
  return [
    {
      code: "DATABASE_ROLE_UNSAFE",
      message: `El rol PostgreSQL ${risk}; la lectura continúa dentro de una transacción READ ONLY.`,
    },
  ];
}

async function readCursorRows(
  cursor: Cursor<Record<string, unknown>>,
  signal: AbortSignal | undefined,
): Promise<PostgresQueryResult> {
  const rows: Record<string, unknown>[] = [];
  // Track the JSON representation as rows arrive. `DatabaseToolCatalog` makes
  // the final exact 4 MiB decision once it adds the canonical envelope, while
  // this transport-level bound prevents a 1001-row cursor result from being
  // accumulated in memory first.
  let serializedBytes = 2; // []
  while (rows.length <= MAX_TOOL_ROWS) {
    const batch = await cursor.read(1);
    if (signal?.aborted) throw queryCancelled();
    const row = batch[0];
    if (row === undefined) return { rows, truncated: false };
    if (rows.length === MAX_TOOL_ROWS) return { rows, truncated: true };
    serializedBytes += serializedRowBytes(row) + (rows.length === 0 ? 0 : 1);
    if (serializedBytes > MAX_TOOL_RESULT_BYTES) {
      throw new PostgresToolError("RESULT_TOO_LARGE", "El resultado serializado supera 4 MiB.");
    }
    rows.push(row);
  }
  return { rows, truncated: true };
}

function serializedRowBytes(row: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(row), "utf8");
  } catch {
    throw new PostgresToolError(
      "RESULT_TOO_LARGE",
      "El resultado no se puede serializar de forma segura.",
    );
  }
}

function safeDriverError(error: unknown, connected: boolean): PostgresToolError {
  const code = readDriverCode(error);
  if (!connected) {
    return new PostgresToolError(
      "DATABASE_CONNECTION_FAILED",
      "No se pudo abrir la conexión PostgreSQL.",
    );
  }
  if (code === "42601") {
    return new PostgresToolError("INVALID_SQL", "La consulta PostgreSQL tiene sintaxis inválida.");
  }
  if (code === "57014") {
    return new PostgresToolError("QUERY_TIMEOUT", "La consulta excedió el límite de 30 segundos.");
  }
  if (code === "25006") {
    return new PostgresToolError(
      "READ_ONLY_POLICY",
      "PostgreSQL rechazó una operación fuera de la transacción de solo lectura.",
    );
  }
  if (code?.startsWith("28") || code === "3D000") {
    return new PostgresToolError(
      "DATABASE_CONNECTION_FAILED",
      "No se pudo autenticar o abrir la base de datos.",
    );
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ERR_INVALID_URL"
  ) {
    return new PostgresToolError(
      "DATABASE_CONNECTION_FAILED",
      "No se pudo abrir la conexión PostgreSQL.",
    );
  }
  return new PostgresToolError(
    "DATABASE_QUERY_FAILED",
    "PostgreSQL no pudo completar la operación.",
  );
}

function readDriverCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
