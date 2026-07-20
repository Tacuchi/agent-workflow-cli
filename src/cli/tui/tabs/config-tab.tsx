import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { resolveDefaultBranches } from "../../../application/branch-resolver.js";
import {
  type DefaultBranches,
  readWorkspaceBlock,
} from "../../../application/parsers/project-block.js";
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
  /**
   * Persists workspace branch defaults into the WORKSPACE block (one role at a
   * time). Resolves false when the write did not land (busy lock, unwritable
   * file) — the row then keeps its previous value instead of lying.
   */
  onSaveBranchDefaults: (patch: DefaultBranches) => Promise<boolean>;
}

// Tabs offered as the initial screen (Config is not offered — nobody starts there).
const INITIAL_SCREEN_OPTIONS = TABS_LIST.filter((t) => t.id !== "config");

type BranchRole = keyof DefaultBranches;

/** Rows of the RAMAS section, in display order. */
const BRANCH_ROLES: { role: BranchRole; label: string }[] = [
  { role: "principal", label: "Rama principal" },
  { role: "desarrollo", label: "Rama de desarrollo" },
  { role: "qa", label: "Rama QA" },
];

// Focusable controls, in ↑↓ navigation order.
type Control =
  | { kind: "accent" }
  | { kind: "initialScreen" }
  | { kind: "namespace" }
  | { kind: "host"; id: string }
  | { kind: "branch"; role: BranchRole };

/** What the inline TextInput is currently editing, if anything. */
type Editing = { kind: "namespace" } | { kind: "branch"; role: BranchRole } | null;

/** Next index, circular. */
const cycleIndex = (len: number, current: number, dir: 1 | -1): number =>
  (current + dir + len) % len;

export function ConfigTab({
  ctx,
  isActive,
  prefs,
  onChange,
  onSaveNamespace,
  onSaveBranchDefaults,
}: ConfigTabProps) {
  const { cols } = useTerminalSize();
  const { lock, unlock } = useInputLock();
  // null until the workspace block is read; stays null outside a workspace, and
  // then the RAMAS section is not rendered nor focusable.
  const [branches, setBranches] = useState<Required<DefaultBranches> | null>(null);
  const controls: Control[] = [
    { kind: "accent" },
    { kind: "initialScreen" },
    { kind: "namespace" },
    ...HOSTS.map((h) => ({ kind: "host" as const, id: h.id })),
    ...(branches ? BRANCH_ROLES.map((b) => ({ kind: "branch" as const, role: b.role })) : []),
  ];
  const { cursor, moveUp, moveDown } = useListCursor(controls.length);
  const [editing, setEditing] = useState<Editing>(null);
  const [namespace, setNamespace] = useState<string>(ctx.namespace.namespace);
  const focused = controls[cursor];

  // Hydrate the branch defaults from the WORKSPACE block (CLAUDE.md/AGENTS.md).
  // Any failure (no workspace, unreadable file) leaves the section hidden.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const block = await readWorkspaceBlock(ctx.fs, ctx.env.cwd(), ctx.paths.blockMarkers());
        if (alive && block) setBranches(resolveDefaultBranches(block.default_branches));
      } catch {
        // outside a workspace the tab stays as it was
      }
    })();
    return () => {
      alive = false;
    };
  }, [ctx]);

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
      setEditing({ kind: "namespace" });
      lock();
    } else if (focused?.kind === "branch") {
      setEditing({ kind: "branch", role: focused.role });
      lock();
    } else if (focused?.kind === "host") {
      toggleHost(focused.id);
    }
  };
  // A falsy value = cancel (esc) or an empty submit → the current value stands.
  const finishEdit = (value?: string) => {
    const target = editing;
    setEditing(null);
    unlock();
    if (!value || !target) return;
    if (target.kind === "namespace") {
      onSaveNamespace(value);
      setNamespace(value);
      return;
    }
    // Adopt the new value only once the write is confirmed; app.tsx toasts the failure.
    void onSaveBranchDefaults({ [target.role]: value }).then((saved) => {
      if (saved) setBranches((prev) => (prev ? { ...prev, [target.role]: value } : prev));
    });
  };

  // Navigation (off while a value is being edited → the TextInput captures everything).
  useInput(
    (input, key) => {
      if (key.upArrow) moveUp();
      else if (key.downArrow) moveDown();
      else if (input === "r" || input === "R") onChange({ ...DEFAULT_TUI_PREFS });
      else if (key.leftArrow) changeFocused(-1);
      else if (key.rightArrow) changeFocused(1);
      else if (key.return || input === " ") activateFocused();
    },
    { isActive: isActive && editing === null },
  );

  // Esc cancels the inline edit.
  useInput(
    (_input, key) => {
      if (key.escape) finishEdit();
    },
    { isActive: isActive && editing !== null },
  );

  const isFocused = (c: Control): boolean => {
    if (focused?.kind !== c.kind) return false;
    if (c.kind === "host") return focused.kind === "host" && focused.id === c.id;
    if (c.kind === "branch") return focused.kind === "branch" && focused.role === c.role;
    return true;
  };

  const profilePath = ctx.runtime.configPath ?? ctx.paths.userRuntimeJson();
  const nsFocused = isFocused({ kind: "namespace" });
  const nsHint = nsFocused ? EDIT_HINT : ctx.namespace.source;

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
      {editing?.kind === "namespace" ? (
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

      {branches ? (
        <>
          <SectionHead
            label="RAMAS (workspace)"
            hint="fallback por rol cuando la fuente no la declara"
            marginTop={1}
          />
          {BRANCH_ROLES.map(({ role, label }) => {
            const value = branches[role];
            const isEditing = editing?.kind === "branch" && editing.role === role;
            const rowFocused = isFocused({ kind: "branch", role });
            return isEditing ? (
              <Box key={role} marginLeft={2}>
                <InputPrompt
                  message={label}
                  defaultValue={value}
                  validate={validateBranchName}
                  onSubmit={(v) => finishEdit(v.trim())}
                  isActive
                />
              </Box>
            ) : (
              <FocusRow
                key={role}
                focused={rowFocused}
                cols={cols}
                label={label}
                // "Rama de desarrollo" overflows the default 16-cell label column.
                labelWidth={BRANCH_LABEL_WIDTH}
                valueWidth={value.length + (rowFocused ? EDIT_HINT.length + 2 : 0)}
              >
                <Text color={colors.text}>{value}</Text>
                {rowFocused ? (
                  <Text color={colors.faint}>
                    {"  "}
                    {EDIT_HINT}
                  </Text>
                ) : null}
              </FocusRow>
            );
          })}
        </>
      ) : null}
    </Box>
  );
}

const EDIT_HINT = "⏎ edit";
const BRANCH_LABEL_WIDTH = 20;

/** A branch name the workspace block can round-trip: non-empty, no whitespace. */
function validateBranchName(value: string): boolean | string {
  const v = value.trim();
  if (v.length === 0) return "nombre de rama vacío";
  if (/\s/.test(v)) return "sin espacios";
  return true;
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
