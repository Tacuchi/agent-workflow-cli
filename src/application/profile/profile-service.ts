import { isAbsolute, join } from "node:path";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";

export const ENV_VAR_PROFILE = "AW_PROFILE";
export const USER_CONFIG_RELPATH = join(".config", "agent-workflow", "profile.json");
export const WORKSPACE_PROFILE_FILENAME = "profile.json";
export const DEFAULT_NAMESPACE = "agent-workflow";

export interface ProfileMcpDatabase {
  alias: string;
  host: string;
  port: number;
  database: string;
  schema?: string;
}

export interface ProfileLegacyRule {
  from: string;
  to: string;
  scope?: "skill" | "command" | "hook" | "anchor";
}

export interface ProfileCustomAnchor {
  anchor: string;
  target: string;
}

export interface Profile {
  namespace: string;
  company: string;
  claude_md_block: string;
  mcp_databases: ProfileMcpDatabase[];
  lexicon_path: string | null;
  examples_path: string | null;
  migrate_legacy_rules: ProfileLegacyRule[];
  custom_anchors: ProfileCustomAnchor[];
}

export const DEFAULT_PROFILE: Profile = Object.freeze({
  namespace: DEFAULT_NAMESPACE,
  company: "agent-workflow",
  claude_md_block: "AW-PROJECT",
  mcp_databases: [],
  lexicon_path: null,
  examples_path: null,
  migrate_legacy_rules: [],
  custom_anchors: [],
}) as Profile;

export type ProfileSource = "flag" | "env" | "user-config" | "workspace" | "default";

export interface ResolvedProfile {
  profile: Profile;
  source: ProfileSource;
  path: string | null;
}

export type ProfileErrorCode =
  | "PROFILE_NOT_FOUND"
  | "PROFILE_INVALID_JSON"
  | "PROFILE_INVALID_SCHEMA";

export interface ProfileError {
  code: ProfileErrorCode;
  message: string;
  path?: string;
  field?: string;
}

export interface ResolveProfileInput {
  flagPath?: string | null;
  workspaceNamespace?: string;
}

export async function resolveProfile(
  fs: FileSystemPort,
  env: EnvPort,
  input: ResolveProfileInput = {},
): Promise<ResolvedProfile | ProfileError> {
  const cwd = env.cwd();
  const home = env.homeDir();
  const wsNs = (input.workspaceNamespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;

  const flagPath = (input.flagPath ?? "").trim();
  if (flagPath.length > 0) {
    const abs = isAbsolute(flagPath) ? flagPath : join(cwd, flagPath);
    return loadOrFail(fs, abs, "flag");
  }

  const envValue = (env.get(ENV_VAR_PROFILE) ?? "").trim();
  if (envValue.length > 0) {
    const abs = isAbsolute(envValue) ? envValue : join(cwd, envValue);
    return loadOrFail(fs, abs, "env");
  }

  const userPath = join(home, USER_CONFIG_RELPATH);
  if (await fs.exists(userPath)) {
    return loadOrFail(fs, userPath, "user-config");
  }

  const workspacePath = join(cwd, `.${wsNs}`, WORKSPACE_PROFILE_FILENAME);
  if (await fs.exists(workspacePath)) {
    return loadOrFail(fs, workspacePath, "workspace");
  }

  return { profile: cloneProfile(DEFAULT_PROFILE), source: "default", path: null };
}

async function loadOrFail(
  fs: FileSystemPort,
  path: string,
  source: ProfileSource,
): Promise<ResolvedProfile | ProfileError> {
  if (!(await fs.exists(path))) {
    return {
      code: "PROFILE_NOT_FOUND",
      message: `profile no encontrado (${source}): ${path}`,
      path,
    };
  }
  const text = await fs.readText(path);
  const parsed = parseAndValidate(text, path);
  if ("code" in parsed) return parsed;
  return { profile: parsed, source, path };
}

function parseAndValidate(text: string, path: string): Profile | ProfileError {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      code: "PROFILE_INVALID_JSON",
      message: `JSON inválido en ${path}: ${(err as Error).message}`,
      path,
    };
  }
  return validateProfile(raw, path);
}

export function validateProfile(raw: unknown, path?: string): Profile | ProfileError {
  if (!isObject(raw)) return failSchema("root", "objeto esperado", path);
  const scalarErr = validateScalarFields(raw, path);
  if (scalarErr !== null) return scalarErr;
  const arrayErr = validateArrayFields(raw, path);
  if (arrayErr !== null) return arrayErr;
  return {
    namespace: raw.namespace as string,
    company: raw.company as string,
    claude_md_block: raw.claude_md_block as string,
    mcp_databases: (raw.mcp_databases as ProfileMcpDatabase[]).map((d) => ({ ...d })),
    lexicon_path: (raw.lexicon_path ?? null) as string | null,
    examples_path: (raw.examples_path ?? null) as string | null,
    migrate_legacy_rules: (raw.migrate_legacy_rules as ProfileLegacyRule[]).map((r) => ({ ...r })),
    custom_anchors: (raw.custom_anchors as ProfileCustomAnchor[]).map((a) => ({ ...a })),
  };
}

function validateScalarFields(raw: Record<string, unknown>, path?: string): ProfileError | null {
  if (!isNonEmptyString(raw.namespace) || !isKebab(raw.namespace as string)) {
    return failSchema("namespace", "string kebab no vacío (^[a-z][a-z0-9-]*$)", path);
  }
  if (!isNonEmptyString(raw.company)) {
    return failSchema("company", "string no vacío", path);
  }
  if (
    !isNonEmptyString(raw.claude_md_block) ||
    !/^[A-Z][A-Z0-9_-]*$/.test(raw.claude_md_block as string)
  ) {
    return failSchema("claude_md_block", "string [A-Z][A-Z0-9_-]*", path);
  }
  const lexErr = validateNullableString(raw.lexicon_path, "lexicon_path", path);
  if (lexErr !== null) return lexErr;
  const exErr = validateNullableString(raw.examples_path, "examples_path", path);
  if (exErr !== null) return exErr;
  return null;
}

function validateNullableString(value: unknown, field: string, path?: string): ProfileError | null {
  if (value === null || value === undefined) return null;
  if (!isNonEmptyString(value)) return failSchema(field, "string no vacío o null", path);
  return null;
}

function validateArrayFields(raw: Record<string, unknown>, path?: string): ProfileError | null {
  const mcpErr = validateArray(raw.mcp_databases, "mcp_databases", validateMcpDatabase, path);
  if (mcpErr !== null) return mcpErr;
  const ruleErr = validateArray(
    raw.migrate_legacy_rules,
    "migrate_legacy_rules",
    validateLegacyRule,
    path,
  );
  if (ruleErr !== null) return ruleErr;
  const anchorErr = validateArray(raw.custom_anchors, "custom_anchors", validateAnchor, path);
  if (anchorErr !== null) return anchorErr;
  return null;
}

function validateArray(
  value: unknown,
  field: string,
  item: (raw: unknown, idx: number, path?: string) => ProfileError | null,
  path?: string,
): ProfileError | null {
  if (!Array.isArray(value)) return failSchema(field, "array", path);
  for (let i = 0; i < value.length; i++) {
    const err = item(value[i], i, path);
    if (err !== null) return err;
  }
  return null;
}

function validateMcpDatabase(raw: unknown, idx: number, path?: string): ProfileError | null {
  const field = `mcp_databases[${idx}]`;
  if (!isObject(raw)) return failSchema(field, "objeto esperado", path);
  if (!isNonEmptyString(raw.alias)) return failSchema(`${field}.alias`, "string no vacío", path);
  if (!isNonEmptyString(raw.host)) return failSchema(`${field}.host`, "string no vacío", path);
  if (
    typeof raw.port !== "number" ||
    !Number.isInteger(raw.port) ||
    raw.port <= 0 ||
    raw.port > 65535
  ) {
    return failSchema(`${field}.port`, "entero 1-65535", path);
  }
  if (!isNonEmptyString(raw.database))
    return failSchema(`${field}.database`, "string no vacío", path);
  if (raw.schema !== undefined && !isNonEmptyString(raw.schema)) {
    return failSchema(`${field}.schema`, "string no vacío o undefined", path);
  }
  return null;
}

function validateLegacyRule(raw: unknown, idx: number, path?: string): ProfileError | null {
  const field = `migrate_legacy_rules[${idx}]`;
  if (!isObject(raw)) return failSchema(field, "objeto esperado", path);
  if (!isNonEmptyString(raw.from)) return failSchema(`${field}.from`, "string no vacío", path);
  if (!isNonEmptyString(raw.to)) return failSchema(`${field}.to`, "string no vacío", path);
  if (
    raw.scope !== undefined &&
    !["skill", "command", "hook", "anchor"].includes(raw.scope as string)
  ) {
    return failSchema(`${field}.scope`, "skill|command|hook|anchor o undefined", path);
  }
  return null;
}

function validateAnchor(raw: unknown, idx: number, path?: string): ProfileError | null {
  const field = `custom_anchors[${idx}]`;
  if (!isObject(raw)) return failSchema(field, "objeto esperado", path);
  if (!isNonEmptyString(raw.anchor)) return failSchema(`${field}.anchor`, "string no vacío", path);
  if (!isNonEmptyString(raw.target)) return failSchema(`${field}.target`, "string no vacío", path);
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isKebab(s: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(s);
}

function failSchema(field: string, expected: string, path?: string): ProfileError {
  return {
    code: "PROFILE_INVALID_SCHEMA",
    message: `${field}: ${expected}`,
    field,
    ...(path !== undefined ? { path } : {}),
  };
}

function cloneProfile(p: Profile): Profile {
  return {
    namespace: p.namespace,
    company: p.company,
    claude_md_block: p.claude_md_block,
    mcp_databases: p.mcp_databases.map((d) => ({ ...d })),
    lexicon_path: p.lexicon_path,
    examples_path: p.examples_path,
    migrate_legacy_rules: p.migrate_legacy_rules.map((r) => ({ ...r })),
    custom_anchors: p.custom_anchors.map((a) => ({ ...a })),
  };
}
