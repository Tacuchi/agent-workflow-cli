/**
 * Pure, cross-platform construction of the command that opens a file in an
 * EXTERNAL application — the OS default text editor, or a specific app. The
 * adapter (`NodeProcess.openPath`) spawns it detached so it never captures the
 * TUI's TTY (a terminal editor like vim would block Ink; use GUI apps).
 *
 * Impurity-free so the Windows/Linux/macOS shapes are unit-tested deterministically.
 */

export interface OpenCommand {
  cmd: string;
  args: string[];
}

export interface OpenOptions {
  /** Absolute path of the file to open. */
  path: string;
  /** Specific application to open with; when absent, the OS default is used. */
  app?: string;
}

/** Build the OS-specific command that opens `path` (in the default text editor or `app`). */
export function buildOpenCommand(platform: string, opts: OpenOptions): OpenCommand {
  if (platform === "darwin") {
    // `-t` opens in the default TEXT editor (not whatever handles .log); `-a` picks an app.
    return opts.app
      ? { cmd: "open", args: ["-a", opts.app, opts.path] }
      : { cmd: "open", args: ["-t", opts.path] };
  }
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty "" is the (required) window title so a
    // quoted first token isn't mistaken for it. With an app, it precedes the path.
    const tail = opts.app ? ["start", "", opts.app, opts.path] : ["start", "", opts.path];
    return { cmd: "cmd", args: ["/c", ...tail] };
  }
  // linux + anything else: xdg-open for the default handler, or run the app directly.
  return opts.app ? { cmd: opts.app, args: [opts.path] } : { cmd: "xdg-open", args: [opts.path] };
}
