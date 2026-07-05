/**
 * Pure, cross-platform construction of the command that opens a *visible,
 * persistent* terminal window for a source launch, plus the *nix wrapper script
 * that runs inside it.
 *
 * The window must stay open (to monitor the app live) and closing it must stop
 * the app. To also keep the TUI process registry
 * working, the wrapper captures the *real* app PID into a pidfile the adapter
 * reads back (on Windows we track the console PID instead — see the adapter).
 *
 * This module is impurity-free so the Windows/Linux/macOS shapes are unit-tested
 * deterministically; the adapter (`NodeProcess.spawnInTerminal`) does the I/O
 * (write wrapper, spawn, poll pidfile, fall back to background when there is no
 * terminal).
 */

/** A source's launch command, or `kind:"none"` when no terminal is available. */
export type TerminalCommand = { kind: "terminal"; cmd: string; args: string[] } | { kind: "none" };

export interface NixWrapperSpec {
  /** Working directory the command runs from. */
  cwd: string;
  /**
   * `interactive` — the app owns the TTY (foreground `exec`, no tee); required by
   * TUIs/REPLs. `server` (default) — backgrounded + tee'd to the log, window kept
   * open to monitor and close-to-stop. Defaults to `server` when omitted.
   */
  mode?: "interactive" | "server" | undefined;
  /** Optional build/compile step run (from `cwd`, with the same env) before the launch. */
  build?: { command: string; args: string[] } | undefined;
  /** Launch command + args (already resolved from the descriptor). */
  command: string;
  args: string[];
  /**
   * Environment deltas over the inherited base env (params + PROFILE), baked as
   * exports so they survive terminals that do NOT inherit our env (Terminal.app
   * `do script`, gnome-terminal-server). Secrets are included — the wrapper is a
   * 0700 temp file the adapter unlinks right after launch.
   */
  envDelta: Record<string, string>;
  /** File the wrapper writes the app PID to (the adapter reads it back). */
  pidFile: string;
  /** Log file the output is tee'd to (so the TUI "Ver log" keeps working). */
  logPath: string;
  /** Label shown in the exit line when the app finishes. */
  title: string;
}

export interface TerminalCommandOptions {
  /** *nix: absolute path to the wrapper file (run via `bash <wrapper>`). */
  wrapperPath: string;
  /** Working directory (Windows bakes it via `Set-Location`). */
  cwd: string;
  /** Optional build step (Windows bakes it into `-Command` before the launch). */
  build?: { command: string; args: string[] } | undefined;
  /** Launch command + args (Windows bakes them into `-Command`). */
  command: string;
  args: string[];
  /** Window title / exit-line label. */
  title: string;
  /** Linux: emulator basenames found on PATH (adapter resolves via `which`). */
  linuxTerminals: string[];
  /** Linux: whether a GUI display is present (DISPLAY / WAYLAND_DISPLAY). */
  hasDisplay: boolean;
}

/**
 * Known Linux terminal emulators, in priority order, with how to invoke each to
 * run `bash <wrapper>`. `x-terminal-emulator` is first so the Debian-alternatives
 * choice (the user's default) wins.
 */
export const LINUX_TERMINALS: { bin: string; toArgs: (wrapper: string) => string[] }[] = [
  { bin: "x-terminal-emulator", toArgs: (w) => ["-e", "bash", w] },
  { bin: "gnome-terminal", toArgs: (w) => ["--", "bash", w] },
  { bin: "konsole", toArgs: (w) => ["-e", "bash", w] },
  // `-x` (execute) consumes the rest of argv as a real vector; `--command` would
  // re-parse a string via GLib's non-shell parser (wrong quoting dialect).
  { bin: "xfce4-terminal", toArgs: (w) => ["-x", "bash", w] },
  { bin: "alacritty", toArgs: (w) => ["-e", "bash", w] },
  { bin: "kitty", toArgs: (w) => ["bash", w] },
  { bin: "xterm", toArgs: (w) => ["-e", "bash", w] },
];

/** Assemble the bash wrapper that runs inside the *nix terminal window. */
export function buildNixWrapper(spec: NixWrapperSpec): string {
  const interactive = spec.mode === "interactive";
  const cmdline = [spec.command, ...spec.args].map(shQuote).join(" ");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# agent-workflow: wrapper efímero de lanzamiento en terminal (se autoelimina).",
  ];
  // Server mode backgrounds the app into its own process group → the trap and the
  // TUI's killTree(-pid) take down its whole tree (npm→node…). Interactive owns the
  // TTY in the foreground, so no job control.
  if (!interactive) lines.push("set -m");
  lines.push(`cd ${shQuote(spec.cwd)} || exit 1`);
  for (const key of Object.keys(spec.envDelta).sort()) {
    lines.push(`export ${key}=${shSingleQuote(spec.envDelta[key] ?? "")}`);
  }
  appendBuildStep(lines, spec);
  if (interactive) appendInteractiveLaunch(lines, spec, cmdline);
  else appendServerLaunch(lines, spec, cmdline);
  return `${lines.join("\n")}\n`;
}

/** Build before launch (same env, output tee'd to the log); keep the window open on failure. Shared by both modes. */
function appendBuildStep(lines: string[], spec: NixWrapperSpec): void {
  if (!spec.build) return;
  const buildLine = [spec.build.command, ...spec.build.args].map(shQuote).join(" ");
  lines.push(`${buildLine} 2>&1 | tee -a ${shQuote(spec.logPath)}`);
  lines.push(
    `if [ "\${PIPESTATUS[0]}" -ne 0 ]; then printf '\\n[build fallido — %s · cerrá esta ventana]\\n' ${shQuote(spec.title)}; exec "\${SHELL:-bash}"; fi`,
  );
}

/**
 * Interactive: the app OWNS the terminal — foreground with a real TTY on stdin+
 * stdout (Ink checks `stdout.isTTY`), no tee, no backgrounding. `exec` preserves
 * this shell's PID, so the pidfile (written first) already holds the app's pid for
 * the registry. The window closes when the app exits (you quit the TUI → done).
 */
function appendInteractiveLaunch(lines: string[], spec: NixWrapperSpec, cmdline: string): void {
  lines.push(`printf '%s' "$$" > ${shQuote(spec.pidFile)}`);
  lines.push(`exec ${cmdline}`);
}

/**
 * Server/long-running: background so we grab its pid, tee output to the log, and
 * keep the window alive after it exits. Closing it (SIGHUP) — or any exit — kills
 * the app's whole process group (npm→node…).
 */
function appendServerLaunch(lines: string[], spec: NixWrapperSpec, cmdline: string): void {
  lines.push(`${cmdline} > >(tee -a ${shQuote(spec.logPath)}) 2>&1 &`);
  lines.push("__aw_pid=$!");
  lines.push(
    `trap 'kill -TERM -"$__aw_pid" 2>/dev/null || kill -TERM "$__aw_pid" 2>/dev/null' EXIT HUP TERM INT`,
  );
  lines.push(`printf '%s' "$__aw_pid" > ${shQuote(spec.pidFile)}`);
  lines.push('wait "$__aw_pid"');
  lines.push("__aw_ec=$?");
  lines.push(
    `printf '\\n[%s — código %s · cerrá esta ventana para detener]\\n' ${shQuote(spec.title)} "$__aw_ec"`,
  );
  lines.push('exec "${SHELL:-bash}"');
}

/** Build the OS-specific command that opens the persistent terminal window. */
export function buildTerminalCommand(
  platform: string,
  opts: TerminalCommandOptions,
): TerminalCommand {
  if (platform === "darwin") {
    // Terminal.app runs the wrapper via AppleScript; `do script` opens a new
    // window that stays open while the shell (the wrapper) lives.
    const inner = `bash ${shQuote(opts.wrapperPath)}`;
    const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      kind: "terminal",
      cmd: "osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script "${escaped}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
    };
  }
  if (platform === "win32") return buildWin32Command(opts);
  if (platform === "linux") {
    if (!opts.hasDisplay) return { kind: "none" };
    for (const t of LINUX_TERMINALS) {
      if (opts.linuxTerminals.includes(t.bin)) {
        return { kind: "terminal", cmd: t.bin, args: t.toArgs(opts.wrapperPath) };
      }
    }
    return { kind: "none" };
  }
  return { kind: "none" };
}

/** PowerShell invocation `& 'cmd' 'arg1' 'arg2'` (call operator, single-quoted). */
function psInvoke(command: string, args: string[]): string {
  const quoted = args.map(psSingleQuote).join(" ");
  return `& ${psSingleQuote(command)}${quoted ? ` ${quoted}` : ""}`;
}

/**
 * Windows: a persistent PowerShell console (`-NoExit` keeps it open after the
 * command finishes → crash visibility; the adapter spawns it `detached` with its
 * own console). Builds first when a build step is present, aborting on failure.
 */
function buildWin32Command(opts: TerminalCommandOptions): TerminalCommand {
  const buildPart = opts.build
    ? `${psInvoke(opts.build.command, opts.build.args)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; `
    : "";
  const command = `Set-Location ${psSingleQuote(opts.cwd)}; ${buildPart}${psInvoke(opts.command, opts.args)}`;
  return {
    kind: "terminal",
    cmd: "powershell",
    args: ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command],
  };
}

// --- quoting helpers -------------------------------------------------------

/** POSIX shell quoting: bare when safe, else single-quoted with `'` escaped. */
function shQuote(v: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : shSingleQuote(v);
}

/** Always single-quote (no expansion) — safe for baked env values incl. secrets. */
function shSingleQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quote literal: wrap in `'…'` with `'` doubled. */
function psSingleQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
