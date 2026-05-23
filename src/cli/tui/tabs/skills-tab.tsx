import { Box, Text, useInput } from "ink";
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
import { ActionModal, type ActionModalAction } from "../components/action-modal.js";
import { FrameBox } from "../components/frame-box.js";
import { ListRow, type MetaChip } from "../components/list-row.js";
import { PageHead } from "../components/page-head.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import { HOSTS, type HostMeta } from "../hosts.js";
import { useInputLock } from "../input-lock.js";
import { colors, icons } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
  /** Versión actual del CLI (mostrada en el footer del ActionModal). */
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

type Mode = { kind: "list" } | { kind: "actions" };

const HOOKS_SUPPORTED_TARGETS: ReadonlySet<string> = new Set(["claude"]);
const BACKED_INSTALL_TARGETS: ReadonlySet<string> = new Set(["claude", "codex", "warp", "agents"]);

/**
 * SkillsTab — single-column list + ActionModal overlay.
 *
 * Layout match con handoff (variant-palette.jsx SkillsTab):
 *   PageHead con count + desc → empty-state banner (si 0 installed) → FrameBox
 *   "hosts" accent con ListRow por host (7 total) → ActionModal overlay al ⏎.
 *
 * Hosts no-backed (gemini/opencode/crush) renderizan con chip `pending` warn,
 * NO se puede invocar install. Backed sin instalar muestran `backed` chip.
 *
 * Acciones del modal:
 *   - Reinstall (steps clean-legacy → clean-cache → install-skill --force +
 *     hook hint solo para claude).
 *   - Uninstall (danger) — solo cuando installed.
 *
 * Atajos:
 *   - `i` en list mode con 0 hosts instalados → install directo en Claude.
 *   - ↑↓ navega · ⏎ abre modal · Esc cierra modal.
 */
export function SkillsTab({ ctx, isActive, version, onToast }: SkillsTabProps) {
  const [skills, setSkills] = useState<HostState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

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

  const focused: HostState | null = skills[cursor] ?? null;
  const isInstalled = focused?.installed === true;
  const isBackedFocused = focused ? BACKED_INSTALL_TARGETS.has(focused.host.id) : false;

  // Acciones del modal — Reinstall siempre, Uninstall solo si instalado.
  const modalActions = useMemo<ActionModalAction[]>(() => {
    if (!focused) return [];
    const installSteps = ["clean-legacy", "clean-cache", "install-skill --force"];
    const reinstall: ActionModalAction = {
      id: "reinstall",
      icon: icons.refresh,
      label: isInstalled ? "Reinstall" : "Install",
      desc: isInstalled
        ? "Overwrite skill files + commands + hooks (--force, no prompts)."
        : "Copy SKILL + commands + hooks. Always uses --force (overwrite).",
      steps: installSteps,
      ...(HOOKS_SUPPORTED_TARGETS.has(focused.host.id)
        ? {
            hint: {
              tone: "ok" as const,
              icon: icons.hook,
              text: `also wires 5 Claude hooks: ${WORKFLOW_CONTENT.hooks.map((h) => h.name).join(", ")}`,
            },
          }
        : {}),
    };
    if (isInstalled) {
      return [
        reinstall,
        {
          id: "uninstall",
          icon: icons.cross,
          label: "Uninstall",
          desc: "Remove SKILL + commands + hooks. Reversible with Install.",
          danger: true,
          steps: ["uninstall --force", "clean-cache"],
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

  // input — list mode
  useInput(
    (input, key) => {
      if (!isActive || busy || mode.kind !== "list") return;
      // Empty-state shortcut: `i` instala directo en Claude.
      if ((input === "i" || input === "I") && installedCount === 0) {
        const claude = HOSTS.find((h) => h.id === "claude");
        if (claude) void runComposite("install", claude);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        setActionCursor(0);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (skills.length === 0 ? 0 : Math.min(skills.length - 1, c + 1)));
        setActionCursor(0);
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
        setMode({ kind: "actions" });
      }
    },
    { isActive },
  );

  // input — actions mode (modal overlay)
  useInput(
    (_input, key) => {
      if (!isActive || busy || mode.kind !== "actions") return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(modalActions.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return && focused) {
        const def = modalActions[actionCursor];
        if (!def) return;
        const kind = def.id === "uninstall" ? "uninstall" : "install";
        void runComposite(kind, focused.host);
        setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  const inListMode = mode.kind === "list";

  return (
    <Box flexDirection="column">
      <PageHead
        title="Skills"
        count={{
          label: `${installedCount}/${totalCount}`,
          tone: installedCount === 0 ? "warn" : "accent",
        }}
        desc={`one universal SKILL · ${subSkillsTotal()} sub-skills · ${WORKFLOW_CONTENT.slashCommands.length} commands`}
      />

      {/* First-use banner — solo cuando 0 hosts instalados */}
      {installedCount === 0 && skills.length > 0 && inListMode ? (
        <FrameBox title="first run" accent>
          <Box flexDirection="row">
            <Text color={colors.accent}>{icons.star} </Text>
            <Text color={colors.fgBright} bold>
              Nothing installed yet — start with Claude Code.
            </Text>
          </Box>
          <Text color={colors.fgSubtle} wrap="wrap">
            Claude supports SKILL + slash commands + hooks. Other hosts copy only the SKILL.
          </Text>
          <Box marginTop={1} flexDirection="row">
            <Text color={colors.accent} bold inverse>
              {` i · ${icons.play} Install on Claude `}
            </Text>
            <Text color={colors.fgSubtle}> · ⏎ view actions on active host</Text>
          </Box>
        </FrameBox>
      ) : null}

      {/* Single-column hosts list — solo en list mode; el modal lo reemplaza como overlay */}
      {inListMode ? (
        <FrameBox title="hosts" accent>
          {skills.map((s, i) => {
            const meta: MetaChip[] = [];
            if (HOOKS_SUPPORTED_TARGETS.has(s.host.id)) {
              meta.push({
                label: s.hooks_installed ? "hooks active" : "hooks inactive",
                tone: s.hooks_installed ? "ok" : "dim",
              });
            }
            meta.push({
              label: s.host.backed ? "backed" : "pending",
              tone: s.host.backed ? "dim" : "warn",
            });
            return (
              <ListRow
                key={s.host.id}
                icon={icons.diamond}
                iconActive={s.installed}
                title={s.host.name}
                subtitle={s.path}
                meta={meta}
                state={{
                  label: s.installed ? "installed" : "missing",
                  tone: s.installed ? "ok" : "dim",
                }}
                chevron
                active={cursor === i}
              />
            );
          })}
        </FrameBox>
      ) : null}

      {/* ActionModal overlay — reemplaza la lista, centrado tipo palette */}
      {mode.kind === "actions" && focused && isBackedFocused ? (
        <Box flexDirection="column" alignItems="center" paddingY={2}>
          <Box width="80%" flexDirection="column">
            <ActionModal
              glyph={focused.host.glyph}
              title={focused.host.name}
              subtitle={focused.path}
              state={{
                label: isInstalled ? "installed" : "missing",
                tone: isInstalled ? "ok" : "dim",
              }}
              actions={modalActions}
              cursor={actionCursor}
              footerRight={version ? `agent-workflow v${version}` : "agent-workflow"}
            />
          </Box>
        </Box>
      ) : null}

      {busy ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            {icons.spinner} {busy}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ===== helpers =====

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
  // `--force` aplica a install y uninstall: sobreescribir sin confirm prompt.
  // Decisión de producto (handoff README §Estados, línea ~216).
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
