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
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# agent-workflow: wrapper efímero de lanzamiento en terminal (se autoelimina).",
    // Job control: the backgrounded app becomes its own process group, so both
    // the trap and the TUI's killTree(-pid) take down its whole tree (npm→node…).
    "set -m",
    `cd ${shQuote(spec.cwd)} || exit 1`,
  ];
  for (const key of Object.keys(spec.envDelta).sort()) {
    lines.push(`export ${key}=${shSingleQuote(spec.envDelta[key] ?? "")}`);
  }
  const cmdline = [spec.command, ...spec.args].map(shQuote).join(" ");
  // Background the app so we can grab its pid, tee its output to the log, and
  // still keep this shell (→ the window) alive after it exits.
  lines.push(`${cmdline} > >(tee -a ${shQuote(spec.logPath)}) 2>&1 &`);
  lines.push("__aw_pid=$!");
  // Tie the app to this window: closing it (SIGHUP) — or any exit — kills the app's
  // whole process group (npm→node…); non-interactive bash won't forward it for us.
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
  return `${lines.join("\n")}\n`;
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
  if (platform === "win32") {
    // `-NoExit` keeps the console open after the command finishes (crash
    // visibility); the adapter spawns it `detached` (own console) + `windowsHide:false`.
    const psArgs = opts.args.map(psSingleQuote).join(" ");
    const command = `Set-Location ${psSingleQuote(opts.cwd)}; & ${psSingleQuote(opts.command)}${psArgs ? ` ${psArgs}` : ""}`;
    return {
      kind: "terminal",
      cmd: "powershell",
      args: ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }
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
