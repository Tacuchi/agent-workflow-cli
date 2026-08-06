// [Skills] — loose-skills manager (skills.sh model): single list with badges
// (installed → unmanaged → registered → recommended), detail with per-status
// actions (unmanaged = informational) and an [a] wizard: source → picker →
// third-party warning → register.
// The list opens PROJECTED to the recommended seed and `t` toggles to every
// detected skill (SPEC 019) — a view mode, not a second data source.
// Backed by skills-manager; the `w` bundle administration lives in
// [Workline] (HostAdminSection).

import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
import {
  REPLICA_HOST_KEYS,
  REPLICA_HOST_LABELS,
  type SkillListItem,
  canonicalSkillsRoot,
  installSkill,
  listSkills,
  probeSkillSource,
  registerSkill,
  reinstallSkill,
  removeSkill,
  resolveSkillSource,
  uninstallSkill,
  updateSkill,
} from "../../../application/self/skills-manager.js";
import type { CommandResult } from "../../../domain/types.js";
import type { CliContext } from "../../types.js";
import { ConfirmBanner } from "../components/confirm-banner.js";
import { type DetailAction, DetailPanel } from "../components/detail-panel.js";
import { InputPrompt } from "../components/input-prompt.js";
import { ListRow, type MetaTone } from "../components/list-row.js";
import { notificationStackRows } from "../components/notification-stack.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { RECOMMENDED_SKILLS } from "../data/recommended-skills.js";
import { useLockWhile } from "../input-lock.js";
import { type ToastBridgeInput, useNotificationItems } from "../notification-center.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { useListDetailKeys } from "../use-list-detail-keys.js";
import { useListWindow, windowRangeHint } from "../use-list-window.js";
import { useOnMount } from "../use-on-mount.js";

// Derived from the engine's own replica list — the four places that used to
// spell "Claude, Gemini" by hand went stale the moment a replica host changed.
const REPLICA_LABELS = REPLICA_HOST_LABELS.join(", ");

// Rows the chrome consumes around the skills list; the window (useListWindow)
// gets what remains of the viewport:
//   app shell 16 = ScreenFrame border+paddingY 4 · HomeHeader 3 (2 rows +
//     marginBottom) · TabBar 3 (border + row) · tab content box
//     border+paddingY 4 · HomeFooter 2 (marginTop + row)
//   this tab 6 = PageHead 2 (row + marginBottom) · SectionHead 1 ·
//     QuickActions 3 (marginTop + rule + keys)
const SKILLS_LIST_RESERVED_ROWS = 22;

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: ToastBridgeInput) => void;
}

type ActionId = "install" | "update" | "reinstall" | "uninstall" | "remove";

type Mode =
  | { kind: "list" }
  | { kind: "detail" }
  | { kind: "confirm"; action: "uninstall" | "remove" }
  | { kind: "wizard-source" }
  | { kind: "wizard-pick"; source: string; candidates: string[]; cursor: number }
  | { kind: "wizard-warning"; source: string; pick: string }
  | { kind: "busy"; label: string };

// The `filtered` mode's projection: the seed's names, whatever their status.
// A Set because the seed is scanned once per rendered list.
const RECOMMENDED_NAMES = new Set(RECOMMENDED_SKILLS.map((s) => s.name));

/** Rows visible in the current mode: the whole list, or just the seed's. */
function projectSkills(all: SkillListItem[], showAll: boolean): SkillListItem[] {
  return showAll ? all : all.filter((s) => RECOMMENDED_NAMES.has(s.name));
}

const STATUS_GLYPH: Record<
  SkillListItem["status"],
  { glyph: string; active: boolean; tone: MetaTone }
> = {
  installed: { glyph: "◆", active: true, tone: "ok" },
  unmanaged: { glyph: "◈", active: true, tone: "warn" },
  registered: { glyph: "◇", active: false, tone: "dim" },
  recommended: { glyph: "·", active: false, tone: "info" },
};

export function SkillsTab({ ctx, isActive, onToast }: SkillsTabProps) {
  const [items, setItems] = useState<SkillListItem[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // View mode, local and unpersisted: every mount opens on the seed (SPEC 019).
  const [showAll, setShowAll] = useState(false);
  // Mirror of the VISIBLE rows to preserve the selection BY NAME when they
  // change — a refresh re-orders the list (installed→registered→recommended)
  // and the toggle re-projects it, so a numeric cursor would land on another
  // skill. Assigned during render, so a callback reads the rows the user is
  // actually looking at.
  const visibleRef = useRef<SkillListItem[]>([]);
  const { stdout } = useStdout();

  // Rows the active mode shows. `items` keeps the FULL list so the PageHead
  // totals stay global — only the section's rows follow the mode.
  const visible = useMemo(() => projectSkills(items, showAll), [items, showAll]);
  visibleRef.current = visible;

  useLockWhile(mode.kind !== "list" && mode.kind !== "detail");

  // `detailActions` needs `current` (→ the hook's cursor), so its length
  // reaches the hook one render late via this ref. Safe: the list cannot
  // change while the detail is open, so the value is always fresh by the
  // time the detail phase reads it.
  const actionsLenRef = useRef(0);

  // Shared list/detail/confirm keys (↑↓ · ⏎ · esc · a add · y/n). The
  // callbacks close over consts declared below — they only run on keystrokes.
  const { cursor, setCursor, actionCursor } = useListDetailKeys({
    isActive,
    phase:
      mode.kind === "list" || mode.kind === "detail"
        ? mode.kind
        : mode.kind === "confirm"
          ? "confirm"
          : "off",
    listLen: visible.length,
    actionsLen: actionsLenRef.current,
    onAdd: () => setMode({ kind: "wizard-source" }),
    onOpenDetail: () => setMode({ kind: "detail" }),
    onCloseDetail: () => setMode({ kind: "list" }),
    onRunAction: (i) => {
      const entry = detailActions[i];
      if (entry) triggerAction(entry.id);
    },
    onConfirm: (yes) => {
      if (mode.kind !== "confirm" || !current) return;
      if (!yes) return setMode({ kind: "detail" });
      const name = current.name;
      if (mode.action === "uninstall") {
        void runAction(`uninstalling ${name}…`, `Uninstalled · ${name}`, () =>
          uninstallSkill(ctx, name),
        );
      } else {
        void runAction(`removing ${name}…`, `Removed · ${name}`, () => removeSkill(ctx, name));
      }
    },
  });

  // Windowed slice of the skills list (shared hook): renders only the rows
  // that fit the viewport, following the cursor at the edges. Non-TTY
  // (unknown height) → the whole list renders, as before. The window derives
  // from the cursor only — the by-name selection across refresh is untouched.
  // The NotificationStack height joins the reservation so a visible banner
  // can't clip the active row.
  const notifItems = useNotificationItems();
  const listWindow = useListWindow(
    visible.length,
    cursor,
    SKILLS_LIST_RESERVED_ROWS + notificationStackRows(notifItems),
  );

  // Re-anchors the cursor when the visible rows change (refresh or mode
  // toggle): the same skill stays selected if it survives, otherwise the
  // cursor clamps to the new list.
  const reanchorCursor = useCallback(
    (next: SkillListItem[]) => {
      setCursor((c) => {
        const prevName = visibleRef.current[c]?.name;
        const idx = prevName === undefined ? -1 : next.findIndex((s) => s.name === prevName);
        return idx >= 0 ? idx : Math.min(Math.max(0, c), Math.max(0, next.length - 1));
      });
    },
    [setCursor],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await listSkills(ctx, RECOMMENDED_SKILLS);
      reanchorCursor(projectSkills(next, showAll));
      setItems(next);
    } catch (err) {
      onToast?.({ tone: "err", title: "Error loading skills", body: (err as Error).message });
    }
  }, [ctx, onToast, reanchorCursor, showAll]);

  useOnMount(() => void refresh());

  const current = visible[cursor] ?? null;
  const installedCount = items.filter((s) => s.status === "installed").length;
  const unmanagedCount = items.filter((s) => s.status === "unmanaged").length;
  const registeredCount = items.filter((s) => s.status === "registered").length;
  const recommendedCount = items.filter((s) => s.status === "recommended").length;

  // Detail actions per status (SPEC 003): recommended/registered → Install;
  // installed → Update (git only) / Reinstall / Uninstall; Remove for
  // everything registered (a recommended one returns to `recommended`).
  // `unmanaged` (outside the registry) is not operable: the engine's
  // ownership guard rejects register/uninstall on foreign dirs —
  // informational row.
  const detailActions = useMemo<{ id: ActionId; action: DetailAction }[]>(() => {
    if (!current || current.status === "unmanaged") return [];
    if (current.status === "recommended") {
      return [
        {
          id: "install",
          action: {
            name: "Install",
            description: `Register + install (canonical + host replicas: ${REPLICA_LABELS}).`,
          },
        },
      ];
    }
    if (current.status === "registered") {
      return [
        {
          id: "install",
          action: {
            name: "Install",
            description: `Materialize canonical + host replicas (${REPLICA_LABELS}).`,
          },
        },
        {
          id: "remove",
          action: { name: "Remove", description: "Drop from the registry.", danger: true },
        },
      ];
    }
    // The engine's canonical classifier (isAbsolute covers Windows paths like
    // C:\… that a startsWith("/") would misclassify as git).
    const resolved = resolveSkillSource(current.source, current.ref);
    const gitSource = !("error" in resolved) && resolved.kind === "git";
    return [
      ...(gitSource
        ? [
            {
              id: "update" as const,
              action: {
                name: "Update",
                description: "Re-fetch the registered ref (staging + swap).",
              },
            },
          ]
        : []),
      {
        id: "reinstall",
        action: { name: "Reinstall", description: "Repair the host replicas from the canonical." },
      },
      {
        id: "uninstall",
        action: {
          name: "Uninstall",
          description: "Delete canonical + replica; keeps the registration.",
          danger: true,
        },
      },
      {
        id: "remove",
        action: {
          name: "Remove",
          description: "Uninstall + drop from the registry.",
          danger: true,
        },
      },
    ];
  }, [current]);
  actionsLenRef.current = detailActions.length;

  // TUI surface is EN (SPEC 007); the engine's summaries (ES) go in the body.
  const runAction = useCallback(
    async (
      label: string,
      successTitle: string,
      op: () => Promise<CommandResult<{ summary?: string; warning?: string }>>,
    ) => {
      setMode({ kind: "busy", label });
      try {
        const result = await op();
        if (result.ok) {
          onToast?.({ tone: "ok", title: successTitle, body: result.data?.summary ?? "" });
          if (result.data?.warning) {
            onToast?.({ tone: "info", title: "Notice", body: result.data.warning });
          }
          void ctx.logger?.info(formatTuiEvent(`skill-manager ${label}`, "ok"));
        } else {
          onToast?.({
            tone: "err",
            title: "Operation refused",
            body: result.error?.message ?? "",
          });
        }
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
      }
      await refresh();
      setMode({ kind: "list" });
    },
    [ctx, onToast, refresh],
  );

  const triggerAction = useCallback(
    (id: ActionId) => {
      if (!current) return;
      const name = current.name;
      switch (id) {
        case "install":
          if (current.status === "recommended") {
            // Register + install in one step (the seed already carries the source).
            void runAction(`installing ${name}…`, `Installed · ${name}`, async () => {
              const reg = await registerSkill(ctx, { source: current.source, pick: name });
              if (!reg.ok) return reg;
              return installSkill(ctx, name);
            });
          } else {
            void runAction(`installing ${name}…`, `Installed · ${name}`, () =>
              installSkill(ctx, name),
            );
          }
          return;
        case "update":
          void runAction(`updating ${name}…`, `Updated · ${name}`, () => updateSkill(ctx, name));
          return;
        case "reinstall":
          void runAction(`reinstalling ${name}…`, `Reinstalled · ${name}`, () =>
            reinstallSkill(ctx, name),
          );
          return;
        case "uninstall":
          setMode({ kind: "confirm", action: "uninstall" });
          return;
        case "remove":
          setMode({ kind: "confirm", action: "remove" });
          return;
      }
    },
    [ctx, current, runAction],
  );

  // input — `t` toggles the list mode (seed only ↔ every detected skill).
  // Its own handler on purpose: `useListDetailKeys` is the shared machinery of
  // the list tabs and this key belongs to this one.
  useInput(
    (input) => {
      if (!isActive || (mode.kind !== "list" && mode.kind !== "detail")) return;
      if (input !== "t" && input !== "T") return;
      reanchorCursor(projectSkills(items, !showAll));
      setShowAll((v) => !v);
    },
    { isActive },
  );

  // input — wizard-source esc
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "wizard-source") return;
      if (key.escape) setMode({ kind: "list" });
    },
    { isActive },
  );

  // input — wizard-pick (↑↓ · ⏎ choose · esc cancel)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "wizard-pick") return;
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.upArrow) {
        setMode({ ...mode, cursor: Math.max(0, mode.cursor - 1) });
        return;
      }
      if (key.downArrow) {
        setMode({ ...mode, cursor: Math.min(mode.candidates.length - 1, mode.cursor + 1) });
        return;
      }
      if (key.return) {
        const pick = mode.candidates[mode.cursor];
        if (pick) setMode({ kind: "wizard-warning", source: mode.source, pick });
      }
    },
    { isActive },
  );

  // input — wizard-warning (r register · ⏎ register+install · esc cancel)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "wizard-warning") return;
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      const { source, pick } = mode;
      if (input === "r" || input === "R") {
        void runAction(`registering ${pick}…`, `Registered · ${pick}`, () =>
          registerSkill(ctx, { source, pick }),
        );
        return;
      }
      if (key.return) {
        void runAction(`installing ${pick}…`, `Installed · ${pick}`, async () => {
          const reg = await registerSkill(ctx, { source, pick });
          if (!reg.ok) return reg;
          return installSkill(ctx, pick);
        });
      }
    },
    { isActive },
  );

  const probeSource = useCallback(
    async (source: string) => {
      setMode({ kind: "busy", label: "inspecting source…" });
      try {
        const probe = await probeSkillSource(ctx, { source });
        if (!probe.ok || !probe.data) {
          onToast?.({ tone: "err", title: "Invalid source", body: probe.error?.message ?? "" });
          setMode({ kind: "list" });
          return;
        }
        const candidates = probe.data.candidates;
        const single = candidates.length === 1 ? candidates[0] : undefined;
        setMode(
          single !== undefined
            ? { kind: "wizard-warning", source, pick: single }
            : { kind: "wizard-pick", source, candidates, cursor: 0 },
        );
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        setMode({ kind: "list" });
      }
    },
    [ctx, onToast],
  );

  const overlayVisible = mode.kind !== "list";
  const home = ctx.env.homeDir();

  // Visible-range indicator for the SectionHead hint slot — only when the
  // window hides rows (consumes no extra terminal row); it keeps priority over
  // the mode hint, which QuickActions announces anyway.
  const listRangeHint = windowRangeHint(listWindow, visible.length);
  const modeHint = showAll ? "all skills · t show recommended" : "recommended only · t show all";

  return (
    <Box flexDirection="column">
      <PageHead
        title="Skills"
        count={{
          label: `${installedCount} installed${
            unmanagedCount > 0 ? ` · ${unmanagedCount} unmanaged` : ""
          } · ${registeredCount} registered · ${recommendedCount} recommended`,
          tone: installedCount > 0 ? "accent" : "warn",
        }}
        action={<Text color={colors.mute}>~/.agents/skills + host replicas</Text>}
      />

      <SectionHead
        label="Skills"
        count={visible.length}
        hint={listRangeHint ?? modeHint}
        {...(mode.kind.startsWith("wizard")
          ? { rightAction: "esc cancel" }
          : mode.kind === "detail" || mode.kind === "confirm"
            ? { rightAction: "esc to close detail" }
            : {})}
        marginTop={0}
      />

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          {visible.slice(listWindow.start, listWindow.start + listWindow.visible).map((s, i) => {
            const glyph = STATUS_GLYPH[s.status];
            return (
              <ListRow
                key={s.name}
                icon={glyph.glyph}
                iconActive={glyph.active}
                title={s.name}
                subtitle={
                  s.status === "unmanaged" && s.source === ""
                    ? "outside the registry"
                    : `${s.source}${s.ref ? ` #${s.ref}` : ""}`
                }
                meta={s.mode === "copy" ? [{ label: "copy", tone: "warn" }] : []}
                state={{ label: s.status, tone: glyph.tone }}
                chevron
                active={listWindow.start + i === cursor}
                dimmed={mode.kind.startsWith("wizard")}
                widthHint={rowWidth(stdout?.columns, overlayVisible)}
              />
            );
          })}

          {mode.kind === "wizard-source" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label="Add skill"
                hint="Step 1 · Source"
                rightAction="⏎ inspect · esc cancel"
              />
              <Box marginLeft={2}>
                <InputPrompt
                  message="source (owner/repo · git URL · absolute path):"
                  onSubmit={(value) => {
                    const source = value.trim();
                    if (!source) {
                      setMode({ kind: "list" });
                      return;
                    }
                    void probeSource(source);
                  }}
                  isActive={isActive}
                />
              </Box>
            </Box>
          ) : null}

          {mode.kind === "wizard-pick" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label="Add skill"
                hint={`Step 2 · Pick one of ${mode.candidates.length}`}
                rightAction="⏎ choose · esc cancel"
              />
              <Box marginTop={0} flexDirection="column">
                {mode.candidates.map((name, i) => (
                  <ListRow
                    key={name}
                    icon="·"
                    title={name}
                    active={mode.cursor === i}
                    widthHint={rowWidth(stdout?.columns, true)}
                  />
                ))}
              </Box>
            </Box>
          ) : null}

          {mode.kind === "wizard-warning" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label={`Add skill · ${mode.pick}`}
                hint="Step 3 · Review"
                rightAction="esc cancel"
              />
              <Box marginLeft={2} marginTop={1} flexDirection="column">
                <Text color={colors.warn}>
                  ⚠ A third-party skill runs with your host's permissions — review it before
                  installing.
                </Text>
                <Text color={colors.dim} wrap="truncate-end">
                  {mode.source}
                </Text>
                <Box marginTop={1}>
                  <Text color={colors.faint}>[⏎] register + install · [r] register only</Text>
                </Box>
              </Box>
            </Box>
          ) : null}

          {mode.kind === "busy" ? (
            <Box marginTop={1}>
              <Text color={colors.warn}>
                {icons.spinner} {mode.label}
              </Text>
            </Box>
          ) : null}
        </Box>

        {current && (mode.kind === "detail" || mode.kind === "confirm") ? (
          <DetailPanel
            bordered
            header={{
              name: current.name,
              meta: detailMeta(current, home),
            }}
            statePill={{
              label: current.status,
              tone:
                current.status === "installed"
                  ? "ok"
                  : current.status === "unmanaged"
                    ? "warn"
                    : "dim",
            }}
            actions={detailActions.map((a) => a.action)}
            focusedAction={actionCursor}
            banner={
              mode.kind === "confirm" ? (
                <ConfirmBanner
                  title={`× ${mode.action === "uninstall" ? "Uninstall" : "Remove"} ${current.name}?`}
                  body={
                    mode.action === "uninstall"
                      ? "Deletes canonical + replica; the registration stays."
                      : current.status === "installed"
                        ? "Uninstalls and drops the registration. A recommended skill returns to the recommended list."
                        : "Drops the registration. A recommended skill returns to the recommended list."
                  }
                />
              ) : null
            }
          />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <QuickActions
          actions={[
            { key: "a", label: "add skill" },
            { key: "t", label: showAll ? "show recommended" : "show all" },
          ]}
        />
      </Box>
    </Box>
  );
}

function detailMeta(item: SkillListItem, home: string): string {
  const source = `${item.source}${item.ref ? ` #${item.ref}` : ""}`;
  if (item.status === "recommended") return `${source}\n${item.description ?? ""}`;
  const canonical = `${canonicalSkillsRoot(home)}/${item.name}`.replace(home, "~");
  // `item.mode` describes the FIRST replica host's materialization (symlink vs
  // copy) — the suffix stays on that one, and the host names come from the
  // engine's list instead of being spelled here.
  const replicas = [
    `agents ${item.replicas.agents ? "✓" : "·"}`,
    ...REPLICA_HOST_KEYS.map(
      (key, i) =>
        `${key} ${item.replicas[key] ? "✓" : "·"}${i === 0 && item.mode === "copy" ? " (copy)" : ""}`,
    ),
  ].join(" · ");
  if (item.status === "unmanaged") {
    return `${source === "" ? "unknown source" : source}\n${canonical}\n${replicas}\nInstalled outside the registry (e.g. skills.sh) — not operable from here.`;
  }
  return `${source}\n${canonical}\n${replicas}`;
}
