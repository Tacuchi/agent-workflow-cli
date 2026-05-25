import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selfCleanLegacy } from "../../../application/self/clean-legacy.js";
import {
  type InstallTarget,
  TARGET_ROOTS,
  selfInstallSkill,
} from "../../../application/self/install-skill.js";
import { selfClearPluginCache } from "../../../application/self/plugin-cache-clear.js";
import { selfUninstall } from "../../../application/self/uninstall.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { ConfirmBanner } from "../components/confirm-banner.js";
import { type DetailAction, DetailPanel } from "../components/detail-panel.js";
import { ListRow } from "../components/list-row.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import { HOSTS, type HostMeta } from "../hosts.js";
import { useInputLock } from "../input-lock.js";
import { colors, icons } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
  version?: string;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
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
const BACKED_INSTALL_TARGETS: ReadonlySet<string> = new Set(["claude", "codex", "warp", "agents"]);

export function SkillsTab({ ctx, isActive, onToast }: SkillsTabProps) {
  const [skills, setSkills] = useState<HostState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();
  const { stdout } = useStdout();

  useEffect(() => {
    if (busy) lock();
    else unlock();
  }, [busy, lock, unlock]);

  useEffect(() => () => unlock(), [unlock]);

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
      const installed = host.backed && path ? await ctx.fs.exists(path) : false;
      next.push({
        host,
        installed,
        hooks_installed: host.id === "claude" ? hooksInstalled : false,
        path: installed
          ? friendlyPath(host, home)
          : host.backed
            ? "not installed"
            : "(not wired yet)",
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
  const backedHosts = HOSTS.filter((h) => h.backed).length;
  const pendingHosts = HOSTS.length - backedHosts;

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
          setBusy(buildBusyLabel(step, host.name));
          const result = await dispatchAction(step, target, ctx);
          if (!result.ok) {
            const failMsg = result.error?.message;
            onToast?.(
              failMsg !== undefined
                ? { tone: "err", title: `Step ${step} failed`, body: failMsg }
                : { tone: "err", title: `Step ${step} failed` },
            );
            await refresh();
            return;
          }
        }
        const finalAction: SkillAction = kind === "install" ? "install-full" : "uninstall-full";
        onToast?.({ tone: "ok", title: buildSuccessMessage(finalAction, host.name) });
        await refresh();
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [ctx, refresh, onToast],
  );

  // input — list mode (↑↓ navega · ⏎ abre detail · Esc no-op · 'i' empty-state install)
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

  // input — detail mode (↑↓ navega actions · ⏎ ejecuta focused · Esc cierra)
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

  // input — confirm-uninstall (y confirma · n/esc cancela)
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
      <PageHead
        title="Skills"
        count={{
          label: `${installedCount}/${totalCount} hosts · ${subSkillsTotal()} sub-skills · ${WORKFLOW_CONTENT.slashCommands.length} slash commands`,
          tone: installedCount === 0 ? "warn" : "accent",
        }}
        action={<Text color={colors.mute}>one universal SKILL · agent-workflow</Text>}
      />

      <SectionHead
        label="Hosts"
        count={totalCount}
        hint={`backed ${backedHosts} · pending ${pendingHosts}`}
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
              subtitle={friendlyPath(s.host, ctx.env.homeDir())}
              meta={
                HOOKS_SUPPORTED_TARGETS.has(s.host.id) && s.hooks_installed
                  ? [{ label: "hooks armed", tone: "ok" }]
                  : []
              }
              state={{
                label: s.installed ? "installed" : s.host.backed ? "backed" : "pending",
                tone: s.installed ? "ok" : s.host.backed ? "dim" : "warn",
              }}
              chevron
              active={cursor === i}
              widthHint={computeRowWidth(stdout?.columns, detailVisible)}
            />
          ))}
        </Box>

        {focused && isBackedFocused && detailVisible ? (
          <Box flexDirection="column">
            <Text color={colors.borderFaint}>{"│"}</Text>
            <DetailPanel
              header={{
                name: focused.host.name,
                meta: `${focused.path}${
                  focused.hooks_installed
                    ? `\nhooks armed · SKILL + ${WORKFLOW_CONTENT.slashCommands.length} slash + ${WORKFLOW_CONTENT.hooks.length} hooks`
                    : ""
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
                    body={`Removes SKILL + commands + hooks from ${friendlyPath(mode.host, ctx.env.homeDir())}. Reversible with Reinstall.`}
                  />
                ) : null
              }
            />
          </Box>
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

function computeRowWidth(termCols: number | undefined, detailOpen: boolean): number {
  const cols = termCols ?? 100;
  // ScreenFrame (6) + tab content border+padding (6) + list paddingRight (2) = 14 cols.
  const baseOverhead = 14;
  const detailOverhead = detailOpen ? 39 : 0;
  return Math.max(16, cols - baseOverhead - detailOverhead);
}

function subSkillsTotal(): number {
  return WORKFLOW_CONTENT.commandFamilies.reduce((n, f) => n + f.items.length, 0);
}

function pathForHost(host: HostMeta, home: string): string | null {
  if (!BACKED_INSTALL_TARGETS.has(host.id)) return null;
  const root = TARGET_ROOTS[host.id as InstallTarget];
  if (!root) return null;
  return `${home}/${root.join("/")}/agent-workflow`;
}

function friendlyPath(host: HostMeta, _home: string): string {
  if (host.id === "claude") return "~/.claude/skills/agent-workflow/";
  if (host.id === "codex") return "~/.codex/skills/agent-workflow/";
  if (host.id === "warp") return "~/.warp/skills/agent-workflow/";
  if (host.id === "agents") return "~/.agents/skills/agent-workflow/";
  return "(not wired yet)";
}

function buildArgsFor(action: SkillAction, target: InstallTarget): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  values.set("target", target);
  if (action === "install-full" || action === "uninstall-full") flags.add("--force");
  if (action === "clean-cache") values.set("plugin", "agent-workflow");
  return {
    rest: [actionToSubcommand(action)],
    plugin: {},
    flags,
    values,
    valuesMulti: new Map(),
  };
}

function actionToSubcommand(action: SkillAction): string {
  switch (action) {
    case "install-full":
      return "install-skill";
    case "uninstall-full":
      return "uninstall";
    case "clean-cache":
      return "clean-cache";
    case "clean-legacy":
      return "clean-legacy";
  }
}

async function dispatchAction(action: SkillAction, target: InstallTarget, ctx: CliContext) {
  const args = buildArgsFor(action, target);
  switch (action) {
    case "install-full":
      return selfInstallSkill(args, ctx);
    case "uninstall-full":
      return selfUninstall(args, ctx);
    case "clean-cache":
      return selfClearPluginCache(args, ctx);
    case "clean-legacy":
      return selfCleanLegacy(args, ctx);
  }
}

function buildBusyLabel(action: SkillAction, label: string): string {
  switch (action) {
    case "install-full":
      return `installing on ${label}…`;
    case "uninstall-full":
      return `uninstalling from ${label}…`;
    case "clean-cache":
      return `cleaning cache on ${label}…`;
    case "clean-legacy":
      return `removing legacy skills from ${label}…`;
  }
}

function buildSuccessMessage(action: SkillAction, label: string): string {
  switch (action) {
    case "install-full":
      return `Install complete OK on ${label}.`;
    case "uninstall-full":
      return `Uninstall complete OK on ${label}.`;
    case "clean-cache":
      return `Cache cleaned on ${label}.`;
    case "clean-legacy":
      return `Legacy skills removed from ${label}.`;
  }
}
