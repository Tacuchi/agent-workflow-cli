import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { installPluginSkillsFromGit } from "../../../application/self/install-plugin-skills-git.js";
import { selfInstallPluginSkills } from "../../../application/self/install-plugin-skills.js";
import type { InstallTarget } from "../../../application/self/install-skill.js";
import type { CliContext } from "../../types.js";
import { InputPrompt } from "../components/input-prompt.js";
import {
  type MenuItem,
  type MenuItemTrailing,
  SectionedMenu,
} from "../components/sectioned-menu.js";
import { Toast, type ToastTone } from "../components/toast.js";
import { useInputLock } from "../input-lock.js";
import { type ColorName, colors, icons } from "../theme.js";

export interface PluginsTabProps {
  ctx: CliContext;
  isActive: boolean;
}

interface PluginTargetStatus {
  id: InstallTarget;
  label: string;
  path: string;
  installed: boolean;
}

interface PluginEntry {
  id: string;
  label: string;
  namespace: string;
  sourcePath: string | null;
  sourceUrl: string | null;
  sourceRef: string | null;
  version: string | null;
  skillCount: number | null;
  targets: PluginTargetStatus[];
}

type Mode =
  | { kind: "idle" }
  | { kind: "action-menu"; target: PluginEntry }
  | { kind: "new-plugin-menu" }
  | { kind: "entering-url"; target: InstallTarget; force: boolean }
  | { kind: "entering-custom-url"; target: InstallTarget };

type PluginAction =
  | "install-warp"
  | "install-warp-force"
  | "install-warp-git"
  | "install-agents"
  | "install-agents-force";

type NewPluginTarget = "warp" | "agents";

const TARGET_LABELS: Record<InstallTarget, string> = {
  warp: "Warp",
  agents: "Agents",
  claude: "Claude Code",
  codex: "Codex",
  oz: "Oz",
};

const INSTALLED_TRAILING: MenuItemTrailing = {
  icon: icons.check,
  color: colors.success as ColorName,
  text: "instalado",
};

const NOT_INSTALLED_TRAILING: MenuItemTrailing = {
  icon: "–",
  color: colors.fgMoreSubtle as ColorName,
  text: "no instalado",
};

function targetTrailing(plugin: PluginEntry, id: InstallTarget): MenuItemTrailing {
  const installed = plugin.targets.find((t) => t.id === id)?.installed === true;
  return installed ? INSTALLED_TRAILING : NOT_INSTALLED_TRAILING;
}

function buildActionMenuItems(plugin: PluginEntry): MenuItem<PluginAction>[] {
  return [
    {
      kind: "item",
      label: "Instalar/actualizar en Warp Terminal",
      value: "install-warp",
      trailing: targetTrailing(plugin, "warp"),
    },
    { kind: "item", label: "Reinstalar en Warp Terminal (force)", value: "install-warp-force" },
    { kind: "item", label: "Clonar desde git e instalar en Warp", value: "install-warp-git" },
    { kind: "section" },
    {
      kind: "item",
      label: "Instalar/actualizar en Oz/Agents",
      value: "install-agents",
      trailing: targetTrailing(plugin, "agents"),
    },
    { kind: "item", label: "Reinstalar en Oz/Agents (force)", value: "install-agents-force" },
  ];
}

const NEW_PLUGIN_MENU_ITEMS: MenuItem<NewPluginTarget>[] = [
  { kind: "item", label: "Agregar nuevo plugin desde URL en Warp Terminal", value: "warp" },
  { kind: "item", label: "Agregar nuevo plugin desde URL en Oz/Agents", value: "agents" },
];

export function PluginsTab({ ctx, isActive }: PluginsTabProps) {
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  useEffect(() => {
    if (mode.kind === "idle") unlock();
    else {
      lock();
      setToast(null);
    }
  }, [mode, lock, unlock]);

  useEffect(() => {
    return () => unlock();
  }, [unlock]);

  const refresh = useCallback(async () => {
    const home = ctx.env.homeDir();
    const entries = await buildPluginEntries(home);
    setPlugins(entries);
    setCursor((c) => Math.min(Math.max(0, entries.length - 1), Math.max(0, c)));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const installFromLocal = useCallback(
    async (target: InstallTarget, force: boolean) => {
      const plugin = plugins[cursor];
      if (!plugin?.sourcePath) return false;
      setBusy(`instalando en ${target}…`);
      setToast(null);
      try {
        const args = {
          rest: [],
          plugin: {},
          flags: new Set(force ? ["--force"] : []),
          values: new Map<string, string>([
            ["from", plugin.sourcePath],
            ["target", target],
            ["namespace", plugin.namespace],
          ]),
          valuesMulti: new Map(),
        };
        const result = await selfInstallPluginSkills(args, ctx);
        const summary = result.data?.summary ?? result.error?.message ?? "";
        setToast({ tone: result.ok ? "success" : "error", message: summary });
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setBusy(null);
      }
      return true;
    },
    [plugins, cursor, ctx, refresh],
  );

  const installFromGit = useCallback(
    async (
      target: InstallTarget,
      force: boolean,
      url: string,
      ref?: string | null,
      namespaceOverride?: string,
    ) => {
      const namespace = namespaceOverride ?? plugins[cursor]?.namespace ?? "";
      const label = TARGET_LABELS[target] ?? target;
      setBusy(`clonando e instalando en ${label}…`);
      setToast(null);
      try {
        const fullUrl = ref ? `${url}#${ref}` : url;
        const args = {
          rest: [],
          plugin: {},
          flags: new Set(force ? ["--force"] : []),
          values: new Map<string, string>([
            ["url", fullUrl],
            ["target", target],
            ["namespace", namespace],
          ]),
          valuesMulti: new Map(),
        };
        const result = await installPluginSkillsFromGit(args, ctx);
        const summary = result.data?.summary ?? result.error?.message ?? "";
        setToast({ tone: result.ok ? "success" : "error", message: summary });
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [plugins, cursor, ctx, refresh],
  );

  const install = useCallback(
    async (target: InstallTarget, force = false, forceGit = false) => {
      const plugin = plugins[cursor];
      if (!plugin) return;

      if (!forceGit && plugin.sourcePath) {
        await installFromLocal(target, force);
        return;
      }
      if (plugin.sourceUrl) {
        await installFromGit(target, force, plugin.sourceUrl, plugin.sourceRef);
        return;
      }
      // No source available — ask user for URL
      setMode({ kind: "entering-url", target, force });
    },
    [plugins, cursor, installFromLocal, installFromGit],
  );

  const addCustom = useCallback((target: InstallTarget) => {
    setMode({ kind: "entering-custom-url", target });
  }, []);

  useInput(
    (input, key) => {
      if (!isActive || busy || mode.kind !== "idle") return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (plugins.length === 0 ? 0 : Math.min(plugins.length - 1, c + 1)));
        return;
      }
      if (input === "n" || input === "N") {
        setMode({ kind: "new-plugin-menu" });
        return;
      }
      if (key.return) {
        const target = plugins[cursor];
        if (target) setMode({ kind: "action-menu", target });
      }
    },
    { isActive },
  );

  // Esc cancela cualquier overlay (action-menu / new-plugin-menu / entering-url / entering-custom-url).
  useInput(
    (_, key) => {
      if (!isActive) return;
      if (mode.kind === "idle") return;
      if (key.escape) setMode({ kind: "idle" });
    },
    { isActive },
  );

  const handleActionSelect = useCallback(
    (action: PluginAction) => {
      if (mode.kind !== "action-menu") return;
      setMode({ kind: "idle" });
      switch (action) {
        case "install-warp":
          void install("warp");
          return;
        case "install-warp-force":
          void install("warp", true);
          return;
        case "install-warp-git":
          void install("warp", false, true);
          return;
        case "install-agents":
          void install("agents");
          return;
        case "install-agents-force":
          void install("agents", true);
          return;
      }
    },
    [mode, install],
  );

  const handleNewPluginSelect = useCallback(
    (target: NewPluginTarget) => {
      setMode({ kind: "idle" });
      addCustom(target);
    },
    [addCustom],
  );

  if (mode.kind === "action-menu") {
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Warp Plugins
        </Text>
        <Box marginTop={1}>
          <Text color={colors.fgSubtle}>
            {icons.bullet} acciones de{" "}
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

  if (mode.kind === "new-plugin-menu") {
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Warp Plugins
        </Text>
        <Box marginTop={1}>
          <Text color={colors.fgSubtle}>{icons.bullet} agregar nuevo plugin desde URL git</Text>
        </Box>
        <Box marginTop={1}>
          <SectionedMenu
            items={NEW_PLUGIN_MENU_ITEMS}
            onSelect={handleNewPluginSelect}
            isActive={isActive}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle}>Esc para cerrar sin aplicar.</Text>
        </Box>
      </Box>
    );
  }

  // URL entry mode overlay
  if (mode.kind === "entering-url") {
    const label = TARGET_LABELS[mode.target] ?? mode.target;
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Warp Plugins
        </Text>
        <Box marginTop={1}>
          <InputPrompt
            message={`URL git del plugin para instalar en ${label}:`}
            validate={(v) => v.startsWith("http") || "Debe ser una URL git válida (https://...)"}
            onSubmit={(url) => {
              setMode({ kind: "idle" });
              void installFromGit(mode.target, mode.force, url);
            }}
            isActive
          />
        </Box>
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle}>Esc para cancelar · ⏎ para confirmar</Text>
        </Box>
      </Box>
    );
  }

  // Custom-URL entry overlay (`n` / `N` from the listing)
  if (mode.kind === "entering-custom-url") {
    const label = TARGET_LABELS[mode.target] ?? mode.target;
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Warp Plugins
        </Text>
        <Box marginTop={1}>
          <InputPrompt
            message={`URL git de un plugin nuevo (acepta #rama) — destino ${label}:`}
            validate={(v) => v.startsWith("http") || "Debe ser una URL git válida (https://...)"}
            onSubmit={(raw) => {
              const target = mode.target;
              setMode({ kind: "idle" });
              const ns = extractNamespaceFromUrl(raw);
              void installFromGit(target, true, raw, null, ns);
            }}
            isActive
          />
        </Box>
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle}>
            Esc para cancelar · ⏎ para confirmar · ej:
            https://bitbucket.org/foo/my-plugin.git#feature/x
          </Text>
        </Box>
      </Box>
    );
  }

  if (plugins.length === 0 && !busy) {
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Warp Plugins
        </Text>
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle} italic>
            (sin plugins detectados — pulsa <Text color={colors.accent}>n</Text> para agregar desde
            URL git, o instala qtc-workflow-plugin desde el marketplace de Claude Code)
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.fg} bold>
        Warp Plugins
      </Text>
      <Box marginTop={1} flexDirection="column">
        {plugins.map((plugin, i) => (
          <PluginRow key={plugin.id} plugin={plugin} focused={isActive && i === cursor} />
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

function PluginRow({ plugin, focused }: { plugin: PluginEntry; focused: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={focused ? colors.primary : colors.fgMoreSubtle} bold={focused}>
          {focused ? icons.focusBullet : " "}
        </Text>
        <Text color={focused ? colors.fg : colors.fgSubtle} bold={focused}>
          {plugin.label}
        </Text>
        {plugin.version ? <Text color={colors.fgMoreSubtle}> v{plugin.version}</Text> : null}
        {plugin.skillCount !== null ? (
          <Text color={colors.fgMoreSubtle}> · {plugin.skillCount} skills</Text>
        ) : null}
        {!plugin.sourcePath && !plugin.sourceUrl ? (
          <Text color={colors.warning}> (fuente no encontrada)</Text>
        ) : !plugin.sourcePath && plugin.sourceUrl ? (
          <Text color={colors.fgMoreSubtle}> (instalará desde git)</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {plugin.targets.map((t) => (
          <Box key={t.id}>
            <Text color={t.installed ? colors.success : colors.fgMoreSubtle} bold={t.installed}>
              {t.installed ? icons.check : "–"}{" "}
            </Text>
            <Text color={colors.fgSubtle}>{t.label}</Text>
            <Text color={colors.fgMoreSubtle}> · {t.path}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

async function buildPluginEntries(homeDir: string): Promise<PluginEntry[]> {
  const qtcEntry = await detectQtcPlugin(homeDir);
  return qtcEntry ? [qtcEntry] : [];
}

async function detectQtcPlugin(homeDir: string): Promise<PluginEntry> {
  const cacheBase = join(homeDir, ".claude", "plugins", "cache", "qtc-marketplace", "qtc");
  const version = await findLatestVersion(cacheBase);
  const skillsDir = version ? join(cacheBase, version, "skills") : null;
  const skillCount = skillsDir ? await countSkillDirs(skillsDir) : null;

  const ns = "qtc";
  const targets: PluginTargetStatus[] = [
    {
      id: "warp",
      label: "Warp Terminal",
      path: `~/.warp/skills/${ns}-*/`,
      installed: await isInstalled(homeDir, "warp", ns),
    },
    {
      id: "agents",
      label: "Oz / Agents",
      path: `~/.agents/skills/${ns}-*/`,
      installed: await isInstalled(homeDir, "agents", ns),
    },
  ];

  return {
    id: "qtc",
    label: "qtc-workflow-plugin",
    namespace: ns,
    sourcePath: skillsDir,
    sourceUrl: "https://bitbucket.org/adminqtc-ti/qtc-workflow-plugin.git",
    sourceRef: "feature/last",
    version: version ?? null,
    skillCount,
    targets,
  };
}

async function findLatestVersion(base: string): Promise<string | null> {
  try {
    const entries = await readdir(base);
    const versions = entries.filter((e) => /^\d+\.\d+\.\d+/.test(e)).sort(semverDesc);
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

async function countSkillDirs(skillsDir: string): Promise<number | null> {
  try {
    const entries = await readdir(skillsDir);
    let count = 0;
    for (const e of entries) {
      try {
        const s = await stat(join(skillsDir, e));
        if (s.isDirectory()) count += 1;
      } catch {
        // skip
      }
    }
    return count;
  } catch {
    return null;
  }
}

async function isInstalled(
  homeDir: string,
  target: InstallTarget,
  namespace: string,
): Promise<boolean> {
  const marker = `${namespace}-session`;
  const roots: Record<string, string[]> = {
    warp: [".warp", "skills"],
    agents: [".agents", "skills"],
    claude: [".claude", "skills"],
    codex: [".codex", "skills"],
    oz: [".agents", "skills"],
  };
  const segments = roots[target];
  if (!segments) return false;
  const markerPath = join(homeDir, ...segments, marker);
  try {
    await stat(markerPath);
    return true;
  } catch {
    return false;
  }
}

function semverDesc(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map(Number);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
}

export function extractNamespaceFromUrl(rawUrl: string): string {
  const url = rawUrl.split("#")[0] ?? rawUrl;
  const lastSeg = url.replace(/\/+$/, "").split("/").pop() ?? "";
  const cleaned = lastSeg.replace(/\.git$/i, "");
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 32);
}
