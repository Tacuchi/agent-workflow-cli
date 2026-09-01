import {
  type McpConnectionRef,
  type McpEntry,
  type McpEntryState,
  type McpHost,
  type McpWriteResult,
  buildMcpEntry,
  knownLegacyMcpInstanceAliases,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { type McpEntryClassification, classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { removeMcpEntry, writeMcpEntry } from "./mcp-host-writer.js";
import {
  type McpScopeInput,
  type McpScopeRefusal,
  buildGlobalRefusal,
  resolveScopeDir,
} from "./mcp-scope-common.js";

export type McpMigrationInput = McpScopeInput & {
  hosts: readonly McpHost[];
  connections: readonly McpConnectionRef[];
  namespace?: string;
  apply?: boolean;
  /** Explicit caller approval for live user-scope host configuration writes. */
  globalApproval?: true;
};

export interface McpMigrationItem {
  host: McpHost;
  instance: string;
  target: string;
  state: McpEntryState;
  action: "none" | "install" | "replace-known-legacy" | "blocked" | "failed";
  write?: McpWriteResult;
  /** State reread after an applied write; receipts require `current`. */
  readback_state?: McpEntryState;
  /** At least one descriptor was actually changed, including a retired alias. */
  configuration_changed?: boolean;
  /** Exact known legacy descriptor with every environment value redacted. */
  from?: McpMigrationDescriptorPreview;
  /** Proposed descriptor, secret-free by construction. */
  to?: McpMigrationDescriptorPreview;
  error?: { code: "MCP_MIGRATION_WRITE_FAILED"; message: string };
  /** Exact historic aliases retired only after the qtc-* descriptor is current. */
  retirements?: McpLegacyAliasRetirement[];
}

export interface McpLegacyAliasRetirement {
  instance: string;
  target: string;
  state: McpEntryState;
  action: "retire-known-legacy" | "blocked" | "failed";
  write?: McpWriteResult;
  readback_state?: McpEntryState;
  /** Exact known legacy descriptor with every environment value redacted. */
  from?: McpMigrationDescriptorPreview;
  error?: { code: "MCP_MIGRATION_WRITE_FAILED"; message: string };
}

export interface McpMigrationDescriptorPreview {
  command: string;
  args: string[];
  env: Record<string, "<redacted>">;
  optional?: boolean;
}

export interface McpMigrationResult {
  scope: "workspace" | "global";
  scope_dir: string;
  preview: boolean;
  items: McpMigrationItem[];
  summary: Record<McpEntryState, number>;
  receipts?: Array<{
    host: McpHost;
    instance: string;
    descriptor_digest: string;
    reload_required: true;
  }>;
  receipt_errors?: Array<{ host: McpHost; instance: string; message: string }>;
  readback_errors?: Array<{ host: McpHost; instance: string; message: string }>;
  launch_probes?: Array<{
    host: McpHost;
    instance: string;
    outcome: "passed" | "failed";
    phase: "spawn" | "initialize" | "initialized" | "tools/list" | "tools/call";
    code?: string;
  }>;
  probe_errors?: Array<{ host: McpHost; instance: string; message: string }>;
  native_checks?: Array<{
    host: "claude" | "codex";
    instance: string;
    outcome: "passed" | "failed";
    code?: "HOST_BINARY_MISSING" | "HOST_NATIVE_CHECK_FAILED" | "HOST_ENTRY_NOT_VISIBLE";
  }>;
  native_errors?: Array<{ host: McpHost; instance: string; message: string }>;
}

interface LegacyRetirementCandidate {
  connection: McpConnectionRef;
  entry: McpEntry;
  target: string;
  classification: McpEntryClassification;
}

interface MigrationApplyResult {
  write?: McpWriteResult;
  readbackState?: McpEntryState;
  configurationChanged: boolean;
  retirements: McpLegacyAliasRetirement[];
  error?: string;
}

/**
 * Classifies a named entry before mutation. Only byte-exact historic Workline
 * shapes are migratable; anything else remains foreign or malformed.
 */
export function runMcpMigration(
  env: EnvPort,
  input: McpMigrationInput & { scope: "workspace" },
): McpMigrationResult;
export function runMcpMigration(
  env: EnvPort,
  input: McpMigrationInput,
): McpMigrationResult | McpScopeRefusal;
export function runMcpMigration(
  env: EnvPort,
  input: McpMigrationInput,
): McpMigrationResult | McpScopeRefusal {
  if (input.scope === "global" && input.apply === true && input.globalApproval === undefined) {
    return buildGlobalRefusal([...input.hosts]);
  }
  const scopeDir = resolveScopeDir(env, input);
  const items = input.hosts.flatMap((host) =>
    input.connections.map((connection) => migrateConnection(host, connection, scopeDir, input)),
  );
  return {
    scope: input.scope,
    scope_dir: scopeDir,
    preview: !input.apply,
    items,
    summary: {
      current: items.filter((item) => item.state === "current").length,
      "known-legacy": items.filter((item) => item.state === "known-legacy").length,
      foreign: items.filter((item) => item.state === "foreign").length,
      missing: items.filter((item) => item.state === "missing").length,
      malformed: items.filter((item) => item.state === "malformed").length,
    },
  };
}

function migrateConnection(
  host: McpHost,
  connection: McpConnectionRef,
  scopeDir: string,
  input: McpMigrationInput,
): McpMigrationItem {
  const current = currentEntry(host, connection, input);
  const snapshot = readCurrentSnapshot(host, scopeDir, current, input.scope);
  if (snapshot === undefined) return unreadableMigrationItem(host, connection, scopeDir);

  const classification = classifyMcpEntry(host, snapshot, current, connection);
  const retirements = inspectLegacyRetirements(host, connection, scopeDir, input);
  const state = classification.state;
  const requestedAction = actionForMigration(state, retirements);
  const shouldApply = input.apply === true && isMutationAction(requestedAction);
  const applied = shouldApply
    ? applyMigration(host, connection, current, classification, retirements, scopeDir, input.scope)
    : undefined;
  const action = applied?.error === undefined ? requestedAction : "failed";
  return migrationItem({
    host,
    connection,
    current,
    snapshotTarget: snapshot.target,
    classification,
    requestedAction,
    action,
    retirements: applied?.retirements ?? retirementPreview(retirements),
    ...(applied === undefined ? {} : { applied }),
  });
}

function currentEntry(
  host: McpHost,
  connection: McpConnectionRef,
  input: McpMigrationInput,
): McpEntry {
  return buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope: input.scope,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
  });
}

function readCurrentSnapshot(
  host: McpHost,
  scopeDir: string,
  entry: McpEntry,
  scope: McpMigrationInput["scope"],
): ReturnType<typeof readMcpEntry> | undefined {
  try {
    return readMcpEntry(host, scopeDir, entry.name, scope);
  } catch {
    return undefined;
  }
}

function unreadableMigrationItem(
  host: McpHost,
  connection: McpConnectionRef,
  scopeDir: string,
): McpMigrationItem {
  return {
    host,
    instance: connection.name,
    target: scopeDir,
    state: "malformed",
    action: "failed",
    error: {
      code: "MCP_MIGRATION_WRITE_FAILED",
      message: "No se pudo leer la configuración MCP para migrarla.",
    },
  };
}

function inspectLegacyRetirements(
  host: McpHost,
  connection: McpConnectionRef,
  scopeDir: string,
  input: McpMigrationInput,
): LegacyRetirementCandidate[] {
  if (host !== "claude") return [];
  return knownLegacyMcpInstanceAliases(connection.name)
    .map((alias) => {
      const aliasConnection = { ...connection, name: alias };
      const entry = currentEntry(host, aliasConnection, input);
      const snapshot = readCurrentSnapshot(host, scopeDir, entry, input.scope);
      if (snapshot === undefined) {
        return {
          connection: aliasConnection,
          entry,
          target: scopeDir,
          classification: { state: "malformed" as const },
        };
      }
      const classified = classifyMcpEntry(host, snapshot, entry, aliasConnection);
      // A new Workline descriptor under cert/prod is still an owned historic
      // name. It must be retired before qtc-cert/qtc-prod is presented as done.
      const classification =
        classified.state === "current"
          ? ({ state: "known-legacy", legacy: entry } as McpEntryClassification)
          : classified;
      return { connection: aliasConnection, entry, target: snapshot.target, classification };
    })
    .filter((candidate) => candidate.classification.state !== "missing");
}

function actionForMigration(
  state: McpEntryState,
  retirements: readonly LegacyRetirementCandidate[],
): McpMigrationItem["action"] {
  if (retirements.some((retirement) => retirement.classification.state !== "known-legacy")) {
    return "blocked";
  }
  const currentAction = actionFor(state);
  if (currentAction === "blocked") return "blocked";
  return retirements.length > 0 ? "replace-known-legacy" : currentAction;
}

function isMutationAction(action: McpMigrationItem["action"]): boolean {
  return action === "install" || action === "replace-known-legacy";
}

function applyMigration(
  host: McpHost,
  connection: McpConnectionRef,
  current: McpEntry,
  classification: McpEntryClassification,
  candidates: readonly LegacyRetirementCandidate[],
  scopeDir: string,
  scope: McpMigrationInput["scope"],
): MigrationApplyResult {
  // Establish the replacement before retiring any historic alias. A failed
  // write or readback therefore leaves every legacy server intact instead of
  // turning an unsuccessful migration into an availability outage.
  const currentWrite = writeCurrentMigration(
    host,
    connection,
    current,
    classification,
    scopeDir,
    scope,
    false,
    retirementPreview(candidates),
  );
  if (currentWrite.error !== undefined) {
    return {
      ...currentWrite,
      retirements: deferredRetirements(
        candidates,
        "No se retiró la entrada legacy porque el descriptor qtc no pudo confirmarse.",
      ),
    };
  }

  // The current descriptor is durable and reread at this point. Alias
  // retirement is deliberately best-effort after that coverage boundary: a
  // concurrent/failed removal leaves qtc-* usable and reports recovery work
  // instead of removing the only working server.
  const retired = retireKnownAliases(host, candidates, scopeDir, scope);
  if (retired.error !== undefined) {
    return {
      ...currentWrite,
      configurationChanged: currentWrite.configurationChanged || retired.configurationChanged,
      retirements: retired.retirements,
      error: `El descriptor qtc quedó instalado, pero ${retired.error}`,
    };
  }
  const retirements = verifyRetiredAliases(host, candidates, retired.retirements, scopeDir, scope);
  if (retirements.error === undefined) {
    return {
      ...currentWrite,
      configurationChanged: currentWrite.configurationChanged || retired.configurationChanged,
      retirements: retirements.value,
    };
  }
  return {
    ...currentWrite,
    configurationChanged: currentWrite.configurationChanged || retired.configurationChanged,
    retirements: retirements.value,
    error: `El descriptor qtc quedó instalado, pero ${retirements.error}`,
  };
}

function verifyRetiredAliases(
  host: McpHost,
  candidates: readonly LegacyRetirementCandidate[],
  retirements: McpLegacyAliasRetirement[],
  scopeDir: string,
  scope: McpMigrationInput["scope"],
): { value: McpLegacyAliasRetirement[]; error?: string } {
  const verified = [...retirements];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const retirement = verified[index];
    if (candidate === undefined || retirement === undefined) continue;
    const state = readBackState(host, scopeDir, candidate.entry, candidate.connection, scope);
    if (state === "missing") continue;
    const error = "La entrada legacy reapareció durante la migración; no se debe recargar el host.";
    verified[index] = {
      ...retirement,
      action: "failed",
      readback_state: state,
      error: { code: "MCP_MIGRATION_WRITE_FAILED", message: error },
    };
    return { value: verified, error };
  }
  return { value: verified };
}

function retireKnownAliases(
  host: McpHost,
  candidates: readonly LegacyRetirementCandidate[],
  scopeDir: string,
  scope: McpMigrationInput["scope"],
): Pick<MigrationApplyResult, "configurationChanged" | "retirements" | "error"> {
  const retirements = retirementPreview(candidates);
  let configurationChanged = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const result = retireAlias(host, candidate, scopeDir, scope);
    retirements[index] = result.retirement;
    configurationChanged ||= result.configurationChanged;
    if (result.error !== undefined) {
      for (let deferred = index + 1; deferred < candidates.length; deferred += 1) {
        const pending = candidates[deferred];
        if (pending === undefined) continue;
        retirements[deferred] = deferredRetirement(
          pending,
          "No se retiró la entrada legacy porque una retirada anterior falló.",
        );
      }
      return { configurationChanged, retirements, error: result.error };
    }
  }
  return { configurationChanged, retirements };
}

function retireAlias(
  host: McpHost,
  candidate: LegacyRetirementCandidate,
  scopeDir: string,
  scope: McpMigrationInput["scope"],
): {
  retirement: McpLegacyAliasRetirement;
  configurationChanged: boolean;
  error?: string;
} {
  try {
    const write = removeMcpEntry(
      host,
      candidate.entry,
      { scopeDir, kind: scope },
      ...(candidate.classification.legacy === undefined
        ? []
        : [{ replaceLegacy: candidate.classification.legacy }]),
    );
    const readbackState = readBackState(
      host,
      scopeDir,
      candidate.entry,
      candidate.connection,
      scope,
    );
    const configurationChanged = write.action === "removed";
    const complete =
      (write.action === "removed" || write.action === "skipped-idempotent") &&
      write.partial === undefined &&
      readbackState === "missing";
    const retirement = retirementItem(candidate, {
      action: complete ? "retire-known-legacy" : "failed",
      write,
      readbackState,
      ...(complete
        ? {}
        : {
            error:
              write.partial?.message ??
              "No se pudo retirar la entrada legacy después de confirmar la conexión qtc.",
          }),
    });
    const error = complete ? undefined : retirement.error?.message;
    return {
      retirement,
      configurationChanged,
      ...(error === undefined ? {} : { error }),
    };
  } catch {
    const retirement = retirementItem(candidate, {
      action: "failed",
      error: "No se pudo retirar la entrada legacy después de confirmar la conexión qtc.",
    });
    return {
      retirement,
      configurationChanged: false,
      error: "No se pudo retirar la entrada legacy después de confirmar la conexión qtc.",
    };
  }
}

function writeCurrentMigration(
  host: McpHost,
  connection: McpConnectionRef,
  current: McpEntry,
  classification: McpEntryClassification,
  scopeDir: string,
  scope: McpMigrationInput["scope"],
  configurationChanged: boolean,
  retirements: McpLegacyAliasRetirement[],
): MigrationApplyResult {
  try {
    const write = writeMcpEntry(
      host,
      current,
      { scopeDir, kind: scope },
      ...(classification.legacy === undefined ? [] : [{ replaceLegacy: classification.legacy }]),
    );
    const readbackState = readBackState(host, scopeDir, current, connection, scope);
    const complete =
      (write.action === "written" || write.action === "skipped-idempotent") &&
      write.partial === undefined &&
      readbackState === "current";
    return {
      write,
      readbackState,
      configurationChanged: configurationChanged || write.action === "written",
      retirements,
      ...(complete
        ? {}
        : {
            error:
              write.partial?.message ??
              (write.action === "conflict"
                ? "La entrada MCP cambió durante la migración; no se sobrescribió la configuración ajena."
                : "No se pudo escribir o releer la configuración MCP; no se aplicaron más cambios para esta entrada."),
          }),
    };
  } catch {
    return {
      configurationChanged,
      retirements,
      error:
        "No se pudo escribir o releer la configuración MCP; no se aplicaron más cambios para esta entrada.",
    };
  }
}

function retirementPreview(
  candidates: readonly LegacyRetirementCandidate[],
): McpLegacyAliasRetirement[] {
  return candidates.map((candidate) =>
    retirementItem(candidate, {
      action: candidate.classification.state === "known-legacy" ? "retire-known-legacy" : "blocked",
    }),
  );
}

function deferredRetirements(
  candidates: readonly LegacyRetirementCandidate[],
  error: string,
): McpLegacyAliasRetirement[] {
  return candidates.map((candidate) => deferredRetirement(candidate, error));
}

function deferredRetirement(
  candidate: LegacyRetirementCandidate,
  error: string,
): McpLegacyAliasRetirement {
  return retirementItem(candidate, { action: "blocked", error });
}

function retirementItem(
  candidate: LegacyRetirementCandidate,
  result: {
    action: McpLegacyAliasRetirement["action"];
    write?: McpWriteResult;
    readbackState?: McpEntryState;
    error?: string;
  },
): McpLegacyAliasRetirement {
  return {
    instance: candidate.connection.name,
    target: candidate.target,
    state: candidate.classification.state,
    action: result.action,
    ...(candidate.classification.legacy === undefined
      ? {}
      : { from: redactDescriptor(candidate.classification.legacy) }),
    ...(result.write === undefined ? {} : { write: result.write }),
    ...(result.readbackState === undefined ? {} : { readback_state: result.readbackState }),
    ...(result.error === undefined
      ? {}
      : { error: { code: "MCP_MIGRATION_WRITE_FAILED", message: result.error } }),
  };
}

function migrationItem(input: {
  host: McpHost;
  connection: McpConnectionRef;
  current: McpEntry;
  snapshotTarget: string;
  classification: McpEntryClassification;
  requestedAction: McpMigrationItem["action"];
  action: McpMigrationItem["action"];
  retirements: McpLegacyAliasRetirement[];
  applied?: MigrationApplyResult;
}): McpMigrationItem {
  const error = input.applied?.error;
  return {
    host: input.host,
    instance: input.connection.name,
    target: input.snapshotTarget,
    state: input.classification.state,
    action: input.action,
    ...(input.applied?.write === undefined ? {} : { write: input.applied.write }),
    ...(input.applied?.readbackState === undefined
      ? {}
      : { readback_state: input.applied.readbackState }),
    ...(input.applied?.configurationChanged ? { configuration_changed: true } : {}),
    ...(input.classification.legacy === undefined
      ? {}
      : { from: redactDescriptor(input.classification.legacy) }),
    ...(isMutationAction(input.requestedAction) ? { to: redactDescriptor(input.current) } : {}),
    ...(input.retirements.length === 0 ? {} : { retirements: input.retirements }),
    ...(error === undefined
      ? {}
      : { error: { code: "MCP_MIGRATION_WRITE_FAILED", message: error } }),
  };
}

function readBackState(
  host: McpHost,
  scopeDir: string,
  current: ReturnType<typeof buildMcpEntry>,
  connection: McpConnectionRef,
  scope: McpMigrationInput["scope"],
): McpEntryState {
  try {
    return classifyMcpEntry(
      host,
      readMcpEntry(host, scopeDir, current.name, scope),
      current,
      connection,
    ).state;
  } catch {
    return "malformed";
  }
}

function actionFor(state: McpEntryState): McpMigrationItem["action"] {
  switch (state) {
    case "missing":
      return "install";
    case "known-legacy":
      return "replace-known-legacy";
    case "foreign":
    case "malformed":
      return "blocked";
    case "current":
      return "none";
  }
}

function redactDescriptor(entry: {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  optional?: boolean;
}): McpMigrationDescriptorPreview {
  return {
    command: entry.command,
    args: [...entry.args],
    env: Object.fromEntries(
      Object.keys(entry.env)
        .sort()
        .map((key) => [key, "<redacted>"]),
    ),
    ...(entry.optional ? { optional: true } : {}),
  };
}
