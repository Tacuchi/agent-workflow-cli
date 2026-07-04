// Per-host administration of the `w` bundle (list + detail + confirm +
// composite clean-legacy → clean-cache → install-full). [Workflows] mounts it
// as its main section; any tab can reuse it via props.

import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
import { selfCleanLegacy } from "../../../application/self/clean-legacy.js";
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
import { HOSTS, type HostMeta } from "../hosts.js";
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

interface HostState {
  host: HostMeta;
  installed: boolean;
  hooks_installed: boolean;
  path: string;
}

type SkillAction = "install-full" | "uninstall-full" | "clean-cache" | "clean-legacy";

type Mode = { kind: "list" } | { kind: "detail" } | { kind: "confirm-uninstall"; host: HostMeta };

const HOOKS_SUPPORTED_TARGETS: ReadonlySet<string> = new Set(["claude"]);
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
  const [skills, setSkills] = useState<HostState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const startedRef = useRef(false);
  const { stdout } = useStdout();

  useLockWhile(busy !== null);

  const refresh = useCallback(async () => {
    const home = ctx.env.homeDir();
    const settingsPath = `${home}/.claude/settings.json`;
    let hooksInstalled = false;
    if (await ctx.fs.exists(settingsPath)) {
      try {
        const parsed = JSON.parse(await ctx.fs.readText(settingsPath));
        hooksInstalled =
          typeof parsed === "object" &&
          parsed !== null &&
          "hooks" in parsed &&
          typeof (parsed as { hooks?: unknown }).hooks === "object" &&
          Object.keys((parsed as { hooks: object }).hooks).length > 0;
      } catch {
        hooksInstalled = false;
      }
    }

    const next: HostState[] = [];
    for (const host of HOSTS) {
      const path = pathForHost(host, home);
      const installed = path ? await ctx.fs.exists(path) : false;
      next.push({
        host,
        installed,
        hooks_installed: host.id === "claude" ? hooksInstalled : false,
        path: installed ? friendlyPath(host) : "not installed",
      });
    }
    setSkills(next);
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, next.length - 1)));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const installedCount = skills.filter((s) => s.installed).length;
  const totalCount = skills.length;

  useEffect(() => {
    onSummary?.({ installed: installedCount, total: totalCount });
  }, [onSummary, installedCount, totalCount]);

  const focused: HostState | null = skills[cursor] ?? null;
  const isInstalled = focused?.installed === true;
  const isBackedFocused = focused ? BACKED_INSTALL_TARGETS.has(focused.host.id) : false;

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
    async (kind: "install" | "uninstall", host: HostMeta) => {
      if (!BACKED_INSTALL_TARGETS.has(host.id)) {
        onToast?.({
          tone: "info",
          title: `Host '${host.name}' not supported yet`,
          body: "Install/uninstall backend without path mapping.",
        });
        return;
      }
      const target = host.id as InstallTarget;
      const steps: SkillAction[] =
        kind === "install"
          ? ["clean-legacy", "clean-cache", "install-full"]
          : ["uninstall-full", "clean-cache"];
      const startLabel =
        kind === "install" ? `installing on ${host.name}…` : `uninstalling from ${host.name}…`;
      setBusy(startLabel);
      try {
        for (const step of steps) {
          setBusy(ACTION_DEF[step].busy(host.name));
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
        onToast?.({ tone: "ok", title: ACTION_DEF[finalAction].ok(host.name) });
        void ctx.logger?.info(formatTuiEvent(`skill ${kind} ${host.name}`, "ok"));
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
        const claude = HOSTS.find((h) => h.id === "claude");
        if (claude) void runComposite("install", claude);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (skills.length === 0 ? 0 : Math.min(skills.length - 1, c + 1)));
        return;
      }
      if (key.return && focused) {
        if (!BACKED_INSTALL_TARGETS.has(focused.host.id)) {
          onToast?.({
            tone: "info",
            title: `Host '${focused.host.name}'`,
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
          setMode({ kind: "confirm-uninstall", host: focused.host });
        } else {
          void runComposite("install", focused.host);
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
        void runComposite("uninstall", mode.host);
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
          {skills.map((s, i) => (
            <ListRow
              key={s.host.id}
              icon={icons.diamond}
              iconActive={s.installed}
              title={s.host.name}
              subtitle={friendlyPath(s.host)}
              meta={
                HOOKS_SUPPORTED_TARGETS.has(s.host.id) && s.hooks_installed
                  ? [{ label: "hooks armed", tone: "ok" }]
                  : []
              }
              state={{
                label: s.installed ? "installed" : "backed",
                tone: s.installed ? "ok" : "dim",
              }}
              chevron
              active={cursor === i}
              widthHint={rowWidth(stdout?.columns, detailVisible)}
            />
          ))}
        </Box>

        {focused && isBackedFocused && detailVisible ? (
          <DetailPanel
            bordered
            header={{
              name: focused.host.name,
              meta: `${focused.path}${
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
                  title={`× Uninstall ${mode.host.name}?`}
                  body={`Removes SKILL + commands + hooks from ${friendlyPath(mode.host)}. Reversible with Reinstall.`}
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

function pathForHost(host: HostMeta, home: string): string | null {
  if (!BACKED_INSTALL_TARGETS.has(host.id)) return null;
  const root = TARGET_ROOTS[host.id as InstallTarget];
  if (!root) return null;
  return `${home}/${root.join("/")}/${SKILL_DIR_NAME}`;
}

function friendlyPath(host: HostMeta): string {
  const root = TARGET_ROOTS[host.id as InstallTarget];
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
