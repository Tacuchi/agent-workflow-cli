// Per-host administration of the `w` bundle (list + detail + confirm +
// composite clean-legacy → clean-cache → install-full). [Workline] mounts it
// as its main section; any tab can reuse it via props.

import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
import { selfCleanLegacy } from "../../../application/self/clean-legacy.js";
import { reportHooksArmed } from "../../../application/self/host-states.js";
import {
  type InstallTarget,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
  selfInstallSkill,
} from "../../../application/self/install-skill.js";
import { selfClearPluginCache } from "../../../application/self/plugin-cache-clear.js";
import { selfUninstall } from "../../../application/self/uninstall.js";
import type { CommandResult } from "../../../domain/types.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { HOSTS, SHARED_DESTINATIONS, supportPill } from "../hosts.js";
import { useLockWhile } from "../input-lock.js";
import type { ToastBridgeInput } from "../notification-center.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { ConfirmBanner } from "./confirm-banner.js";
import { type DetailAction, DetailPanel } from "./detail-panel.js";
import { ListRow } from "./list-row.js";
import { QuickActions } from "./quick-actions.js";
import { SectionHead } from "./section-head.js";

export interface HostAdminSummary {
  installed: number;
  total: number;
}

export interface HostAdminSectionProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: ToastBridgeInput) => void;
  /** Notifies the mounting tab so it can render its own header counts. */
  onSummary?: (summary: HostAdminSummary) => void;
  /** Extra line for the detail panel meta of a host with hooks armed. */
  hooksMetaSuffix?: string;
}

/**
 * One operable row. Hosts and shared destinations share the install/uninstall
 * machinery — they are both install targets — but they are NEVER mixed in the
 * counts: a shared skills dir has no runtime and must not inflate "N hosts".
 */
interface TargetRow {
  kind: "host" | "shared";
  id: InstallTarget;
  name: string;
  /** Support level + verified version for a host; what it is, for a shared dir. */
  pill: string;
  installed: boolean;
  hooks_installed: boolean;
  path: string;
}

type SkillAction = "install-full" | "uninstall-full" | "clean-cache" | "clean-legacy";

type Mode = { kind: "list" } | { kind: "detail" } | { kind: "confirm-uninstall"; row: TargetRow };

// Derived from the backend's own target map so the section can't drift from what
// `self install/uninstall-skill` actually supports (clean-legacy v14.5.1 lesson).
const BACKED_INSTALL_TARGETS: ReadonlySet<string> = new Set(Object.keys(TARGET_ROOTS));

export function HostAdminSection({
  ctx,
  isActive,
  onToast,
  onSummary,
  hooksMetaSuffix,
}: HostAdminSectionProps) {
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const startedRef = useRef(false);
  const { stdout } = useStdout();

  useLockWhile(busy !== null);

  const refresh = useCallback(async () => {
    const home = ctx.env.homeDir();
    // Hooks are probed PER HOST from the single managed-hosts source, instead of
    // reading Claude's settings.json and calling the answer global.
    const hooks = await reportHooksArmed(ctx).catch(() => []);
    const armedByTarget = new Map(hooks.map((h) => [h.target, h.armed]));

    const next: TargetRow[] = [];
    for (const host of HOSTS) {
      const path = pathForTarget(host.id, home);
      next.push({
        kind: "host",
        id: host.id,
        name: host.name,
        pill: supportPill(host),
        installed: path ? await ctx.fs.exists(path) : false,
        hooks_installed: armedByTarget.get(host.id) === true,
        path: friendlyPath(host.id),
      });
    }
    for (const dest of SHARED_DESTINATIONS) {
      const path = pathForTarget(dest.id, home);
      next.push({
        kind: "shared",
        id: dest.id,
        name: dest.name,
        pill: `shared dir · read by ${dest.readBy.length} hosts`,
        installed: path ? await ctx.fs.exists(path) : false,
        hooks_installed: false,
        path: friendlyPath(dest.id),
      });
    }
    setRows(next);
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, next.length - 1)));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  // Counts are HOSTS ONLY — a shared skills dir is a destination, never a host.
  const hostRows = rows.filter((r) => r.kind === "host");
  const sharedRows = rows.filter((r) => r.kind === "shared");
  const installedCount = hostRows.filter((s) => s.installed).length;
  const totalCount = hostRows.length;

  useEffect(() => {
    onSummary?.({ installed: installedCount, total: totalCount });
  }, [onSummary, installedCount, totalCount]);

  const focused: TargetRow | null = rows[cursor] ?? null;
  const isInstalled = focused?.installed === true;
  const isBackedFocused = focused ? BACKED_INSTALL_TARGETS.has(focused.id) : false;

  const detailActions = useMemo<DetailAction[]>(() => {
    if (!focused) return [];
    const reinstall: DetailAction = {
      name: isInstalled ? "Reinstall" : "Install",
      description: isInstalled ? "Overwrite files (--force)." : "Copy files (--force).",
    };
    if (isInstalled) {
      return [
        reinstall,
        {
          name: "Uninstall",
          description: "Remove files. Reversible.",
          danger: true,
        },
      ];
    }
    return [reinstall];
  }, [focused, isInstalled]);

  const runComposite = useCallback(
    async (kind: "install" | "uninstall", row: TargetRow) => {
      if (!BACKED_INSTALL_TARGETS.has(row.id)) {
        onToast?.({
          tone: "info",
          title: `Target '${row.name}' not supported yet`,
          body: "Install/uninstall backend without path mapping.",
        });
        return;
      }
      const target = row.id;
      const steps: SkillAction[] =
        kind === "install"
          ? ["clean-legacy", "clean-cache", "install-full"]
          : ["uninstall-full", "clean-cache"];
      const startLabel =
        kind === "install" ? `installing on ${row.name}…` : `uninstalling from ${row.name}…`;
      setBusy(startLabel);
      try {
        for (const step of steps) {
          setBusy(ACTION_DEF[step].busy(row.name));
          const result = await ACTION_DEF[step].run(buildArgsFor(step, target), ctx);
          if (!result.ok) {
            const failMsg = result.error?.message;
            onToast?.(
              failMsg !== undefined
                ? { tone: "err", title: `Step ${step} failed`, body: failMsg }
                : { tone: "err", title: `Step ${step} failed` },
            );
            // The err toast is mirrored to the log by the notification-center
            // safety net; nothing more to log here.
            await refresh();
            return;
          }
        }
        const finalAction: SkillAction = kind === "install" ? "install-full" : "uninstall-full";
        onToast?.({ tone: "ok", title: ACTION_DEF[finalAction].ok(row.name) });
        void ctx.logger?.info(formatTuiEvent(`skill ${kind} ${row.name}`, "ok"));
        await refresh();
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [ctx, refresh, onToast],
  );

  // input — list mode (↑↓ navigate · ⏎ open detail · Esc no-op · 'i' empty-state install)
  useInput(
    (input, key) => {
      if (!isActive || busy || mode.kind !== "list") return;
      if ((input === "i" || input === "I") && installedCount === 0) {
        const claude = hostRows.find((r) => r.id === "claude");
        if (claude) void runComposite("install", claude);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (rows.length === 0 ? 0 : Math.min(rows.length - 1, c + 1)));
        return;
      }
      if (key.return && focused) {
        if (!BACKED_INSTALL_TARGETS.has(focused.id)) {
          onToast?.({
            tone: "info",
            title: `Target '${focused.name}'`,
            body: "pending — backend without path mapping yet",
          });
          return;
        }
        setActionCursor(0);
        setMode({ kind: "detail" });
      }
    },
    { isActive },
  );

  // input — detail mode (↑↓ navigate actions · ⏎ run focused · Esc close)
  useInput(
    (_input, key) => {
      if (!isActive || busy || mode.kind !== "detail" || !focused) return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(detailActions.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return) {
        const action = detailActions[actionCursor];
        if (!action) return;
        if (action.danger) {
          setMode({ kind: "confirm-uninstall", row: focused });
        } else {
          void runComposite("install", focused);
          setMode({ kind: "list" });
        }
      }
    },
    { isActive },
  );

  // input — confirm-uninstall (y confirm · n/esc cancel)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "confirm-uninstall") return;
      if (input === "y" || input === "Y") {
        void runComposite("uninstall", mode.row);
        setMode({ kind: "list" });
      } else if (key.escape || input === "n" || input === "N") {
        setMode({ kind: "detail" });
      }
    },
    { isActive },
  );

  const detailVisible = mode.kind === "detail" || mode.kind === "confirm-uninstall";

  return (
    <Box flexDirection="column">
      <SectionHead
        label="Hosts"
        count={totalCount}
        {...(detailVisible ? { rightAction: "esc to close detail" } : {})}
        marginTop={0}
      />

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          {hostRows.map((s, i) => (
            <ListRow
              key={s.id}
              icon={icons.diamond}
              iconActive={s.installed}
              title={s.name}
              subtitle={s.path}
              meta={[
                { label: s.pill, tone: "dim" },
                ...(s.hooks_installed ? ([{ label: "hooks armed", tone: "ok" }] as const) : []),
              ]}
              state={{
                label: s.installed ? "installed" : "backed",
                tone: s.installed ? "ok" : "dim",
              }}
              chevron
              active={cursor === i}
              widthHint={rowWidth(stdout?.columns, detailVisible)}
            />
          ))}

          {sharedRows.length > 0 ? (
            <>
              <SectionHead
                label="Shared destinations"
                count={sharedRows.length}
                rightAction="not hosts — never counted as such"
              />
              {sharedRows.map((s, i) => (
                <ListRow
                  key={s.id}
                  icon={icons.diamond}
                  iconActive={s.installed}
                  title={s.name}
                  subtitle={s.path}
                  meta={[{ label: s.pill, tone: "dim" }]}
                  state={{
                    label: s.installed ? "installed" : "backed",
                    tone: s.installed ? "ok" : "dim",
                  }}
                  chevron
                  active={cursor === hostRows.length + i}
                  widthHint={rowWidth(stdout?.columns, detailVisible)}
                />
              ))}
            </>
          ) : null}
        </Box>

        {focused && isBackedFocused && detailVisible ? (
          <DetailPanel
            bordered
            header={{
              name: focused.name,
              meta: `${focused.path}\n${focused.pill}${
                focused.hooks_installed && hooksMetaSuffix ? `\n${hooksMetaSuffix}` : ""
              }`,
            }}
            statePill={{
              label: isInstalled ? "installed" : "missing",
              tone: isInstalled ? "ok" : "dim",
            }}
            actions={detailActions}
            focusedAction={actionCursor}
            banner={
              mode.kind === "confirm-uninstall" ? (
                <ConfirmBanner
                  title={`× Uninstall ${mode.row.name}?`}
                  body={`Removes SKILL + commands + hooks from ${mode.row.path}. Reversible with Reinstall.`}
                />
              ) : null
            }
          />
        ) : null}
      </Box>

      {busy ? (
        <Box marginTop={1}>
          <Text color={colors.warn}>
            {icons.spinner} {busy}
          </Text>
        </Box>
      ) : null}

      {installedCount === 0 ? (
        <Box marginTop={1}>
          <QuickActions actions={[{ key: "i", label: "install on Claude" }]} />
        </Box>
      ) : null}
    </Box>
  );
}

function pathForTarget(target: InstallTarget, home: string): string | null {
  if (!BACKED_INSTALL_TARGETS.has(target)) return null;
  const root = TARGET_ROOTS[target];
  if (!root) return null;
  return `${home}/${root.join("/")}/${SKILL_DIR_NAME}`;
}

function friendlyPath(target: InstallTarget): string {
  const root = TARGET_ROOTS[target];
  if (!root) return "(not wired yet)";
  return `~/${root.join("/")}/${SKILL_DIR_NAME}/`;
}

// Everything an action needs (subcommand, busy/success labels, backend fn) in
// one row per SkillAction so the pieces cannot drift apart.
const ACTION_DEF: Record<
  SkillAction,
  {
    sub: string;
    busy: (host: string) => string;
    ok: (host: string) => string;
    run: (args: ParsedArgs, ctx: CliContext) => Promise<CommandResult>;
  }
> = {
  "install-full": {
    sub: "install-skill",
    busy: (h) => `installing on ${h}…`,
    ok: (h) => `Install complete OK on ${h}.`,
    run: selfInstallSkill,
  },
  "uninstall-full": {
    sub: "uninstall",
    busy: (h) => `uninstalling from ${h}…`,
    ok: (h) => `Uninstall complete OK on ${h}.`,
    run: selfUninstall,
  },
  "clean-cache": {
    sub: "clean-cache",
    busy: (h) => `cleaning cache on ${h}…`,
    ok: (h) => `Cache cleaned on ${h}.`,
    run: selfClearPluginCache,
  },
  "clean-legacy": {
    sub: "clean-legacy",
    busy: (h) => `removing legacy skills from ${h}…`,
    ok: (h) => `Legacy skills removed from ${h}.`,
    run: selfCleanLegacy,
  },
};

function buildArgsFor(action: SkillAction, target: InstallTarget): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  values.set("target", target);
  if (action === "install-full" || action === "uninstall-full") flags.add("--force");
  if (action === "clean-cache") values.set("plugin", SKILL_DIR_NAME);
  return {
    rest: [ACTION_DEF[action].sub],
    plugin: {},
    flags,
    values,
    valuesMulti: new Map(),
  };
}
