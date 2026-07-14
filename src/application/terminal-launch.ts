/**
 * Pure, cross-platform construction of the command that opens a *visible,
 * persistent* terminal window for a source launch, plus the *nix wrapper script
 * that runs inside it.
 *
 * The window must stay open (to monitor the app live) and closing it must stop
 * the app. To also keep the TUI process registry
 * working, the wrapper captures the *real* app PID into a pidfile the adapter
 * reads back (on Windows the inline -Command body writes its own $PID — the
 * visible console's PowerShell, which parents the app; no wrapper file exists
 * there — see buildWinCommandBody).
 *
 * This module is impurity-free so the Windows/Linux/macOS shapes are unit-tested
 * deterministically; the adapter (`NodeProcess.spawnInTerminal`) does the I/O
 * (write wrapper, spawn, poll pidfile, fall back to background when there is no
 * terminal).
 */

/** A source's launch command, or `kind:"none"` when no terminal is available. */
export type TerminalCommand = { kind: "terminal"; cmd: string; args: string[] } | { kind: "none" };

export interface WrapperSpec {
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
export function buildNixWrapper(spec: WrapperSpec): string {
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
function appendBuildStep(lines: string[], spec: WrapperSpec): void {
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
function appendInteractiveLaunch(lines: string[], spec: WrapperSpec, cmdline: string): void {
  lines.push(`printf '%s' "$$" > ${shQuote(spec.pidFile)}`);
  lines.push(`exec ${cmdline}`);
}

/**
 * Server/long-running: background so we grab its pid, tee output to the log, and
 * keep the window alive after it exits. Closing it (SIGHUP) — or any exit — kills
 * the app's whole process group (npm→node…).
 */
function appendServerLaunch(lines: string[], spec: WrapperSpec, cmdline: string): void {
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
  // win32 is NOT dispatched here: Windows tries an ordered hop cascade — see
  // buildWinHops — driven by the adapter, so it falls through to kind:"none".
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

/** The adapter drops this marker next to the pidfile when it gives up waiting
 * and falls back to a background launch; a late console must NOT double-launch. */
export function abortFileFor(pidFile: string): string {
  return `${pidFile}.abort`;
}

/**
 * Assemble the one-line `-Command` body the visible Windows console runs. It
 * travels INLINE (never as a .ps1 file) on purpose: GPO-enforced ExecutionPolicy
 * (AllSigned/Restricted) refuses unsigned script files but does not govern
 * `-Command`, and no file also means no unlink races. Two invariants keep the
 * body intact across the child powershell.exe re-join of its command line
 * (double quotes are eaten, spaces re-joined singly): NO double quotes, NO runs
 * of consecutive spaces — everything is single-quoted via psSingleQuote.
 *
 * Ignores `envDelta` on purpose: unlike Terminal.app / gnome-terminal-server,
 * the whole Windows chain (launcher hop → console, see buildWinHops) inherits
 * our env, so secrets never touch disk. `mode` is also moot here: both modes run the app
 * in the foreground of its own console (a real TTY), kept open by `-NoExit`;
 * the server-mode log tee is not implemented (PS 5.1 Tee-Object writes UTF-16,
 * which would garble the TUI's log viewer).
 */
export function buildWinCommandBody(spec: WrapperSpec): string {
  const title = psSingleQuote(spec.title);
  const statements: string[] = [
    // First statement: hand this console's PID to the adapter (it polls the pidfile).
    `Set-Content -LiteralPath ${psSingleQuote(spec.pidFile)} -Value $PID`,
    `$Host.UI.RawUI.WindowTitle = ${title}`,
    `Set-Location -LiteralPath ${psSingleQuote(spec.cwd)}`,
  ];
  if (spec.build) {
    statements.push(psInvoke(spec.build.command, spec.build.args));
    // `return` (never `exit`, which would defeat -NoExit) keeps the window open on failure.
    statements.push(
      `if ($LASTEXITCODE -ne 0) { Write-Host ('[build fallido — {0} · cerrá esta ventana]' -f ${title}); return }`,
    );
  }
  // As late as possible before the launch: if the adapter already fell back to a
  // background process (pidfile poll timed out), abort instead of double-launching.
  statements.push(
    `if (Test-Path -LiteralPath ${psSingleQuote(abortFileFor(spec.pidFile))}) { Remove-Item -LiteralPath ${psSingleQuote(abortFileFor(spec.pidFile))},${psSingleQuote(spec.pidFile)} -ErrorAction SilentlyContinue; Write-Host ('[{0} — este intento fue reemplazado · cerrá esta ventana]' -f ${title}); return }`,
  );
  statements.push(psInvoke(spec.command, spec.args));
  statements.push(
    `Write-Host ('[{0} — código {1} · cerrá esta ventana]' -f ${title}, $LASTEXITCODE)`,
  );
  return statements.join("; ");
}

/** One way to open the visible Windows console; the adapter tries them in order. */
export interface WinHop {
  /** Diagnostic label for the operational log ("Start-Process" | "conhost"). */
  label: string;
  cmd: string;
  args: string[];
}

/**
 * Ordered launcher hops for Windows. Node cannot ask CreateProcess for a new
 * console — a `detached` spawn maps to DETACHED_PROCESS, which starts the child
 * with NO console at all (the "own console window" in the Node docs is a myth) —
 * so something else must create the window:
 *  1. `Start-Process` (ShellExecute) from a hidden short-lived PowerShell. The
 *     body rides -ArgumentList as its last element: PS 5.1 joins the list with
 *     bare spaces and powershell.exe -Command re-joins the tail, so it
 *     round-trips under the buildWinCommandBody invariants.
 *  2. `conhost.exe` hosting the inner PowerShell directly — plain CreateProcess,
 *     no ShellExecute and no powershell-spawns-powershell chain, for
 *     environments where hop 1 is blocked (EDR/AppLocker-style rules).
 * Both open the same persistent inner PowerShell (`-NoProfile` deterministic
 * start · `-NoExit` crash visibility) running `body` inline. The caller gives
 * each attempt its OWN pidfile/body so one hop's abort marker can never cancel
 * the next hop's console.
 */
export function buildWinHops(body: string, cwd: string): WinHop[] {
  const inner = ["-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command"];
  // 'Stop' turns a Start-Process failure into a non-zero launcher exit → fast fallback.
  const argList = [...inner, body].map(psSingleQuote).join(",");
  const startProcess = `$ErrorActionPreference='Stop'; Start-Process -FilePath 'powershell' -ArgumentList ${argList} -WorkingDirectory ${psSingleQuote(cwd)}`;
  return [
    {
      label: "Start-Process",
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startProcess],
    },
    // conhost hands its tail to CreateProcess verbatim; the body survives libuv's
    // quoting because it contains no double quotes (buildWinCommandBody invariant).
    { label: "conhost", cmd: "conhost.exe", args: ["powershell", ...inner, body] },
  ];
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
