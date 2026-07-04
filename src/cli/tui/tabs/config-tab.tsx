import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { isValidNamespace } from "../../../runtime/namespace.js";
import type { CliContext } from "../../types.js";
import { FocusRow } from "../components/focus-row.js";
import { InputPrompt } from "../components/input-prompt.js";
import { PageHead } from "../components/page-head.js";
import { SectionHead } from "../components/section-head.js";
import { TABS_LIST, type TabId } from "../components/tabs-config.js";
import { HOSTS } from "../hosts.js";
import { useInputLock } from "../input-lock.js";
import { ACCENTS, ACCENT_ORDER, type AccentColor, colors, icons } from "../theme.js";
import { DEFAULT_TUI_PREFS, type TuiPrefs } from "../tui-prefs.js";
import { useListCursor } from "../use-list-cursor.js";
import { useTerminalSize } from "../use-terminal-size.js";

export interface ConfigTabProps {
  ctx: CliContext;
  isActive: boolean;
  prefs: TuiPrefs;
  onChange: (patch: Partial<TuiPrefs>) => void;
  /** Persists the namespace (config file read by NamespaceResolver). */
  onSaveNamespace: (ns: string) => void;
}

// Tabs offered as the initial screen (Config is not offered — nobody starts there).
const INITIAL_SCREEN_OPTIONS = TABS_LIST.filter((t) => t.id !== "config");

// Focusable controls, in ↑↓ navigation order.
type Control =
  | { kind: "accent" }
  | { kind: "initialScreen" }
  | { kind: "namespace" }
  | { kind: "host"; id: string };

/** Next index, circular. */
const cycleIndex = (len: number, current: number, dir: 1 | -1): number =>
  (current + dir + len) % len;

export function ConfigTab({ ctx, isActive, prefs, onChange, onSaveNamespace }: ConfigTabProps) {
  const { cols } = useTerminalSize();
  const { lock, unlock } = useInputLock();
  const controls: Control[] = [
    { kind: "accent" },
    { kind: "initialScreen" },
    { kind: "namespace" },
    ...HOSTS.map((h) => ({ kind: "host" as const, id: h.id })),
  ];
  const { cursor, moveUp, moveDown } = useListCursor(controls.length);
  const [editingNs, setEditingNs] = useState(false);
  const [namespace, setNamespace] = useState<string>(ctx.namespace.namespace);
  const focused = controls[cursor];

  const cycleAccent = (dir: 1 | -1) => {
    const i = ACCENT_ORDER.indexOf(prefs.accentColor);
    const next = ACCENT_ORDER[cycleIndex(ACCENT_ORDER.length, i, dir)];
    if (next) onChange({ accentColor: next });
  };
  const cycleInitial = (dir: 1 | -1) => {
    const i = Math.max(
      0,
      INITIAL_SCREEN_OPTIONS.findIndex((t) => t.id === prefs.initialScreen),
    );
    const next = INITIAL_SCREEN_OPTIONS[cycleIndex(INITIAL_SCREEN_OPTIONS.length, i, dir)];
    if (next) onChange({ initialScreen: next.id });
  };
  const toggleHost = (id: string) => {
    const set = new Set(prefs.disabledHosts);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange({ disabledHosts: [...set] });
  };
  const changeFocused = (dir: 1 | -1) => {
    if (focused?.kind === "accent") cycleAccent(dir);
    else if (focused?.kind === "initialScreen") cycleInitial(dir);
  };
  const activateFocused = () => {
    if (focused?.kind === "namespace") {
      setEditingNs(true);
      lock();
    } else if (focused?.kind === "host") {
      toggleHost(focused.id);
    }
  };
  const finishEdit = (ns?: string) => {
    if (ns) {
      onSaveNamespace(ns);
      setNamespace(ns);
    }
    setEditingNs(false);
    unlock();
  };

  // Navigation (off while the namespace is being edited → the TextInput captures everything).
  useInput(
    (input, key) => {
      if (key.upArrow) moveUp();
      else if (key.downArrow) moveDown();
      else if (input === "r" || input === "R") onChange({ ...DEFAULT_TUI_PREFS });
      else if (key.leftArrow) changeFocused(-1);
      else if (key.rightArrow) changeFocused(1);
      else if (key.return || input === " ") activateFocused();
    },
    { isActive: isActive && !editingNs },
  );

  // Esc cancels the namespace edit.
  useInput(
    (_input, key) => {
      if (key.escape) finishEdit();
    },
    { isActive: isActive && editingNs },
  );

  const isFocused = (c: Control): boolean =>
    focused?.kind === c.kind &&
    (c.kind !== "host" || (focused.kind === "host" && focused.id === c.id));

  const profilePath = ctx.runtime.configPath ?? ctx.paths.userRuntimeJson();
  const nsFocused = isFocused({ kind: "namespace" });
  const nsHint = nsFocused ? "⏎ edit" : ctx.namespace.source;

  return (
    <Box flexDirection="column">
      <PageHead
        title="Config"
        count={{ label: `${controls.length} settings`, tone: "accent" }}
        action={<Text color={colors.mute}>changes apply live · r reset all</Text>}
      />

      <SectionHead label="APPEARANCE" rightAction={ACCENTS[prefs.accentColor].main} />
      <FocusRow
        focused={isFocused({ kind: "accent" })}
        cols={cols}
        label="Accent color"
        valueWidth={ACCENT_VALUE_WIDTH}
      >
        <AccentValue current={prefs.accentColor} />
      </FocusRow>

      <SectionHead label="ON OPEN" hint="lands here when you run `aw`" marginTop={1} />
      <FocusRow
        focused={isFocused({ kind: "initialScreen" })}
        cols={cols}
        label="Initial screen"
        valueWidth={INITIAL_VALUE_WIDTH}
      >
        <InitialScreenValue currentId={prefs.initialScreen} />
      </FocusRow>

      <SectionHead label="WORKSPACE" marginTop={1} />
      {editingNs ? (
        <Box marginLeft={2}>
          <InputPrompt
            message="Namespace"
            defaultValue={namespace}
            validate={(v) => isValidNamespace(v) || "lowercase, a-z 0-9 -, 2-31 chars"}
            onSubmit={(v) => finishEdit(v)}
            isActive
          />
        </Box>
      ) : (
        <FocusRow
          focused={nsFocused}
          cols={cols}
          label="Namespace"
          valueWidth={namespace.length + 2 + nsHint.length}
        >
          <Text color={colors.text}>{namespace}</Text>
          <Text color={colors.faint}>
            {"  "}
            {nsHint}
          </Text>
        </FocusRow>
      )}
      <FocusRow focused={false} cols={cols} label="Profile" valueWidth={profilePath.length}>
        <Text color={colors.mute}>{profilePath}</Text>
      </FocusRow>

      <Box flexDirection="column">
        {HOSTS.map((h) => {
          const st = hostState(!prefs.disabledHosts.includes(h.id));
          return (
            <FocusRow
              key={h.id}
              focused={isFocused({ kind: "host", id: h.id })}
              cols={cols}
              label={`${h.glyph} ${h.name}`}
              valueWidth={st.width}
            >
              <Text color={st.color}>
                {icons.pending} {st.label}
              </Text>
            </FocusRow>
          );
        })}
      </Box>
    </Box>
  );
}

// ─── Value renderers (presentation + width co-located) ───────────────────────

const ACCENT_VALUE_WIDTH = ACCENT_ORDER.length * 2 + 7; // swatches "X " + hex #rrggbb

function AccentValue({ current }: { current: AccentColor }) {
  return (
    <>
      {ACCENT_ORDER.map((a) => (
        <Text key={a} color={ACCENTS[a].main}>
          {a === current ? "▣" : "■"}{" "}
        </Text>
      ))}
      <Text color={colors.dim}>{ACCENTS[current].main}</Text>
    </>
  );
}

const INITIAL_VALUE_WIDTH = INITIAL_SCREEN_OPTIONS.reduce((a, t) => a + t.label.length + 2, 0);

function InitialScreenValue({ currentId }: { currentId: TabId }) {
  return (
    <>
      {INITIAL_SCREEN_OPTIONS.map((t) => (
        <Text
          key={t.id}
          color={t.id === currentId ? colors.accent : colors.mute}
          bold={t.id === currentId}
        >
          {t.label}
          {"  "}
        </Text>
      ))}
    </>
  );
}

/** Host state: label + color + render width (icon + space + label). */
function hostState(enabled: boolean): { label: string; color: string; width: number } {
  const label = enabled ? "on" : "off";
  const color = enabled ? colors.ok : colors.mute;
  return { label, color, width: 2 + label.length };
}
