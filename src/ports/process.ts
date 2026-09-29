export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Output of a command read as bytes — see `ProcessPort.runBinary`. */
export interface RunBinaryResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * What an inherited-stdio run may be told: where to run, and nothing else.
 *
 * There is deliberately no `env`. The child inherits this process's environment
 * — the same one the person's own shell hands every command they type — and the
 * CLI adds nothing to it. A caller that could compose the child's environment
 * would have somewhere to put a credential, and the only caller of this method
 * exists precisely so that never happens.
 */
export interface InteractiveOptions {
  cwd?: string;
}

export interface ProcessPort {
  /** Runs a command and decodes its whole output as UTF-8. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /**
   * Same as `run`, without decoding. A caller that hashes or measures output
   * needs the bytes git emitted: decoding maps every byte that is not valid
   * UTF-8 to one replacement character, so `git diff --binary` — binary by its
   * own flag — would lose the very content the caller is trying to pin down.
   */
  runBinary(cmd: string, args: string[], opts?: RunOptions): Promise<RunBinaryResult>;
  which(cmd: string): Promise<string | undefined>;
  /**
   * Open a file in an EXTERNAL application — the OS default text editor, or
   * `opts.app` when given — spawned detached so it never captures the TUI's TTY.
   * Failure is observable: rejects if the opener can't be launched (missing
   * binary) or exits non-zero quickly (e.g. macOS `open -a <bad app>`); resolves
   * once the opener is running.
   */
  openPath(path: string, opts?: { app?: string }): Promise<void>;
  /**
   * Whether THIS process owns a terminal a child could inherit.
   *
   * Asked separately from running, because "there is no terminal" is an answer a
   * caller has to be able to give back to a person — not a failure to report
   * after the fact.
   */
  hasTty(): boolean;
  /**
   * Run a command that OWNS the terminal, and return ONLY its exit code.
   *
   * stdio is inherited, so nothing the child prints or reads passes through this
   * process. That is the point and not an optimization: the one caller is an
   * authentication flow, and a secret the person types has to travel from the
   * terminal to the program without this CLI ever holding it. Capturing the
   * output — even to log it — would put the credential in our buffers, so there
   * is no `stdout` in the result to be tempted by.
   */
  runInteractive(cmd: string, args: string[], opts?: InteractiveOptions): Promise<{ code: number }>;
}
