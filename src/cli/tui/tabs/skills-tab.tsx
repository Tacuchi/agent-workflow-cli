import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { selfInstallHooks } from "../../../application/self/install-hooks.js";
import { type InstallTarget, selfInstallSkill } from "../../../application/self/install-skill.js";
import { selfUninstallSkill } from "../../../application/self/uninstall-skill.js";
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

interface SkillState {
  id: InstallTarget;
  label: string;
  installed: boolean;
  hooks_installed: boolean;
  hooks_supported: boolean;
  path: string;
}

type Mode = { kind: "idle" } | { kind: "action-menu"; target: SkillState };

type SkillAction = "install" | "uninstall" | "install-hooks" | "install-hooks-keep-cache";

const HOOKS_SUPPORTED_TARGETS: ReadonlySet<InstallTarget> = new Set(["claude"]);

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

function buildActionMenuItems(skill: SkillState): MenuItem<SkillAction>[] {
  const items: MenuItem<SkillAction>[] = [
    {
      kind: "item",
      label: skill.installed ? "Reinstalar / actualizar skill" : "Instalar skill",
      value: "install",
      trailing: skill.installed ? INSTALLED_TRAILING : NOT_INSTALLED_TRAILING,
    },
  ];
  if (skill.installed) {
    items.push({ kind: "item", label: "Desinstalar skill", value: "uninstall" });
  }
  if (skill.hooks_supported) {
    items.push({
      kind: "item",
      label: skill.hooks_installed ? "Reinstalar hooks" : "Instalar hooks",
      value: "install-hooks",
    });
    items.push({
      kind: "item",
      label: "Instalar hooks (sin limpiar caché)",
      value: "install-hooks-keep-cache",
    });
  }
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
    setCursor((c) => Math.min(Math.max(0, next.length - 1), Math.max(0, c)));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: SkillAction, target: InstallTarget, label: string) => {
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
        setCursor((c) => (skills.length === 0 ? 0 : Math.min(skills.length - 1, c + 1)));
        return;
      }
      if (key.return) {
        const target = skills[cursor];
        if (target) setMode({ kind: "action-menu", target });
      }
      // 'i'/'I' ya no se manejan: la instalación se hace por target desde el menu de acciones.
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
      const { id, label } = mode.target;
      setMode({ kind: "idle" });
      const busyLabel = buildBusyLabel(action, label);
      void runAction(action, id, busyLabel);
    },
    [mode, runAction],
  );

  if (mode.kind === "action-menu") {
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
            items={buildActionMenuItems(mode.target)}
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
        {skills.map((s, i) => (
          <SkillRow key={s.id} skill={s} focused={isActive && i === cursor} />
        ))}
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

function buildArgsFor(action: SkillAction, target: InstallTarget): ParsedArgs {
  const flags = new Set<string>();
  const sub =
    action === "install"
      ? "install-skill"
      : action === "uninstall"
        ? "uninstall-skill"
        : "install-hooks";
  if (action === "install") flags.add("--force");
  if (action === "install-hooks-keep-cache") flags.add("--keep-cache");
  return {
    rest: [sub],
    plugin: {},
    flags,
    values: new Map([["target", target]]),
    valuesMulti: new Map(),
  };
}

async function dispatchAction(action: SkillAction, target: InstallTarget, ctx: CliContext) {
  const args = buildArgsFor(action, target);
  switch (action) {
    case "install":
      return selfInstallSkill(args, ctx);
    case "uninstall":
      return selfUninstallSkill(args, ctx);
    case "install-hooks":
    case "install-hooks-keep-cache":
      return selfInstallHooks(args, ctx);
  }
}

function buildBusyLabel(action: SkillAction, label: string): string {
  switch (action) {
    case "install":
      return `instalando skill en ${label}…`;
    case "uninstall":
      return `desinstalando skill de ${label}…`;
    case "install-hooks":
      return `instalando hooks en ${label}…`;
    case "install-hooks-keep-cache":
      return `instalando hooks en ${label} (sin limpiar caché)…`;
  }
}

function buildSuccessMessage(action: SkillAction, target: InstallTarget): string {
  switch (action) {
    case "install":
      return `Skill instalada/actualizada en ${target}.`;
    case "uninstall":
      return `Skill desinstalada de ${target}.`;
    case "install-hooks":
    case "install-hooks-keep-cache":
      return `Hooks instalados en ${target}.`;
  }
}
