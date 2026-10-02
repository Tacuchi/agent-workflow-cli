import type { ProcessPort, RunResult } from "../ports/process.js";

/**
 * The only module that knows Herdr's CLI syntax and answer shapes, read from
 * Herdr 0.9.0. Every failure comes back as a degradation instead of a throw, so
 * a missing or changed Herdr never stops what the caller does besides it. It
 * offers no close or rename: the projection only ever adds.
 */

export type HerdrDegradationKind =
  | "missing"
  | "unreachable"
  | "unsupported-version"
  | "cli-changed";

export interface HerdrDegradation {
  kind: HerdrDegradationKind;
  detail: string;
}

export type HerdrResult<T> = { ok: true; value: T } | { ok: false; degradation: HerdrDegradation };

export interface HerdrWorkspace {
  id: string;
  label: string | null;
}

export interface HerdrPane {
  cwd: string | null;
  foreground_cwd: string | null;
}

export interface HerdrTokens {
  pending: number;
  next: string | null;
}

const BINARY = "herdr";
const VERIFIED_MAJOR_MINOR = "0.9";
const METADATA_SOURCE = "aw-hubs";
const METADATA_TTL_MS = "900000";
const NEXT_MAX_CHARS = 80;
/** A server that accepts and never answers must not hang the sync. */
const CALL_TIMEOUT_MS = 5000;

export class HerdrCli {
  constructor(private readonly process: ProcessPort) {}

  /** Present and on the verified version, or why not. */
  async probe(): Promise<HerdrDegradation | null> {
    if ((await this.process.which(BINARY)) === undefined) {
      return { kind: "missing", detail: `${BINARY} no está en el PATH` };
    }
    const answer = await this.exec(["--version"]);
    if (!answer.ok) return answer.degradation;
    const run = answer.value;
    const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(run.stdout);
    if (run.code !== 0 || version === null) {
      return { kind: "cli-changed", detail: `${BINARY} --version no informa una versión` };
    }
    if (`${version[1]}.${version[2]}` !== VERIFIED_MAJOR_MINOR) {
      return {
        kind: "unsupported-version",
        detail: `${BINARY} ${version[0]}; la verificada es ${VERIFIED_MAJOR_MINOR}.x`,
      };
    }
    return null;
  }

  async listWorkspaces(): Promise<HerdrResult<HerdrWorkspace[]>> {
    const answer = await this.call(["workspace", "list"]);
    if (!answer.ok) return answer;
    const list = field(answer.value, "workspaces");
    if (!Array.isArray(list)) return changed("workspace list sin result.workspaces");
    const workspaces: HerdrWorkspace[] = [];
    for (const item of list) {
      const id = field(item, "workspace_id");
      const label = field(item, "label");
      if (typeof id !== "string") return changed("workspace list sin workspace_id");
      workspaces.push({ id, label: typeof label === "string" ? label : null });
    }
    return { ok: true, value: workspaces };
  }

  async listPanes(workspace: string): Promise<HerdrResult<HerdrPane[]>> {
    const answer = await this.call(["pane", "list", "--workspace", workspace]);
    if (!answer.ok) return answer;
    const list = field(answer.value, "panes");
    if (!Array.isArray(list)) return changed("pane list sin result.panes");
    return {
      ok: true,
      value: list.map((pane) => ({
        cwd: stringOrNull(field(pane, "cwd")),
        foreground_cwd: stringOrNull(field(pane, "foreground_cwd")),
      })),
    };
  }

  /** Creates the workspace without focusing it and returns its id. */
  async createWorkspace(cwd: string, label: string): Promise<HerdrResult<string>> {
    const answer = await this.call([
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ]);
    if (!answer.ok) return answer;
    const id = field(field(answer.value, "workspace"), "workspace_id");
    return typeof id === "string"
      ? { ok: true, value: id }
      : changed("workspace create sin workspace.workspace_id");
  }

  /** Display-only sidebar tokens that expire on their own; a null `next` is cleared. */
  async reportMetadata(workspace: string, tokens: HerdrTokens): Promise<HerdrResult<void>> {
    const next =
      tokens.next === null
        ? ["--clear-token", "next"]
        : ["--token", `next=${tokens.next.slice(0, NEXT_MAX_CHARS)}`];
    const answer = await this.exec([
      "workspace",
      "report-metadata",
      workspace,
      "--source",
      METADATA_SOURCE,
      "--token",
      `pending=${tokens.pending}`,
      ...next,
      "--ttl-ms",
      METADATA_TTL_MS,
    ]);
    if (!answer.ok) return answer;
    const run = answer.value;
    return run.code === 0
      ? { ok: true, value: undefined }
      : {
          ok: false,
          degradation: { kind: "unreachable", detail: failure("report-metadata", run.stderr) },
        };
  }

  /** A spawn that fails (binary gone, EAGAIN, timeout) is a degradation, never a throw. */
  private async exec(args: string[]): Promise<HerdrResult<RunResult>> {
    try {
      return {
        ok: true,
        value: await this.process.run(BINARY, args, { timeoutMs: CALL_TIMEOUT_MS }),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const detail = `${args.slice(0, 2).join(" ")}: ${(error as Error).message}`;
      return {
        ok: false,
        degradation: { kind: code === "ENOENT" ? "missing" : "unreachable", detail },
      };
    }
  }

  /** Runs a JSON command and returns its `result`; a failed run means the server did not answer. */
  private async call(args: string[]): Promise<HerdrResult<unknown>> {
    const answer = await this.exec(args);
    if (!answer.ok) return answer;
    const run = answer.value;
    if (run.code !== 0) {
      return {
        ok: false,
        degradation: {
          kind: "unreachable",
          detail: failure(args.slice(0, 2).join(" "), run.stderr),
        },
      };
    }
    try {
      const result = field(JSON.parse(run.stdout), "result");
      return result === undefined
        ? changed(`${args.slice(0, 2).join(" ")} sin result`)
        : { ok: true, value: result };
    } catch {
      return changed(`${args.slice(0, 2).join(" ")} no devolvió JSON`);
    }
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function changed<T>(detail: string): HerdrResult<T> {
  return { ok: false, degradation: { kind: "cli-changed", detail } };
}

function failure(command: string, stderr: string): string {
  const reason = stderr.trim().split("\n")[0];
  return reason ? `${command}: ${reason}` : `${command} salió con error`;
}
