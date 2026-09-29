// The Herdr commands the run issues, as argv, and a thin client over an injected
// executor. Syntax read from `herdr <group> <cmd> --help` of Herdr 0.9.0 and its
// CLI reference. Response fields follow its API schema where it types them
// (`workspace_created` → workspace + root_pane, `agent_info` → agent_status);
// `agent_explain` is untyped there (`explain: true`), so it is read defensively.
//
// A pane with a recognized agent (Herdr kind) goes through `herdr agent …`, which
// knows idle/working/blocked. crush has no Herdr kind: its pane is driven through
// `herdr pane …` and its state is inferred from the screen (`screenState`).

import { QUESTION_MARKERS, isPermissionScreen } from "./classifier.mjs";

export const herdrArgv = {
  createWorkspace: (cwd, label) => [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    label,
    "--no-focus",
  ],
  closeWorkspace: (id) => ["workspace", "close", id],
  closePane: (id) => ["pane", "close", id],
  run: (pane, command) => ["pane", "run", pane, command],
  agentGet: (pane) => ["agent", "get", pane],
  agentRead: (pane) => ["agent", "read", pane, "--source", "recent-unwrapped", "--lines", "120"],
  // Screen-only panes are read as the VISIBLE screen (`--source visible`, herdr
  // agent/pane read --help): their whole-screen permission veto must not trip
  // on a word that scrolled away long ago.
  paneRead: (pane) => ["pane", "read", pane, "--source", "visible"],
  explain: (pane) => ["agent", "explain", pane, "--json"],
  agentPrompt: (pane, text) => ["agent", "prompt", pane, text],
  agentKeys: (pane, keys) => ["agent", "send-keys", pane, ...keys],
  paneText: (pane, text) => ["pane", "send-text", pane, text],
  paneKeys: (pane, keys) => ["pane", "send-keys", pane, ...keys],
};

function parse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Reads a field that Herdr may nest under `.result` (its creation responses do). */
const dig = (obj, ...path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * `agent get` answers `agent_info` whose agent carries `agent_status`
 * (idle|working|blocked|done|unknown) — from Herdr 0.9.0's API schema.
 */
export function agentStatus(json) {
  const s =
    dig(json, "result", "agent", "agent_status") ??
    dig(json, "agent", "agent_status") ??
    dig(json, "result", "agent", "status") ??
    json?.status;
  return typeof s === "string" ? s : "unknown";
}

/** Consecutive identical reads before a screen-only pane counts as idle. */
export const STABLE_READS = 3;

/**
 * crush's state from its screen alone (unverified against a live crush pane).
 * A question or permission reads as blocked. `idle` needs the same screen for
 * STABLE_READS reads in a row with no question or permission marker on it; a
 * screen that just changed is `working`; anything else stays `unknown`, which
 * the classifier hands to the person.
 */
export function screenState(hostId, screen, previous = []) {
  // No Herdr state to lean on: a permission overlay anywhere on screen blocks.
  if (isPermissionScreen(screen, null, { wholeScreen: true })) return "blocked";
  if ((QUESTION_MARKERS[hostId] ?? []).some((re) => re.test(screen))) return "blocked";
  const last = previous.at(-1);
  if (last !== undefined && last !== screen) return "working";
  const recent = previous.slice(-(STABLE_READS - 1));
  if (recent.length === STABLE_READS - 1 && recent.every((s) => s === screen)) return "idle";
  return "unknown";
}

export class HerdrClient {
  /** `exec(argv)` → {status, stdout, stderr}. */
  constructor(exec) {
    this.exec = exec;
    this.history = new Map();
  }
  call(argv) {
    const r = this.exec(argv);
    if (r.status !== 0) {
      throw new Error(
        `herdr ${argv.slice(0, 2).join(" ")} failed: ${r.stderr?.trim() ?? r.status}`,
      );
    }
    return r.stdout;
  }
  /**
   * Creates the host's workspace and starts the pane command in its root pane.
   * Without both ids nothing is started, and whatever was created is closed.
   */
  openPane(cwd, label, command) {
    const created = parse(this.call(herdrArgv.createWorkspace(cwd, label)));
    const workspace =
      dig(created, "result", "workspace", "workspace_id") ??
      dig(created, "result", "workspace", "id");
    const pane =
      dig(created, "result", "root_pane", "pane_id") ?? dig(created, "result", "root_pane", "id");
    if (!workspace || !pane) {
      if (workspace) this.exec(herdrArgv.closeWorkspace(workspace));
      else if (pane) this.exec(herdrArgv.closePane(pane));
      throw new Error(
        `herdr workspace create returned no ${workspace ? "root pane" : "workspace"} id`,
      );
    }
    try {
      this.call(herdrArgv.run(pane, command));
    } catch (err) {
      this.exec(herdrArgv.closeWorkspace(workspace));
      throw err;
    }
    return { workspace, pane };
  }
  snapshot(hostId, pane, hasKind) {
    if (!hasKind) {
      const screen = this.call(herdrArgv.paneRead(pane));
      const previous = this.history.get(pane) ?? [];
      const state = screenState(hostId, screen, previous);
      this.history.set(pane, [...previous, screen].slice(-STABLE_READS));
      return { host: hostId, state, screen, explain: null, screenOnly: true };
    }
    const state = agentStatus(parse(this.call(herdrArgv.agentGet(pane))));
    const screen = this.call(herdrArgv.agentRead(pane));
    const explain = state === "blocked" ? parse(this.call(herdrArgv.explain(pane))) : null;
    return { host: hostId, state, screen, explain };
  }
  prompt(pane, text, hasKind) {
    if (hasKind) return this.call(herdrArgv.agentPrompt(pane, text));
    this.call(herdrArgv.paneText(pane, text));
    this.history.delete(pane);
    return this.call(herdrArgv.paneKeys(pane, ["enter"]));
  }
  keys(pane, keys, hasKind) {
    if (keys.length === 0) return "";
    this.history.delete(pane);
    return this.call(hasKind ? herdrArgv.agentKeys(pane, keys) : herdrArgv.paneKeys(pane, keys));
  }
  close(workspace) {
    if (workspace) this.exec(herdrArgv.closeWorkspace(workspace));
  }
}
