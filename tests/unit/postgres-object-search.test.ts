import { describe, expect, it } from "vitest";
import type { SearchObjectsInput } from "../../src/domain/database-tools.js";
import {
  buildPostgresObjectSearchQuery,
  normalizePostgresObjectSearchRows,
} from "../../src/domain/postgres-object-search.js";

interface SearchGolden {
  label: string;
  input: SearchObjectsInput;
  driverRow: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const DBHUB_1_2_1_GOLDENS: readonly SearchGolden[] = [
  {
    label: "schema names",
    input: { object_type: "schema", pattern: "app%", detail_level: "names", limit: 3 },
    driverRow: { name: "app" },
    expected: { name: "app" },
  },
  {
    label: "schema summary",
    input: { object_type: "schema", pattern: "app%", detail_level: "summary", limit: 3 },
    driverRow: { name: "app", table_count: 2 },
    expected: { name: "app", table_count: 2 },
  },
  {
    label: "schema full",
    input: { object_type: "schema", pattern: "app%", detail_level: "full", limit: 3 },
    driverRow: { name: "app", table_count: 2 },
    expected: { name: "app", table_count: 2 },
  },
  {
    label: "table names",
    input: {
      object_type: "table",
      pattern: "user%",
      detail_level: "names",
      limit: 3,
      schema: "app",
    },
    driverRow: { name: "users", schema: "app" },
    expected: { name: "users", schema: "app" },
  },
  {
    label: "table summary",
    input: {
      object_type: "table",
      pattern: "user%",
      detail_level: "summary",
      limit: 3,
      schema: "app",
    },
    driverRow: { name: "users", schema: "app", column_count: 2, row_count: null, comment: null },
    expected: { name: "users", schema: "app", column_count: 2, row_count: null },
  },
  {
    label: "table full",
    input: {
      object_type: "table",
      pattern: "user%",
      detail_level: "full",
      limit: 3,
      schema: "app",
    },
    driverRow: {
      name: "users",
      schema: "app",
      column_count: 2,
      row_count: 4,
      comment: "Accounts",
      columns: [
        { name: "id", type: "integer", nullable: false, default: null },
        { name: "email", type: "text", nullable: true, default: null, description: "Login" },
      ],
      indexes: [{ name: "users_pkey", columns: ["id"], unique: true, primary: true }],
    },
    expected: {
      name: "users",
      schema: "app",
      column_count: 2,
      row_count: 4,
      comment: "Accounts",
      columns: [
        { name: "id", type: "integer", nullable: false, default: null },
        { name: "email", type: "text", nullable: true, default: null, description: "Login" },
      ],
      indexes: [{ name: "users_pkey", columns: ["id"], unique: true, primary: true }],
    },
  },
  {
    label: "view names",
    input: {
      object_type: "view",
      pattern: "active%",
      detail_level: "names",
      limit: 3,
      schema: "app",
    },
    driverRow: { name: "active_users", schema: "app" },
    expected: { name: "active_users", schema: "app" },
  },
  {
    label: "view summary",
    input: {
      object_type: "view",
      pattern: "active%",
      detail_level: "summary",
      limit: 3,
      schema: "app",
    },
    driverRow: { name: "active_users", schema: "app", column_count: 2, comment: null },
    expected: { name: "active_users", schema: "app", column_count: 2 },
  },
  {
    label: "view full",
    input: {
      object_type: "view",
      pattern: "active%",
      detail_level: "full",
      limit: 3,
      schema: "app",
    },
    driverRow: {
      name: "active_users",
      schema: "app",
      column_count: 2,
      comment: null,
      columns: [{ name: "id", type: "integer", nullable: false, default: null }],
      indexes: [],
    },
    expected: {
      name: "active_users",
      schema: "app",
      column_count: 2,
      columns: [{ name: "id", type: "integer", nullable: false, default: null }],
      indexes: [],
    },
  },
  {
    label: "column names",
    input: {
      object_type: "column",
      pattern: "email",
      detail_level: "names",
      limit: 3,
      schema: "app",
      table: "users",
    },
    driverRow: { name: "email", table: "users", schema: "app" },
    expected: { name: "email", table: "users", schema: "app" },
  },
  {
    label: "column summary",
    input: {
      object_type: "column",
      pattern: "email",
      detail_level: "summary",
      limit: 3,
      schema: "app",
      table: "users",
    },
    driverRow: {
      name: "email",
      table: "users",
      schema: "app",
      type: "text",
      nullable: true,
      default: null,
      description: null,
    },
    expected: {
      name: "email",
      table: "users",
      schema: "app",
      type: "text",
      nullable: true,
      default: null,
    },
  },
  {
    label: "column full",
    input: {
      object_type: "column",
      pattern: "email",
      detail_level: "full",
      limit: 3,
      schema: "app",
      table: "users",
    },
    driverRow: {
      name: "email",
      table: "users",
      schema: "app",
      type: "text",
      nullable: true,
      default: null,
      description: "Login",
    },
    expected: {
      name: "email",
      table: "users",
      schema: "app",
      type: "text",
      nullable: true,
      default: null,
      description: "Login",
    },
  },
  {
    label: "procedure names",
    input: {
      object_type: "procedure",
      pattern: "refresh%",
      detail_level: "names",
      limit: 3,
      schema: "app",
    },
    driverRow: { name: "refresh_cache", schema: "app" },
    expected: { name: "refresh_cache", schema: "app" },
  },
  {
    label: "procedure summary",
    input: {
      object_type: "procedure",
      pattern: "refresh%",
      detail_level: "summary",
      limit: 3,
      schema: "app",
    },
    driverRow: {
      name: "refresh_cache",
      schema: "app",
      type: "procedure",
      language: "sql",
      return_type: null,
    },
    expected: { name: "refresh_cache", schema: "app", type: "procedure", language: "sql" },
  },
  {
    label: "procedure full",
    input: {
      object_type: "procedure",
      pattern: "refresh%",
      detail_level: "full",
      limit: 3,
      schema: "app",
    },
    driverRow: {
      name: "refresh_cache",
      schema: "app",
      type: "procedure",
      language: "sql",
      return_type: null,
      parameters: "",
      definition: null,
    },
    expected: {
      name: "refresh_cache",
      schema: "app",
      type: "procedure",
      language: "sql",
      parameters: "",
    },
  },
  {
    label: "function names",
    input: {
      object_type: "function",
      pattern: "display%",
      detail_level: "names",
      limit: 3,
      schema: "app",
    },
    driverRow: { name: "display_name", schema: "app" },
    expected: { name: "display_name", schema: "app" },
  },
  {
    label: "function summary",
    input: {
      object_type: "function",
      pattern: "display%",
      detail_level: "summary",
      limit: 3,
      schema: "app",
    },
    driverRow: {
      name: "display_name",
      schema: "app",
      type: "function",
      language: "sql",
      return_type: "text",
    },
    expected: {
      name: "display_name",
      schema: "app",
      type: "function",
      language: "sql",
      return_type: "text",
    },
  },
  {
    label: "function full",
    input: {
      object_type: "function",
      pattern: "display%",
      detail_level: "full",
      limit: 3,
      schema: "app",
    },
    driverRow: {
      name: "display_name",
      schema: "app",
      type: "function",
      language: "sql",
      return_type: "text",
      parameters: "value IN text",
      definition: "SELECT value",
    },
    expected: {
      name: "display_name",
      schema: "app",
      type: "function",
      language: "sql",
      return_type: "text",
      parameters: "value IN text",
      definition: "SELECT value",
    },
  },
  {
    label: "index names",
    input: {
      object_type: "index",
      pattern: "users%",
      detail_level: "names",
      limit: 3,
      schema: "app",
      table: "users",
    },
    driverRow: { name: "users_email_idx", table: "users", schema: "app" },
    expected: { name: "users_email_idx", table: "users", schema: "app" },
  },
  {
    label: "index summary",
    input: {
      object_type: "index",
      pattern: "users%",
      detail_level: "summary",
      limit: 3,
      schema: "app",
      table: "users",
    },
    driverRow: {
      name: "users_email_idx",
      table: "users",
      schema: "app",
      columns: ["email"],
      unique: true,
      primary: false,
    },
    expected: {
      name: "users_email_idx",
      table: "users",
      schema: "app",
      columns: ["email"],
      unique: true,
      primary: false,
    },
  },
  {
    label: "index full",
    input: {
      object_type: "index",
      pattern: "users%",
      detail_level: "full",
      limit: 3,
      schema: "app",
      table: "users",
    },
    driverRow: {
      name: "users_email_idx",
      table: "users",
      schema: "app",
      columns: ["email"],
      unique: true,
      primary: false,
    },
    expected: {
      name: "users_email_idx",
      table: "users",
      schema: "app",
      columns: ["email"],
      unique: true,
      primary: false,
    },
  },
];

describe("PostgreSQL search_objects compatible con los goldens de DBHub 1.2.1", () => {
  it.each(DBHUB_1_2_1_GOLDENS)("conserva $label", ({ input, driverRow, expected }) => {
    const query = buildPostgresObjectSearchQuery(input);

    expect(normalizePostgresObjectSearchRows(input, [driverRow])).toEqual([expected]);
    expect(query.sql).toContain("ILIKE $1");
    expect(query.sql).toContain("ORDER BY");
    expect(query.sql).not.toContain(input.pattern);
    expect(query.values[0]).toBe(input.pattern);
    expect(query.values.at(-1)).toBe(input.limit);
  });

  it("conserva el orden declarado de columnas en índices compuestos", () => {
    for (const input of [
      { object_type: "table", pattern: "%", detail_level: "full", limit: 2 },
      { object_type: "index", pattern: "%", detail_level: "summary", limit: 2 },
    ] as const) {
      const query = buildPostgresObjectSearchQuery(input);
      expect(query.sql).toContain("unnest(index_definition.indkey) WITH ORDINALITY");
      expect(query.sql).toContain(
        "array_agg(attribute.attname ORDER BY indexed_attribute.ordinality)",
      );
    }
  });

  it("respeta la visibilidad de definitions de routines de information_schema", () => {
    for (const object_type of ["function", "procedure"] as const) {
      const query = buildPostgresObjectSearchQuery({
        object_type,
        pattern: "%",
        detail_level: "full",
        limit: 2,
      });

      expect(query.sql).toContain("NULLIF(routine_info.routine_definition, '') AS definition");
      expect(query.sql).not.toContain("pg_get_functiondef");
      expect(query.sql).not.toContain("pg_catalog.pg_proc");
      expect(query.sql).not.toContain("routine_class.oid");
    }
  });
});
