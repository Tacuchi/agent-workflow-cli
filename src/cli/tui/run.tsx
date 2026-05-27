import { render } from "ink";
import type { CliContext } from "../types.js";
import { App, type TuiResult } from "./app.js";
import { applyAccent } from "./theme.js";
import { TuiPrefsService } from "./tui-prefs.js";

// Secuencias ANSI del buffer alternativo de pantalla (alt-screen).
// `?1049h` entra (guarda la pantalla actual), `?1049l` sale (la restaura). Es lo
// que usan vim/htop/lazygit: el TUI vive en un lienzo aislado y al salir no deja
// rastro en el scrollback — la causa raíz de las líneas huérfanas (image #1).
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const CLEAR_HOME = "\x1b[2J\x1b[H";

/**
 * Entra al alt-screen y devuelve un `restore()` idempotente. No-op si stdout no
 * es TTY (CI, pipes). Registra una red de seguridad en `exit`/`SIGTERM` para no
 * dejar la terminal atrapada en el buffer alternativo si el proceso muere.
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

  // Carga prefs y aplica el accent ANTES del primer render (sin flash de color).
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

  // Sale del alt-screen recién cuando Ink desmontó del todo: su último erase
  // ocurre sobre el buffer alternativo y la pantalla del usuario vuelve limpia.
  // Debe pasar antes de devolver para que acciones post-TUI (p.ej. `self update`
  // con inquirer) corran sobre la pantalla principal.
  restoreScreen();

  return result;
}
