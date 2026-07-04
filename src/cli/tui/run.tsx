import { render } from "ink";
import type { CliContext } from "../types.js";
import { App, type TuiResult } from "./app.js";
import { applyAccent } from "./theme.js";
import { TuiPrefsService } from "./tui-prefs.js";

// Alternate screen buffer (alt-screen) ANSI sequences.
// `?1049h` enters (saves the current screen), `?1049l` leaves (restores it).
// Same mechanism vim/htop/lazygit use: the TUI lives on an isolated canvas and
// leaves no trace in the scrollback on exit — the root cause of orphan lines.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const CLEAR_HOME = "\x1b[2J\x1b[H";

/**
 * Enters the alt-screen and returns an idempotent `restore()`. No-op when
 * stdout is not a TTY (CI, pipes). Registers a safety net on `exit`/`SIGTERM`
 * so the terminal is not left trapped in the alternate buffer if the process
 * dies.
 */
function enterAltScreen(stdout: NodeJS.WriteStream): () => void {
  if (!stdout.isTTY) return () => {};
  stdout.write(ALT_SCREEN_ENTER + CLEAR_HOME);

  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    stdout.write(ALT_SCREEN_LEAVE);
    process.off("exit", restore);
    process.off("SIGTERM", onSigterm);
  }
  function onSigterm() {
    restore();
    process.exit(143);
  }
  process.once("exit", restore);
  process.once("SIGTERM", onSigterm);
  return restore;
}

export async function runTui(version: string, ctx: CliContext): Promise<TuiResult> {
  let resolveResult!: (result: TuiResult) => void;
  const resultPromise = new Promise<TuiResult>((resolve) => {
    resolveResult = resolve;
  });

  let resolved = false;
  const settle = (result: TuiResult) => {
    if (resolved) return;
    resolved = true;
    resolveResult(result);
  };

  // Load prefs and apply the accent BEFORE the first render (no color flash).
  const prefs = await new TuiPrefsService(ctx.fs, ctx.paths).load();
  applyAccent(prefs.accentColor);

  const restoreScreen = enterAltScreen(process.stdout);

  const instance = render(
    <App version={version} ctx={ctx} onResult={settle} initialPrefs={prefs} />,
    { exitOnCtrlC: true },
  );

  instance
    .waitUntilExit()
    .then(() => settle({ kind: "exit", exitCode: 0 }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`tui error: ${message}\n`);
      settle({ kind: "exit", exitCode: 1 });
    });

  const result = await resultPromise;

  // Await full ink unmount before returning. Otherwise the caller can race
  // ink's teardown — for example dispatching `aw self update` would let
  // inquirer take over a stdin still being released, causing a phantom
  // "(cancelled)" because residual bytes look like a force-close.
  try {
    await instance.waitUntilExit();
  } catch {
    // already logged above
  }

  // Leave the alt-screen only once Ink has fully unmounted: its final erase
  // then happens on the alternate buffer and the user's screen comes back
  // clean. Must happen before returning so post-TUI actions (e.g. `self
  // update` with inquirer) run on the main screen.
  restoreScreen();

  return result;
}
