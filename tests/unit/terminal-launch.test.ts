import { describe, expect, it } from "vitest";
import {
  LINUX_TERMINALS,
  buildNixWrapper,
  buildTerminalCommand,
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
});

describe("terminal-launch — per-OS command", () => {
  const opts = {
    wrapperPath: "/tmp/aw-launch.sh",
    cwd: "/src/app",
    command: "npm",
    args: ["run", "dev"],
    title: "app · dev",
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

  it("Windows opens a persistent PowerShell console (-NoExit) that runs the command", () => {
    const cmd = buildTerminalCommand("win32", opts);
    if (cmd.kind !== "terminal") throw new Error("expected terminal");
    expect(cmd.cmd).toBe("powershell");
    expect(cmd.args).toEqual([
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Set-Location '/src/app'; & 'npm' 'run' 'dev'",
    ]);
  });

  it("Windows single-quote-escapes a path containing an apostrophe", () => {
    const cmd = buildTerminalCommand("win32", { ...opts, cwd: "C:/O'Brien/app" });
    if (cmd.kind !== "terminal") throw new Error("expected terminal");
    expect(cmd.args[4]).toContain("Set-Location 'C:/O''Brien/app';");
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
