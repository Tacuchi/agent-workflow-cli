import { describe, expect, it } from "vitest";
import {
  LINUX_TERMINALS,
  buildNixWrapper,
  buildTerminalCommand,
  buildWinCommandBody,
  buildWinHops,
} from "../../src/application/terminal-launch.js";

describe("terminal-launch — *nix wrapper", () => {
  const base = {
    cwd: "/src/app",
    command: "npm",
    args: ["run", "dev"],
    envDelta: {} as Record<string, string>,
    pidFile: "/tmp/aw.pid",
    logPath: "/logs/app.log",
    title: "app · dev",
  };

  it("cd's to the source, keeps the window open, and captures the app pid", () => {
    const w = buildNixWrapper(base);
    expect(w.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    // Job control so the backgrounded app is its OWN process group → tree-killable.
    expect(w).toContain("set -m");
    expect(w).toContain("cd /src/app || exit 1"); // safe path → left bare (as renderRunSh does)
    // The command runs in the background so we can capture its pid, tee to the log,
    // and still leave the window under an interactive shell after it exits.
    expect(w).toContain("npm run dev > >(tee -a /logs/app.log) 2>&1 &");
    expect(w).toContain("__aw_pid=$!");
    expect(w).toContain("printf '%s' \"$__aw_pid\" > /tmp/aw.pid");
    expect(w).toContain('wait "$__aw_pid"');
    // Window stays open after the app exits (crash visibility).
    expect(w).toContain('exec "${SHELL:-bash}"');
  });

  it("traps window-close/HUP to kill the app's whole process GROUP (so closing = stop the tree)", () => {
    const w = buildNixWrapper(base);
    // Negative pid = kill the group (app + its children), with a lone-pid fallback.
    expect(w).toContain('trap \'kill -TERM -"$__aw_pid" 2>/dev/null || kill -TERM "$__aw_pid"');
    expect(w).toContain("EXIT HUP TERM INT");
    // The trap must be armed only after we know the pid.
    expect(w.indexOf("__aw_pid=$!")).toBeLessThan(w.indexOf("trap "));
  });

  it("bakes env deltas (incl. secrets) as single-quoted exports, sorted", () => {
    const w = buildNixWrapper({
      ...base,
      envDelta: { PROFILE: "dev", PORT: "8080", API_TOKEN: "sk-'quote" },
    });
    const lines = w.split("\n");
    const exports = lines.filter((l) => l.startsWith("export "));
    expect(exports).toEqual([
      "export API_TOKEN='sk-'\\''quote'",
      "export PORT='8080'",
      "export PROFILE='dev'",
    ]);
  });

  it("shell-quotes a cwd/command with spaces", () => {
    const w = buildNixWrapper({ ...base, cwd: "/My Src/app", command: "./run me.sh", args: [] });
    expect(w).toContain("cd '/My Src/app' || exit 1");
    expect(w).toContain("'./run me.sh' > >(tee -a /logs/app.log) 2>&1 &");
  });

  it("runs the build step (tee'd to the log) before the app, keeping the window open on build failure", () => {
    const w = buildNixWrapper({ ...base, build: { command: "npm", args: ["run", "build"] } });
    expect(w).toContain("npm run build 2>&1 | tee -a /logs/app.log");
    expect(w).toContain('if [ "${PIPESTATUS[0]}" -ne 0 ];');
    // Build precedes the backgrounded app launch.
    expect(w.indexOf("npm run build")).toBeLessThan(w.indexOf("npm run dev >"));
  });

  it("interactive mode execs the app in the foreground (owns the TTY), no tee/background/trap", () => {
    const w = buildNixWrapper({
      ...base,
      mode: "interactive",
      command: "node",
      args: ["dist/x.js"],
    });
    // exec replaces the shell → the app inherits the terminal TTY (Ink needs it).
    expect(w).toContain("exec node dist/x.js");
    // pidfile holds the exec'd process pid ($$ survives exec).
    expect(w).toContain("printf '%s' \"$$\" > /tmp/aw.pid");
    // None of the server machinery: no job control, no tee-to-pipe, no group-kill trap.
    expect(w).not.toContain("set -m");
    expect(w).not.toContain("> >(tee");
    expect(w).not.toContain("trap ");
    expect(w).not.toContain("__aw_pid=$!");
  });

  it("interactive mode still builds first (tee'd) when a build step is present", () => {
    const w = buildNixWrapper({
      ...base,
      mode: "interactive",
      command: "node",
      args: ["dist/x.js"],
      build: { command: "npm", args: ["run", "build"] },
    });
    expect(w).toContain("npm run build 2>&1 | tee -a /logs/app.log");
    expect(w.indexOf("npm run build")).toBeLessThan(w.indexOf("exec node dist/x.js"));
  });

  it("omitting mode defaults to server (background + tee + keep-open)", () => {
    const w = buildNixWrapper(base); // no mode
    expect(w).toContain("set -m");
    expect(w).toContain("npm run dev > >(tee -a /logs/app.log) 2>&1 &");
    expect(w).toContain("trap ");
  });
});

describe("terminal-launch — Windows inline body", () => {
  const base = {
    cwd: "C:/src/app",
    command: ".\\mvnw.cmd",
    args: ["spring-boot:run"],
    envDelta: { API_TOKEN: "sk-secret" } as Record<string, string>,
    pidFile: "C:/Temp/aw.pid",
    logPath: "C:/logs/app.log",
    title: "app · dev",
  };

  it("writes its own console PID to the pidfile FIRST, then titles and cd's to the source", () => {
    const w = buildWinCommandBody(base);
    // The adapter polls the pidfile: it must be the very first statement.
    expect(w.startsWith("Set-Content -LiteralPath 'C:/Temp/aw.pid' -Value $PID; ")).toBe(true);
    expect(w).toContain("$Host.UI.RawUI.WindowTitle = 'app · dev'");
    expect(w).toContain("Set-Location -LiteralPath 'C:/src/app'");
    expect(w).toContain("& '.\\mvnw.cmd' 'spring-boot:run'");
  });

  it("stays one line, with no double quotes and no double spaces (survives the child's command-line re-join)", () => {
    const w = buildWinCommandBody({ ...base, build: { command: "npm", args: ["run", "build"] } });
    expect(w).not.toContain("\n");
    expect(w).not.toContain('"');
    expect(w).not.toMatch(/ {2}/);
  });

  it("aborts (with a message) instead of launching when the adapter left the abort marker", () => {
    const w = buildWinCommandBody(base);
    expect(w).toContain("if (Test-Path -LiteralPath 'C:/Temp/aw.pid.abort')");
    expect(w).toContain(
      "Remove-Item -LiteralPath 'C:/Temp/aw.pid.abort','C:/Temp/aw.pid' -ErrorAction SilentlyContinue",
    );
    // The check guards the launch itself: it must sit right before the app command.
    expect(w.indexOf("Test-Path")).toBeLessThan(w.indexOf("& '.\\mvnw.cmd'"));
  });

  it("reports the exit code when the app finishes", () => {
    const w = buildWinCommandBody(base);
    expect(w).toContain(
      "Write-Host ('[{0} — código {1} · cerrá esta ventana]' -f 'app · dev', $LASTEXITCODE)",
    );
  });

  it("never bakes env deltas — secrets ride via the inherited env, not disk", () => {
    const w = buildWinCommandBody(base);
    expect(w).not.toContain("API_TOKEN");
    expect(w).not.toContain("sk-secret");
    expect(w).not.toContain("$env:");
  });

  it("builds first (before the abort check), guarding failure with `return` (never `exit`, which would defeat -NoExit)", () => {
    const w = buildWinCommandBody({ ...base, build: { command: "npm", args: ["run", "build"] } });
    expect(w).toContain("& 'npm' 'run' 'build'");
    expect(w).toContain(
      "if ($LASTEXITCODE -ne 0) { Write-Host ('[build fallido — {0} · cerrá esta ventana]' -f 'app · dev'); return }",
    );
    expect(w).not.toContain("exit ");
    expect(w.indexOf("'build'")).toBeLessThan(w.indexOf("Test-Path"));
    expect(w.indexOf("Test-Path")).toBeLessThan(w.indexOf("& '.\\mvnw.cmd'"));
  });

  it("single-quote-escapes apostrophes in title/cwd", () => {
    const w = buildWinCommandBody({ ...base, title: "O'Brien", cwd: "C:/O'Brien/app" });
    expect(w).toContain("$Host.UI.RawUI.WindowTitle = 'O''Brien'");
    expect(w).toContain("Set-Location -LiteralPath 'C:/O''Brien/app'");
  });
});

describe("terminal-launch — Windows hops", () => {
  const body = "Set-Content -LiteralPath 'C:/T/aw.pid' -Value $PID; & 'npm' 'run' 'dev'";

  it("hop 1 is a hidden Start-Process hop passing the body inline (a detached spawn alone gets NO console)", () => {
    const hop = buildWinHops(body, "/src/app")[0];
    expect(hop?.label).toBe("Start-Process");
    expect(hop?.cmd).toBe("powershell");
    expect(hop?.args).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      // The body rides -ArgumentList as one single-quoted element ('' = escaped
      // quote); -Command as the last args re-join without loss (no double quotes).
      "$ErrorActionPreference='Stop'; Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-Command','Set-Content -LiteralPath ''C:/T/aw.pid'' -Value $PID; & ''npm'' ''run'' ''dev''' -WorkingDirectory '/src/app'",
    ]);
  });

  it("hop 2 hosts the inner PowerShell under conhost.exe (plain CreateProcess, no ShellExecute, no ps→ps)", () => {
    const hop = buildWinHops(body, "/src/app")[1];
    expect(hop?.label).toBe("conhost");
    expect(hop?.cmd).toBe("conhost.exe");
    // The body rides argv untouched — libuv's quoting is safe because the body
    // carries no double quotes (buildWinCommandBody invariant).
    expect(hop?.args).toEqual([
      "powershell",
      "-NoProfile",
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      body,
    ]);
  });

  it("hop 1 single-quote-escapes apostrophes in the cwd", () => {
    const hop = buildWinHops("& 'x'", "C:/O'Brien/app")[0];
    expect(hop?.args[4]).toContain("-WorkingDirectory 'C:/O''Brien/app'");
  });
});

describe("terminal-launch — per-OS command", () => {
  const opts = {
    wrapperPath: "/tmp/aw-launch.sh",
    linuxTerminals: [] as string[],
    hasDisplay: true,
  };

  it("macOS opens Terminal.app via osascript running the wrapper, and activates it", () => {
    const cmd = buildTerminalCommand("darwin", opts);
    expect(cmd.kind).toBe("terminal");
    if (cmd.kind !== "terminal") return;
    expect(cmd.cmd).toBe("osascript");
    expect(cmd.args).toEqual([
      "-e",
      'tell application "Terminal" to do script "bash /tmp/aw-launch.sh"',
      "-e",
      'tell application "Terminal" to activate',
    ]);
  });

  it("macOS escapes a wrapper path with spaces inside the AppleScript string", () => {
    const cmd = buildTerminalCommand("darwin", { ...opts, wrapperPath: "/tmp/aw launch.sh" });
    if (cmd.kind !== "terminal") throw new Error("expected terminal");
    // shQuote wraps the path in single quotes; those survive inside the AppleScript "…".
    expect(cmd.args[1]).toBe(
      'tell application "Terminal" to do script "bash \'/tmp/aw launch.sh\'"',
    );
  });

  it("win32 is not dispatched here (the adapter drives the hop cascade) → kind:none", () => {
    expect(buildTerminalCommand("win32", opts).kind).toBe("none");
  });

  it("Linux picks the first available emulator by priority and runs the wrapper", () => {
    const cmd = buildTerminalCommand("linux", {
      ...opts,
      linuxTerminals: ["xterm", "gnome-terminal"],
    });
    if (cmd.kind !== "terminal") throw new Error("expected terminal");
    // gnome-terminal outranks xterm in LINUX_TERMINALS.
    expect(cmd.cmd).toBe("gnome-terminal");
    expect(cmd.args).toEqual(["--", "bash", "/tmp/aw-launch.sh"]);
  });

  it("Linux xfce4-terminal uses -x (argv-native), not --command (GLib shell-parsed)", () => {
    const cmd = buildTerminalCommand("linux", { ...opts, linuxTerminals: ["xfce4-terminal"] });
    if (cmd.kind !== "terminal") throw new Error("expected terminal");
    expect(cmd.cmd).toBe("xfce4-terminal");
    // -x consumes the remaining argv as a real vector — no shell-quoting mismatch.
    expect(cmd.args).toEqual(["-x", "bash", "/tmp/aw-launch.sh"]);
  });

  it("Linux falls back (kind:none) with no emulator or no display", () => {
    expect(buildTerminalCommand("linux", { ...opts, linuxTerminals: [] }).kind).toBe("none");
    expect(
      buildTerminalCommand("linux", {
        ...opts,
        linuxTerminals: ["gnome-terminal"],
        hasDisplay: false,
      }).kind,
    ).toBe("none");
  });

  it("an unknown platform yields kind:none (caller falls back to background)", () => {
    expect(buildTerminalCommand("aix", opts).kind).toBe("none");
  });

  it("LINUX_TERMINALS lists x-terminal-emulator first for Debian-alternatives respect", () => {
    expect(LINUX_TERMINALS[0]?.bin).toBe("x-terminal-emulator");
    expect(LINUX_TERMINALS.map((t) => t.bin)).toContain("gnome-terminal");
  });
});
