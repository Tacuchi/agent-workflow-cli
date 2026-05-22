import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { selfInstallHooks } from "../../../application/self/install-hooks.js";
import { type InstallTarget, selfInstallSkill } from "../../../application/self/install-skill.js";
import { selfClearPluginCache } from "../../../application/self/plugin-cache-clear.js";
import { selfUninstallSkill } from "../../../application/self/uninstall-skill.js";
import { selfUninstall } from "../../../application/self/uninstall.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import {
  type MenuItem,
  type MenuItemTrailing,
  SectionedMenu,
} from "../components/sectioned-menu.js";
import { Toast, type ToastTone } from "../components/toast.js";
import { useInputLock } from "../input-lock.js";
import { type ColorName, colors, icons } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
}

type TargetSpec =
  | { kind: "host"; id: InstallTarget; label: string }
  | { kind: "all"; label: string };

interface SkillState {
  id: InstallTarget;
  label: string;
  installed: boolean;
  hooks_installed: boolean;
  hooks_supported: boolean;
  path: string;
}

type Mode = { kind: "idle" } | { kind: "action-menu"; target: TargetSpec };

type SkillAction =
  | "install-full"
  | "install-skill-only"
  | "install-hooks"
  | "uninstall-full"
  | "uninstall-with-hooks"
  | "uninstall-skill-only"
  | "clean-cache";

const HOOKS_SUPPORTED_TARGETS: ReadonlySet<InstallTarget> = new Set(["claude"]);
const CACHE_CLEAR_HOSTS: ReadonlySet<InstallTarget> = new Set([
  "claude",
  "codex",
  "warp",
  "agents",
]);

const INSTALLED_TRAILING: MenuItemTrailing = {
  icon: icons.check,
  color: colors.success as ColorName,
  text: "instalado",
};

const NOT_INSTALLED_TRAILING: MenuItemTrailing = {
  icon: icons.cross,
  color: colors.fgMoreSubtle as ColorName,
  text: "no instalado",
};

function buildActionMenuItems(
  target: TargetSpec,
  host: SkillState | null,
): MenuItem<SkillAction>[] {
  const items: MenuItem<SkillAction>[] = [];
  items.push({ kind: "section", label: "Install" });
  items.push({
    kind: "item",
    label: host?.installed
      ? "Reinstalar completa (skill + commands + hooks)"
      : "Install completa (skill + commands + hooks)",
    value: "install-full",
    trailing: host?.installed ? INSTALLED_TRAILING : NOT_INSTALLED_TRAILING,
  });
  items.push({
    kind: "item",
    label: "Install solo skill (--skill-only)",
    value: "install-skill-only",
  });
  if (target.kind === "host" && HOOKS_SUPPORTED_TARGETS.has(target.id)) {
    items.push({
      kind: "item",
      label: host?.hooks_installed ? "Reinstalar solo hooks" : "Install solo hooks",
      value: "install-hooks",
    });
  } else if (target.kind === "all") {
    items.push({
      kind: "item",
      label: "Install solo hooks (claude only)",
      value: "install-hooks",
    });
  }
  items.push({ kind: "section", label: "Uninstall" });
  items.push({
    kind: "item",
    label: "Uninstall completa (skill + commands)",
    value: "uninstall-full",
  });
  items.push({
    kind: "item",
    label: "Uninstall completa + hooks",
    value: "uninstall-with-hooks",
  });
  items.push({
    kind: "item",
    label: "Uninstall solo skill (legacy)",
    value: "uninstall-skill-only",
  });
  items.push({ kind: "section", label: "Cache" });
  const cacheLabel =
    target.kind === "all"
      ? "Clean cache (claude + codex + warp + agents)"
      : `Clean cache de ${target.label}`;
  items.push({
    kind: "item",
    label: cacheLabel,
    value: "clean-cache",
  });
  return items;
}

export function SkillsTab({ ctx, isActive }: SkillsTabProps) {
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  // Row 0 = pseudo "All hosts"; rows 1..N = real hosts.
  const totalRows = skills.length + 1;

  useEffect(() => {
    if (mode.kind === "idle") {
      unlock();
    } else {
      lock();
      setToast(null);
    }
  }, [mode, lock, unlock]);

  useEffect(() => {
    return () => unlock();
  }, [unlock]);

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

    const next: SkillState[] = [
      {
        id: "claude",
        label: "Claude Code",
        installed: await ctx.fs.exists(`${home}/.claude/skills/agent-workflow`),
        hooks_installed: hooksInstalled,
        hooks_supported: HOOKS_SUPPORTED_TARGETS.has("claude"),
        path: "~/.claude/skills/agent-workflow/",
      },
      {
        id: "codex",
        label: "Codex",
        installed: await ctx.fs.exists(`${home}/.codex/skills/agent-workflow`),
        hooks_installed: false,
        hooks_supported: HOOKS_SUPPORTED_TARGETS.has("codex"),
        path: "~/.codex/skills/agent-workflow/",
      },
      {
        id: "warp",
        label: "Warp Terminal",
        installed: await ctx.fs.exists(`${home}/.warp/skills/agent-workflow`),
        hooks_installed: false,
        hooks_supported: HOOKS_SUPPORTED_TARGETS.has("warp"),
        path: "~/.warp/skills/agent-workflow/",
      },
    ];
    setSkills(next);
    setCursor((c) => Math.min(Math.max(0, c), next.length));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: SkillAction, target: TargetSpec, label: string) => {
      setBusy(label);
      setToast(null);
      try {
        const result = await dispatchAction(action, target, ctx);
        if (result.ok) {
          setToast({ tone: "success", message: buildSuccessMessage(action, target) });
        } else {
          setToast({ tone: "error", message: result.error?.message ?? "La acción falló." });
        }
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [ctx, refresh],
  );

  useInput(
    (input, key) => {
      if (!isActive || busy || mode.kind !== "idle") return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(totalRows - 1, c + 1));
        return;
      }
      if (key.return) {
        const target = rowToTarget(cursor, skills);
        if (target !== null) setMode({ kind: "action-menu", target });
      }
      void input;
    },
    { isActive },
  );

  useInput(
    (_, key) => {
      if (!isActive) return;
      if (mode.kind !== "action-menu") return;
      if (key.escape) setMode({ kind: "idle" });
    },
    { isActive },
  );

  const handleActionSelect = useCallback(
    (action: SkillAction) => {
      if (mode.kind !== "action-menu") return;
      const target = mode.target;
      setMode({ kind: "idle" });
      const busyLabel = buildBusyLabel(action, target.label);
      void runAction(action, target, busyLabel);
    },
    [mode, runAction],
  );

  if (mode.kind === "action-menu") {
    const targetSpec = mode.target;
    const focusedHost =
      targetSpec.kind === "host" ? (skills.find((s) => s.id === targetSpec.id) ?? null) : null;
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Skill {ctx.runtime.binName}
        </Text>
        <Box marginTop={1}>
          <Text color={colors.fgSubtle}>
            {icons.bullet} acciones para{" "}
            <Text color={colors.fg} bold>
              {mode.target.label}
            </Text>
          </Text>
        </Box>
        <Box marginTop={1}>
          <SectionedMenu
            items={buildActionMenuItems(mode.target, focusedHost)}
            onSelect={handleActionSelect}
            isActive={isActive}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle}>Esc para cerrar sin aplicar.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.fg} bold>
        Skill {ctx.runtime.binName}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <AllHostsRow focused={isActive && cursor === 0} />
        {skills.map((s, i) => (
          <SkillRow key={s.id} skill={s} focused={isActive && cursor === i + 1} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.fgMoreSubtle}>↑/↓ navegar · Enter abrir acciones · Esc cancelar</Text>
      </Box>
      {busy ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            {icons.spinner} {busy}
          </Text>
        </Box>
      ) : null}
      {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
    </Box>
  );
}

function rowToTarget(row: number, skills: SkillState[]): TargetSpec | null {
  if (row === 0) return { kind: "all", label: "todos los hosts" };
  const host = skills[row - 1];
  if (!host) return null;
  return { kind: "host", id: host.id, label: host.label };
}

function AllHostsRow({ focused }: { focused: boolean }) {
  return (
    <Box>
      <Text color={focused ? colors.primary : colors.fgMoreSubtle} bold={focused}>
        {focused ? icons.focusBullet : " "}{" "}
      </Text>
      <Text color={focused ? colors.primary : colors.fgSubtle} bold>
        ◎ Todos los hosts
      </Text>
      <Text color={colors.fgMoreSubtle}>
        {" "}
        (apply install / uninstall / clean-cache a claude + codex + warp + agents en una sola
        pasada)
      </Text>
    </Box>
  );
}

function SkillRow({ skill: s, focused }: { skill: SkillState; focused: boolean }) {
  return (
    <Box>
      <Text color={focused ? colors.primary : colors.fgMoreSubtle} bold={focused}>
        {focused ? icons.focusBullet : " "}{" "}
      </Text>
      <Text color={s.installed ? colors.success : colors.fgMoreSubtle} bold>
        {s.installed ? icons.check : icons.cross}{" "}
      </Text>
      <Text color={focused ? colors.fg : colors.fgSubtle} bold={focused}>
        {s.label}
      </Text>
      <Text color={colors.fgMoreSubtle}> · </Text>
      <Text color={colors.fgSubtle}>{s.path}</Text>
      {s.hooks_supported ? (
        <>
          <Text color={colors.fgMoreSubtle}> · </Text>
          <Text color={s.hooks_installed ? colors.success : colors.fgMoreSubtle}>
            hooks {s.hooks_installed ? icons.check : icons.cross}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

function buildArgsFor(action: SkillAction, target: TargetSpec): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const targetValue = target.kind === "all" ? "all" : target.id;
  values.set("target", targetValue);
  if (target.kind === "all") flags.add("--confirm-all");
  if (action === "install-full") flags.add("--force");
  if (action === "install-skill-only") {
    flags.add("--force");
    flags.add("--skill-only");
  }
  if (action === "uninstall-with-hooks") flags.add("--with-hooks");
  if (action === "uninstall-skill-only") flags.add("--skill-only");
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
    case "install-skill-only":
      return "install-skill";
    case "install-hooks":
      return "install-hooks";
    case "uninstall-full":
    case "uninstall-with-hooks":
      return "uninstall";
    case "uninstall-skill-only":
      return "uninstall-skill";
    case "clean-cache":
      return "clean-cache";
  }
}

async function dispatchAction(action: SkillAction, target: TargetSpec, ctx: CliContext) {
  const args = buildArgsFor(action, target);
  if (action === "clean-cache" && target.kind === "all") {
    return dispatchCleanCacheAll(ctx);
  }
  switch (action) {
    case "install-full":
    case "install-skill-only":
      return selfInstallSkill(args, ctx);
    case "install-hooks":
      return selfInstallHooks(args, ctx);
    case "uninstall-full":
    case "uninstall-with-hooks":
      return selfUninstall(args, ctx);
    case "uninstall-skill-only":
      return selfUninstallSkill(args, ctx);
    case "clean-cache":
      return selfClearPluginCache(args, ctx);
  }
}

async function dispatchCleanCacheAll(ctx: CliContext) {
  const hosts: InstallTarget[] = ["claude", "codex", "warp", "agents"];
  const errors: string[] = [];
  for (const host of hosts) {
    if (!CACHE_CLEAR_HOSTS.has(host)) continue;
    const args: ParsedArgs = {
      rest: ["clean-cache"],
      plugin: {},
      flags: new Set(),
      values: new Map([
        ["plugin", "agent-workflow"],
        ["target", host],
      ]),
      valuesMulti: new Map(),
    };
    const result = await selfClearPluginCache(args, ctx);
    if (!result.ok) errors.push(`${host}: ${result.error?.message ?? "unknown"}`);
  }
  if (errors.length > 0) {
    return {
      ok: false as const,
      error: { code: "PARTIAL_FAILURE", message: errors.join("; ") },
      exitCode: 1,
    };
  }
  return { ok: true as const, data: { status: "cleaned" }, exitCode: 0 };
}

function buildBusyLabel(action: SkillAction, label: string): string {
  switch (action) {
    case "install-full":
      return `install completa en ${label}…`;
    case "install-skill-only":
      return `install skill en ${label}…`;
    case "install-hooks":
      return `install hooks en ${label}…`;
    case "uninstall-full":
      return `uninstall completa en ${label}…`;
    case "uninstall-with-hooks":
      return `uninstall completa + hooks en ${label}…`;
    case "uninstall-skill-only":
      return `uninstall skill en ${label}…`;
    case "clean-cache":
      return `limpiando caché en ${label}…`;
  }
}

function buildSuccessMessage(action: SkillAction, target: TargetSpec): string {
  const t = target.label;
  switch (action) {
    case "install-full":
      return `Install completa OK en ${t}.`;
    case "install-skill-only":
      return `Skill instalada en ${t}.`;
    case "install-hooks":
      return `Hooks instalados en ${t}.`;
    case "uninstall-full":
      return `Uninstall completa OK en ${t}.`;
    case "uninstall-with-hooks":
      return `Uninstall completa + hooks OK en ${t}.`;
    case "uninstall-skill-only":
      return `Skill desinstalada de ${t}.`;
    case "clean-cache":
      return `Caché limpiada en ${t}.`;
  }
}
