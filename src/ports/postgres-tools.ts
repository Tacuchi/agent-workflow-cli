/**
 * Read-only PostgreSQL operations required by the transport-neutral tools
 * catalog. The catalog owns validation and result encoding; this port owns
 * only the database seam so CLI and MCP share the exact same behavior.
 */
export interface PostgresQueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/** Optional cancellation propagated from a transport request to PostgreSQL. */
export interface PostgresQueryOptions {
  signal?: AbortSignal;
}

/** A driver-safe failure that can cross the PostgreSQL seam without secrets. */
export class PostgresToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PostgresToolError";
  }
}

export interface PostgresReadonlyPort {
  execute(sql: string, dsn: string, options?: PostgresQueryOptions): Promise<PostgresQueryResult>;
  query(
    sql: string,
    values: readonly unknown[],
    dsn: string,
    options?: PostgresQueryOptions,
  ): Promise<PostgresQueryResult>;
  inspectRole(dsn: string): Promise<PostgresRoleInspection>;
}

export interface PostgresRoleInspection {
  superuser: boolean;
  canCreateRole: boolean;
  canCreateDatabase: boolean;
  /** Effective database/schema/table write capability, not merely role flags. */
  canWrite: boolean;
  /**
   * The role can use now or belongs to a predefined server role with
   * capabilities outside a transaction's READ ONLY guarantees.
   */
  unsafeServerRole?: boolean;
  transactionReadOnly: boolean;
}
