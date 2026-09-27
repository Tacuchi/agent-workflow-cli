import { type TomlTable, type TomlValue, parse } from "smol-toml";

/** Keep table prototypes consistent with JSON-backed configuration at the read boundary. */
export function parseToml(text: string): TomlTable {
  return normalizeTable(parse(text));
}

function normalizeTable(table: TomlTable): TomlTable {
  // fromEntries preserves an own __proto__ key without invoking its legacy setter.
  return Object.fromEntries(
    Object.entries(table).map(([key, value]) => [key, normalizeValue(value)]),
  );
}

function normalizeValue(value: TomlValue): TomlValue {
  if (Array.isArray(value)) return value.map(normalizeValue);
  // smol-toml 1.9 tables have null prototypes; dates retain their class and semantics.
  if (typeof value === "object" && Object.getPrototypeOf(value) === null) {
    return normalizeTable(value as TomlTable);
  }
  return value;
}
