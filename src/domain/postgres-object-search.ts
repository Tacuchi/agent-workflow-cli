import type { SearchObjectsInput } from "./database-tools.js";

export interface PostgresObjectSearchQuery {
  sql: string;
  values: readonly unknown[];
}

const EXCLUDED_SCHEMAS = "'pg_catalog', 'information_schema', 'pg_toast'";

/**
 * Builds the PostgreSQL equivalents of DBHub 1.2.1's object discovery
 * queries. All user-provided filters remain placeholders; the only SQL text
 * selected here comes from the closed tool schema.
 */
export function buildPostgresObjectSearchQuery(
  input: SearchObjectsInput,
): PostgresObjectSearchQuery {
  switch (input.object_type) {
    case "schema":
      return schemaQuery(input);
    case "table":
      return relationQuery(input, "table");
    case "view":
      return relationQuery(input, "view");
    case "column":
      return columnQuery(input);
    case "procedure":
      return routineQuery(input, "procedure");
    case "function":
      return routineQuery(input, "function");
    case "index":
      return indexQuery(input);
  }
}

/**
 * `pg` maps nullable catalog columns to null, while DBHub omits optional
 * comment/description/routine fields. Keep required nullable fields such as
 * `row_count` and `default` intact so the public shape stays compatible.
 */
export function normalizePostgresObjectSearchRows(
  _input: SearchObjectsInput,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized = { ...row };
    dropOptional(normalized, "comment");
    dropOptional(normalized, "description");
    dropOptional(normalized, "return_type");
    dropOptional(normalized, "definition");
    return normalized;
  });
}

function dropOptional(row: Record<string, unknown>, field: string): void {
  const value = row[field];
  if (value === null || value === undefined || value === "") delete row[field];
}

function schemaQuery(input: SearchObjectsInput): PostgresObjectSearchQuery {
  if (input.detail_level === "names") {
    return {
      sql: `SELECT schema_info.schema_name AS name
            FROM information_schema.schemata schema_info
            WHERE schema_info.schema_name NOT IN (${EXCLUDED_SCHEMAS})
              AND schema_info.schema_name ILIKE $1
            ORDER BY schema_info.schema_name ASC
            LIMIT $2`,
      values: [input.pattern, input.limit],
    };
  }
  return {
    sql: `SELECT schema_info.schema_name AS name,
                 count(table_info.table_name)::integer AS table_count
          FROM information_schema.schemata schema_info
          LEFT JOIN information_schema.tables table_info
            ON table_info.table_schema = schema_info.schema_name
           AND table_info.table_type = 'BASE TABLE'
          WHERE schema_info.schema_name NOT IN (${EXCLUDED_SCHEMAS})
            AND schema_info.schema_name ILIKE $1
          GROUP BY schema_info.schema_name
          ORDER BY schema_info.schema_name ASC
          LIMIT $2`,
    values: [input.pattern, input.limit],
  };
}

function relationQuery(
  input: SearchObjectsInput,
  objectType: "table" | "view",
): PostgresObjectSearchQuery {
  const values: unknown[] = [input.pattern];
  const conditions = [
    `relation_info.table_type = '${objectType === "table" ? "BASE TABLE" : "VIEW"}'`,
    `relation_info.table_schema NOT IN (${EXCLUDED_SCHEMAS})`,
    "relation_info.table_name ILIKE $1",
  ];
  if (input.schema !== undefined) {
    values.push(input.schema);
    conditions.push(`relation_info.table_schema = $${values.length}`);
  }
  values.push(input.limit);
  return {
    sql: `SELECT ${relationFields(objectType, input.detail_level)}
          FROM information_schema.tables relation_info
          JOIN pg_catalog.pg_namespace relation_namespace
            ON relation_namespace.nspname = relation_info.table_schema
          JOIN pg_catalog.pg_class relation_class
            ON relation_class.relnamespace = relation_namespace.oid
           AND relation_class.relname = relation_info.table_name
          WHERE ${conditions.join(" AND ")}
          ORDER BY relation_info.table_schema ASC, relation_info.table_name ASC
          LIMIT $${values.length}`,
    values,
  };
}

function relationFields(
  objectType: "table" | "view",
  detail: SearchObjectsInput["detail_level"],
): string {
  const names = "relation_info.table_name AS name, relation_info.table_schema AS schema";
  if (detail === "names") return names;

  const summary = [
    names,
    `(
       SELECT count(*)::integer
       FROM information_schema.columns column_info
       WHERE column_info.table_schema = relation_info.table_schema
         AND column_info.table_name = relation_info.table_name
     ) AS column_count`,
    ...(objectType === "table"
      ? [
          `CASE
             WHEN relation_class.reltuples >= 0 THEN relation_class.reltuples::bigint::double precision
             ELSE NULL
           END AS row_count`,
        ]
      : []),
    "obj_description(relation_class.oid, 'pg_class') AS comment",
  ];
  if (detail === "summary") return summary.join(",\n                 ");

  const columns = `COALESCE((
       SELECT jsonb_agg(
                jsonb_build_object(
                  'name', column_info.column_name,
                  'type', column_info.data_type,
                  'nullable', column_info.is_nullable = 'YES',
                  'default', column_info.column_default
                ) || CASE
                       WHEN column_description.description IS NULL THEN '{}'::jsonb
                       ELSE jsonb_build_object('description', column_description.description)
                     END
                ORDER BY column_info.ordinal_position
              )
       FROM information_schema.columns column_info
       LEFT JOIN pg_catalog.pg_description column_description
         ON column_description.objoid = relation_class.oid
        AND column_description.objsubid = column_info.ordinal_position
       WHERE column_info.table_schema = relation_info.table_schema
         AND column_info.table_name = relation_info.table_name
     ), '[]'::jsonb) AS columns`;
  const indexes =
    objectType === "table"
      ? `COALESCE((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'name', index_info.name,
                      'columns', index_info.columns,
                      'unique', index_info.unique,
                      'primary', index_info.primary
                    )
                    ORDER BY index_info.name
                  )
           FROM (
             SELECT index_class.relname AS name,
                    array_agg(attribute.attname ORDER BY indexed_attribute.ordinality) AS columns,
                    index_definition.indisunique AS unique,
                    index_definition.indisprimary AS primary
             FROM pg_catalog.pg_index index_definition
             JOIN pg_catalog.pg_class index_class ON index_class.oid = index_definition.indexrelid
             CROSS JOIN LATERAL unnest(index_definition.indkey) WITH ORDINALITY
               AS indexed_attribute(attnum, ordinality)
             JOIN pg_catalog.pg_attribute attribute
               ON attribute.attrelid = relation_class.oid
              AND attribute.attnum = indexed_attribute.attnum
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
             WHERE index_definition.indrelid = relation_class.oid
             GROUP BY index_class.relname, index_definition.indisunique, index_definition.indisprimary
           ) index_info
         ), '[]'::jsonb) AS indexes`
      : "'[]'::jsonb AS indexes";
  return [...summary, columns, indexes].join(",\n                 ");
}

function columnQuery(input: SearchObjectsInput): PostgresObjectSearchQuery {
  const values: unknown[] = [input.pattern];
  const conditions = [
    "column_info.column_name ILIKE $1",
    `column_info.table_schema NOT IN (${EXCLUDED_SCHEMAS})`,
    "relation_info.table_type IN ('BASE TABLE', 'VIEW')",
  ];
  if (input.schema !== undefined) {
    values.push(input.schema);
    conditions.push(`column_info.table_schema = $${values.length}`);
  }
  if (input.table !== undefined) {
    values.push(input.table);
    conditions.push(`column_info.table_name = $${values.length}`);
  }
  values.push(input.limit);
  const fields =
    input.detail_level === "names"
      ? 'column_info.column_name AS name, column_info.table_name AS "table", column_info.table_schema AS schema'
      : `column_info.column_name AS name,
         column_info.table_name AS "table",
         column_info.table_schema AS schema,
         column_info.data_type AS type,
         column_info.is_nullable = 'YES' AS nullable,
         column_info.column_default AS "default",
         column_description.description AS description`;
  return {
    sql: `SELECT ${fields}
          FROM information_schema.columns column_info
          JOIN information_schema.tables relation_info
            ON relation_info.table_schema = column_info.table_schema
           AND relation_info.table_name = column_info.table_name
          LEFT JOIN pg_catalog.pg_namespace relation_namespace
            ON relation_namespace.nspname = column_info.table_schema
          LEFT JOIN pg_catalog.pg_class relation_class
            ON relation_class.relnamespace = relation_namespace.oid
           AND relation_class.relname = column_info.table_name
          LEFT JOIN pg_catalog.pg_description column_description
            ON column_description.objoid = relation_class.oid
           AND column_description.objsubid = column_info.ordinal_position
          WHERE ${conditions.join(" AND ")}
          ORDER BY column_info.table_schema ASC,
                   CASE WHEN relation_info.table_type = 'BASE TABLE' THEN 0 ELSE 1 END ASC,
                   column_info.table_name ASC,
                   column_info.ordinal_position ASC
          LIMIT $${values.length}`,
    values,
  };
}

function routineQuery(
  input: SearchObjectsInput,
  objectType: "procedure" | "function",
): PostgresObjectSearchQuery {
  const values: unknown[] = [input.pattern];
  const routineType = objectType === "procedure" ? "PROCEDURE" : "FUNCTION";
  const conditions = [
    `routine_info.routine_type = '${routineType}'`,
    `routine_info.routine_schema NOT IN (${EXCLUDED_SCHEMAS})`,
    "routine_info.routine_name ILIKE $1",
  ];
  if (input.schema !== undefined) {
    values.push(input.schema);
    conditions.push(`routine_info.routine_schema = $${values.length}`);
  }
  values.push(input.limit);
  const names = "routine_info.routine_name AS name, routine_info.routine_schema AS schema";
  const fields =
    input.detail_level === "names"
      ? names
      : `${names},
         CASE WHEN routine_info.routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END AS type,
         COALESCE(routine_info.external_language, 'sql') AS language,
         CASE WHEN routine_info.data_type = 'void' THEN NULL ELSE routine_info.data_type END AS return_type${
           input.detail_level === "full"
             ? `,
         COALESCE((
           SELECT string_agg(
                    parameter_info.parameter_name || ' ' || parameter_info.parameter_mode || ' ' || parameter_info.data_type,
                    ', ' ORDER BY parameter_info.ordinal_position
                  )
           FROM information_schema.parameters parameter_info
           WHERE parameter_info.specific_schema = routine_info.specific_schema
             AND parameter_info.specific_name = routine_info.specific_name
             AND parameter_info.parameter_name IS NOT NULL
         ), '') AS parameters,
         NULLIF(routine_info.routine_definition, '') AS definition`
             : ""
         }`;
  return {
    sql: `SELECT ${fields}
          FROM information_schema.routines routine_info
          WHERE ${conditions.join(" AND ")}
          ORDER BY routine_info.routine_schema ASC,
                   routine_info.routine_name ASC,
                   routine_info.specific_name ASC
          LIMIT $${values.length}`,
    values,
  };
}

function indexQuery(input: SearchObjectsInput): PostgresObjectSearchQuery {
  const values: unknown[] = [input.pattern];
  const conditions = [
    "index_class.relname ILIKE $1",
    `relation_info.table_schema NOT IN (${EXCLUDED_SCHEMAS})`,
    "relation_info.table_type = 'BASE TABLE'",
  ];
  if (input.schema !== undefined) {
    values.push(input.schema);
    conditions.push(`relation_info.table_schema = $${values.length}`);
  }
  if (input.table !== undefined) {
    values.push(input.table);
    conditions.push(`relation_info.table_name = $${values.length}`);
  }
  values.push(input.limit);
  const names =
    'index_class.relname AS name, relation_info.table_name AS "table", relation_info.table_schema AS schema';
  const fields =
    input.detail_level === "names"
      ? names
      : `${names},
         array_agg(attribute.attname ORDER BY indexed_attribute.ordinality) AS columns,
         index_definition.indisunique AS unique,
         index_definition.indisprimary AS primary`;
  return {
    sql: `SELECT ${fields}
          FROM information_schema.tables relation_info
          JOIN pg_catalog.pg_namespace relation_namespace
            ON relation_namespace.nspname = relation_info.table_schema
          JOIN pg_catalog.pg_class relation_class
            ON relation_class.relnamespace = relation_namespace.oid
           AND relation_class.relname = relation_info.table_name
          JOIN pg_catalog.pg_index index_definition ON index_definition.indrelid = relation_class.oid
          JOIN pg_catalog.pg_class index_class ON index_class.oid = index_definition.indexrelid
          CROSS JOIN LATERAL unnest(index_definition.indkey) WITH ORDINALITY
            AS indexed_attribute(attnum, ordinality)
          JOIN pg_catalog.pg_attribute attribute
            ON attribute.attrelid = relation_class.oid
           AND attribute.attnum = indexed_attribute.attnum
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
          WHERE ${conditions.join(" AND ")}
          GROUP BY index_class.relname,
                   relation_info.table_name,
                   relation_info.table_schema,
                   index_definition.indisunique,
                   index_definition.indisprimary,
                   index_definition.indkey
          ORDER BY relation_info.table_schema ASC,
                   relation_info.table_name ASC,
                   index_class.relname ASC
          LIMIT $${values.length}`,
    values,
  };
}
