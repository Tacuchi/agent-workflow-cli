import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import {
  type ChangelogEntry,
  type ContractChange,
  contractsBetween,
  parseChangelogContracts,
} from "../../domain/changelog-contract.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";
import { readPackageVersion } from "../../runtime/version.js";

export interface VersionContractNotice {
  version: string;
  state: "changes" | "none" | "undeclared" | "malformed";
  changes?: ContractChange[];
  problem?: string;
}

/**
 * What the jump changes in the contracts, read from the target's own
 * changelog. `unavailable` carries its reason and is never a "no changes".
 */
export type ContractChangesNotice =
  | { status: "read"; installed: string; target: string; versions: VersionContractNotice[] }
  | { status: "unavailable"; reason: string };

export interface SelfUpdateData {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  would_run?: boolean;
  /** The exact version installed, or null when the registry did not name one. */
  target_version?: string | null;
  contract_changes?: ContractChangesNotice;
}

export type ConfirmFn = (message: string) => Promise<boolean>;
export type NoticeFn = (text: string) => void;

export interface SelfUpdateDeps {
  notify?: NoticeFn;
  installedVersion?: () => string;
}

const defaultConfirm: ConfirmFn = async (message) => {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: true });
};

// stdout carries the single JSON result a consumer parses; the notice has to
// reach the person before npm starts without breaking that contract.
const defaultNotify: NoticeFn = (text) => {
  process.stderr.write(`${text}\n`);
};

const CHANGELOG_IN_TARBALL = "package/CHANGELOG.md";

interface TargetRead {
  version: string | null;
  notice: ContractChangesNotice;
}

function cancelled(target: TargetRead): CommandResult<SelfUpdateData> {
  return {
    ok: true,
    data: {
      command: "(cancelled)",
      exit_code: 0,
      stdout: "",
      stderr: "",
      target_version: target.version,
      contract_changes: target.notice,
    },
    exitCode: 0,
  };
}

export async function selfUpdate(
  args: ParsedArgs,
  ctx: CliContext,
  confirm: ConfirmFn = defaultConfirm,
  deps: SelfUpdateDeps = {},
): Promise<CommandResult<SelfUpdateData>> {
  const notify = deps.notify ?? defaultNotify;
  const installed = (deps.installedVersion ?? readPackageVersion)();
  const target = await readTarget(ctx, installed);
  // The version the notice described, never `@latest`: the tag can move between
  // reading the changelog and installing, and the notice would describe another.
  const spec = `${ctx.runtime.packageName}@${target.version ?? "latest"}`;
  const npmArgs = ["install", "-g", spec];
  const cmdString = `npm ${npmArgs.join(" ")}`;
  const notice = renderNotice(target);
  const read = { target_version: target.version, contract_changes: target.notice };

  if (args.flags.has("--dry-run")) {
    notify(notice);
    return {
      ok: true,
      data: { command: cmdString, exit_code: 0, stdout: "", stderr: "", would_run: true, ...read },
      exitCode: 0,
    };
  }

  // Optional TTY confirm. Inquirer throws `ExitPromptError` when the user
  // force-closes the prompt (Ctrl-C / Esc); treat that as a plain cancel
  // instead of letting it bubble up as UNHANDLED.
  // `--yes` / `-y` skips the confirm — used when the TUI dispatches update
  // (the menu selection is already the confirmation; asking again
  // duplicates the prompt and races with ink's stdin teardown).
  const skipConfirm = args.flags.has("--yes") || args.flags.has("-y");
  if (process.stdout.isTTY === true && !skipConfirm) {
    let ok: boolean;
    try {
      ok = await confirm(`${notice}\n\nRun \`${cmdString}\`?`);
    } catch {
      return cancelled(target);
    }
    if (!ok) return cancelled(target);
  } else {
    notify(notice);
  }

  const result = await ctx.process.run("npm", npmArgs, {});
  const code = result.code as ExitCode;
  return {
    ok: result.code === 0,
    data: {
      command: cmdString,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      ...read,
    },
    exitCode: code === 0 || code === 1 || code === 2 ? code : 1,
  };
}

/**
 * Downloads the target tarball to a temporary directory and reads its
 * changelog. `npm pack` honors the person's registry and auth, names the
 * version `@latest` resolves to, and leaves the tarball in the cache that the
 * install then reuses.
 */
async function readTarget(ctx: CliContext, installed: string): Promise<TargetRead> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "aw-self-update-"));
  } catch (err) {
    return unavailable(null, `no se pudo crear el directorio temporal: ${messageOf(err)}`);
  }
  try {
    const packed = await ctx.process.run(
      "npm",
      ["pack", `${ctx.runtime.packageName}@latest`, "--pack-destination", dir, "--json"],
      {},
    );
    if (packed.code !== 0) {
      return unavailable(null, `npm pack salió con código ${packed.code}: ${firstLine(packed)}`);
    }
    const meta = readPackMeta(packed.stdout);
    if (typeof meta === "string") return unavailable(null, meta);
    return await readChangelog(join(dir, basename(meta.filename)), meta.version, installed);
  } catch (err) {
    return unavailable(null, messageOf(err));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Once npm named the version, a tarball that cannot be read still installs that one. */
async function readChangelog(
  tarball: string,
  version: string,
  installed: string,
): Promise<TargetRead> {
  let changelog: string | null;
  try {
    changelog = readTarEntry(gunzipSync(await readFile(tarball)), CHANGELOG_IN_TARBALL);
  } catch (err) {
    return unavailable(version, `no se pudo leer el paquete: ${messageOf(err)}`);
  }
  if (changelog === null) return unavailable(version, "el paquete no trae CHANGELOG.md");
  return { version, notice: noticeOf(changelog, installed, version) };
}

function noticeOf(changelog: string, installed: string, target: string): ContractChangesNotice {
  const range = contractsBetween(parseChangelogContracts(changelog), installed, target);
  if (range.kind === "unknown-version") {
    const which = range.role === "installed" ? "instalada" : "de destino";
    return { status: "unavailable", reason: `la versión ${which} no se pudo leer: ${range.value}` };
  }
  return { status: "read", installed, target, versions: range.entries.map(toVersionNotice) };
}

function toVersionNotice(entry: ChangelogEntry): VersionContractNotice {
  const { version, contract } = entry;
  if (contract.kind === "changes") {
    return { version, state: "changes", changes: [...contract.changes] };
  }
  if (contract.kind === "malformed") {
    return { version, state: "malformed", problem: contract.problem };
  }
  return { version, state: contract.kind };
}

function unavailable(version: string | null, reason: string): TargetRead {
  return { version, notice: { status: "unavailable", reason } };
}

function readPackMeta(stdout: string): { version: string; filename: string } | string {
  const unreadable = "npm pack no devolvió la versión ni el archivo del paquete";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : null;
  const version = first?.version;
  const filename = first?.filename;
  if (typeof version !== "string" || typeof filename !== "string") return unreadable;
  return { version, filename };
}

const TAR_BLOCK = 512;

/**
 * The text of one regular file inside an uncompressed tar, or null when the
 * archive does not hold it. Read in process: on Windows the `tar` that Git for
 * Windows puts on the PATH takes `C:` for a remote host.
 */
function readTarEntry(tar: Uint8Array, path: string): string | null {
  const bytes = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  let offset = 0;
  while (offset + TAR_BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) return null;
    const size = readOctal(header.subarray(124, 136));
    const start = offset + TAR_BLOCK;
    if (isRegularFile(header) && entryName(header) === path) {
      return bytes.subarray(start, start + size).toString("utf8");
    }
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

function entryName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const isUstar = cString(header.subarray(257, 263)).startsWith("ustar");
  const prefix = isUstar ? cString(header.subarray(345, 500)) : "";
  return prefix === "" ? name : `${prefix}/${name}`;
}

function isRegularFile(header: Buffer): boolean {
  const type = header[156];
  return type === 0 || type === "0".charCodeAt(0);
}

function readOctal(field: Buffer): number {
  const text = cString(field).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`cabecera tar ilegible: tamaño «${text}»`);
  return Number.parseInt(text, 8);
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function firstLine(result: { stdout: string; stderr: string }): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return text.split(/\r?\n/)[0] ?? "";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderNotice(target: TargetRead): string {
  const { notice } = target;
  if (notice.status === "unavailable") {
    const where = target.version === null ? "la versión de destino" : target.version;
    return [
      `Cambios de contrato hacia ${where}: no se pudieron determinar (${notice.reason}).`,
      "Eso no significa que no haya cambios de contrato.",
    ].join("\n");
  }
  const head = `Cambios de contrato de ${notice.installed} (instalada) a ${notice.target}:`;
  if (notice.versions.length === 0) {
    return `${head} ninguna versión intermedia; la de destino no es posterior a la instalada.`;
  }
  const declared = notice.versions.filter((v) => v.state === "changes");
  const unknown = notice.versions.filter(
    (v) => v.state === "undeclared" || v.state === "malformed",
  );
  const lines = [head];
  if (declared.length === 0) {
    lines.push(
      unknown.length === 0
        ? "- Ninguna versión declara cambios de contrato."
        : "- Las versiones que declaran su sección no cambian ningún contrato.",
    );
  }
  for (const version of declared) {
    for (const change of version.changes ?? []) {
      lines.push(
        `- ${version.version}`,
        `  Deja de valer: ${change.stops}`,
        `  Lo reemplaza: ${change.replacedBy}`,
        `  Qué hacer: ${change.action}`,
      );
    }
  }
  for (const version of unknown) {
    const why =
      version.state === "malformed"
        ? `su sección de contrato no se puede leer (${version.problem ?? ""})`
        : "sin declarar";
    lines.push(`- ${version.version}: ${why}; no se sabe si cambia algún contrato.`);
  }
  return lines.join("\n");
}
