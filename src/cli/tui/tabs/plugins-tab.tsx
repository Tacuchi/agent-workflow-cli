import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { installPluginSkillsFromGit } from "../../../application/self/install-plugin-skills-git.js";
import { selfInstallPluginSkills } from "../../../application/self/install-plugin-skills.js";
import type { InstallTarget } from "../../../application/self/install-skill.js";
import {
  type CacheTarget,
  selfClearPluginCache,
} from "../../../application/self/plugin-cache-clear.js";
import { selfReloadPluginCache } from "../../../application/self/plugin-cache-reload.js";
import type { CliContext } from "../../types.js";
import { HostChip, HostChipStrip } from "../components/host-chip.js";
import { InputPrompt } from "../components/input-prompt.js";
import { PageHead } from "../components/page-head.js";
import { Pill } from "../components/pill.js";
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

type HostId = "claude" | "codex" | "warp" | "agents";

interface PluginTargetStatus {
  id: HostId;
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
  | "install-agents-force"
  | "clear-claude"
  | "reload-claude"
  | "clear-codex"
  | "reload-codex"
  | "clear-warp"
  | "reload-warp"
  | "clear-agents"
  | "reload-agents";

type NewPluginTarget = "warp" | "agents";

const HOST_LABELS: Record<HostId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  warp: "Warp Terminal",
  agents: "Oz / Agents",
};

const INSTALLED_TRAILING: MenuItemTrailing = {
  icon: icons.check,
  color: colors.success as ColorName,
  text: "instalado",
};

const CACHED_TRAILING: MenuItemTrailing = {
  icon: icons.check,
  color: colors.success as ColorName,
  text: "cacheado",
};

const NOT_INSTALLED_TRAILING: MenuItemTrailing = {
  icon: "–",
  color: colors.fgMoreSubtle as ColorName,
  text: "no detectado",
};

function targetTrailing(plugin: PluginEntry, id: HostId): MenuItemTrailing {
  const installed = plugin.targets.find((t) => t.id === id)?.installed === true;
  if (!installed) return NOT_INSTALLED_TRAILING;
  return id === "claude" || id === "codex" ? CACHED_TRAILING : INSTALLED_TRAILING;
}

function buildActionMenuItems(plugin: PluginEntry): MenuItem<PluginAction>[] {
  const items: MenuItem<PluginAction>[] = [];

  // Claude Code section (host-managed cache)
  items.push({
    kind: "item",
    label: "Limpiar cache de Claude Code",
    value: "clear-claude",
    trailing: targetTrailing(plugin, "claude"),
  });
  items.push({
    kind: "item",
    label: "Recargar en Claude Code (limpiar + reiniciar host)",
    value: "reload-claude",
  });

  items.push({ kind: "section" });

  // Codex section
  items.push({
    kind: "item",
    label: "Limpiar cache de Codex",
    value: "clear-codex",
    trailing: targetTrailing(plugin, "codex"),
  });
  items.push({
    kind: "item",
    label: "Recargar en Codex (limpiar + reiniciar host)",
    value: "reload-codex",
  });

  items.push({ kind: "section" });

  // Warp section
  items.push({
    kind: "item",
    label: "Instalar/actualizar en Warp Terminal",
    value: "install-warp",
    trailing: targetTrailing(plugin, "warp"),
  });
  items.push({
    kind: "item",
    label: "Reinstalar en Warp Terminal (force)",
    value: "install-warp-force",
  });
  items.push({
    kind: "item",
    label: "Clonar desde git e instalar en Warp",
    value: "install-warp-git",
  });
  items.push({ kind: "item", label: "Limpiar instalación en Warp", value: "clear-warp" });
  items.push({
    kind: "item",
    label: "Recargar en Warp (limpiar + reinstalar desde cache)",
    value: "reload-warp",
  });

  items.push({ kind: "section" });

  // Agents section
  items.push({
    kind: "item",
    label: "Instalar/actualizar en Oz/Agents",
    value: "install-agents",
    trailing: targetTrailing(plugin, "agents"),
  });
  items.push({
    kind: "item",
    label: "Reinstalar en Oz/Agents (force)",
    value: "install-agents-force",
  });
  items.push({ kind: "item", label: "Limpiar instalación en Oz/Agents", value: "clear-agents" });
  items.push({
    kind: "item",
    label: "Recargar en Oz/Agents (limpiar + reinstalar desde cache)",
    value: "reload-agents",
  });

  return items;
}

const NEW_PLUGIN_MENU_ITEMS: MenuItem<NewPluginTarget>[] = [
  { kind: "item", label: "Agregar nuevo plugin desde URL en Warp Terminal", value: "warp" },
  { kind: "item", label: "Agregar nuevo plugin desde URL en Oz/Agents", value: "agents" },
];

type PluginFilter = "all" | "installed" | "missing" | "multi";

const PLUGIN_FILTERS: Array<{ id: PluginFilter; label: string }> = [
  { id: "all", label: "todos" },
  { id: "installed", label: "instalados" },
  { id: "missing", label: "faltantes" },
  { id: "multi", label: "multi-host" },
];

export function PluginsTab({ ctx, isActive }: PluginsTabProps) {
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState<PluginFilter>("all");
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  // Filtra plugins según el filter activo + query case-insensitive.
  const filteredPlugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (filter === "installed" && !p.targets.some((t) => t.installed)) return false;
      if (filter === "missing" && p.sourcePath !== null) return false;
      if (filter === "multi" && p.targets.filter((t) => t.installed).length < 2) return false;
      if (q && !p.label.toLowerCase().includes(q) && !p.namespace.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [plugins, filter, query]);

  // Cuando cambia el filtro, mover cursor al primero válido.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filteredPlugins.length - 1)));
  }, [filteredPlugins.length]);

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
      const plugin = filteredPlugins[cursor];
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
    [filteredPlugins, cursor, ctx, refresh],
  );

  const installFromGit = useCallback(
    async (
      target: InstallTarget,
      force: boolean,
      url: string,
      ref?: string | null,
      namespaceOverride?: string,
    ) => {
      const namespace = namespaceOverride ?? filteredPlugins[cursor]?.namespace ?? "";
      const label = HOST_LABELS[target as HostId] ?? target;
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
    [filteredPlugins, cursor, ctx, refresh],
  );

  const install = useCallback(
    async (target: InstallTarget, force = false, forceGit = false) => {
      const plugin = filteredPlugins[cursor];
      if (!plugin) return;

      if (!forceGit && plugin.sourcePath) {
        await installFromLocal(target, force);
        return;
      }
      if (plugin.sourceUrl) {
        await installFromGit(target, force, plugin.sourceUrl, plugin.sourceRef);
        return;
      }
      setMode({ kind: "entering-url", target, force });
    },
    [filteredPlugins, cursor, installFromLocal, installFromGit],
  );

  const clearCache = useCallback(
    async (target: CacheTarget) => {
      const plugin = filteredPlugins[cursor];
      if (!plugin) return;
      const label = HOST_LABELS[target];
      setBusy(`limpiando ${label}…`);
      setToast(null);
      try {
        const args = {
          rest: [],
          plugin: {},
          flags: new Set<string>(),
          values: new Map<string, string>([
            ["plugin", plugin.namespace],
            ["target", target],
          ]),
          valuesMulti: new Map(),
        };
        const result = await selfClearPluginCache(args, ctx);
        const summary = result.data?.summary ?? result.error?.message ?? "";
        setToast({ tone: result.ok ? "success" : "error", message: summary });
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [filteredPlugins, cursor, ctx, refresh],
  );

  const reloadCache = useCallback(
    async (target: CacheTarget) => {
      const plugin = filteredPlugins[cursor];
      if (!plugin) return;
      const label = HOST_LABELS[target];
      setBusy(`recargando ${label}…`);
      setToast(null);
      try {
        const args = {
          rest: [],
          plugin: {},
          flags: new Set<string>(),
          values: new Map<string, string>([
            ["plugin", plugin.namespace],
            ["target", target],
          ]),
          valuesMulti: new Map(),
        };
        const result = await selfReloadPluginCache(args, ctx);
        const summary = result.data?.summary ?? result.error?.message ?? "";
        setToast({ tone: result.ok ? "success" : "error", message: summary });
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [filteredPlugins, cursor, ctx, refresh],
  );

  const addCustom = useCallback((target: InstallTarget) => {
    setMode({ kind: "entering-custom-url", target });
  }, []);

  useInput(
    (input, key) => {
      if (!isActive || busy || mode.kind !== "idle") return;
      if (searchOpen) return; // InputPrompt has focus
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) =>
          filteredPlugins.length === 0 ? 0 : Math.min(filteredPlugins.length - 1, c + 1),
        );
        return;
      }
      if (input === "n" || input === "N") {
        setMode({ kind: "new-plugin-menu" });
        return;
      }
      if (input === "/") {
        setSearchOpen(true);
        return;
      }
      if (input === "f" || input === "F") {
        const idx = PLUGIN_FILTERS.findIndex((f) => f.id === filter);
        const next = PLUGIN_FILTERS[(idx + 1) % PLUGIN_FILTERS.length];
        if (next) setFilter(next.id);
        return;
      }
      if (input === "r" || input === "R") {
        void refresh();
        return;
      }
      if (key.return) {
        const target = filteredPlugins[cursor];
        if (target) setMode({ kind: "action-menu", target });
      }
    },
    { isActive },
  );

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
        case "clear-claude":
          void clearCache("claude");
          return;
        case "reload-claude":
          void reloadCache("claude");
          return;
        case "clear-codex":
          void clearCache("codex");
          return;
        case "reload-codex":
          void reloadCache("codex");
          return;
        case "clear-warp":
          void clearCache("warp");
          return;
        case "reload-warp":
          void reloadCache("warp");
          return;
        case "clear-agents":
          void clearCache("agents");
          return;
        case "reload-agents":
          void reloadCache("agents");
          return;
      }
    },
    [mode, install, clearCache, reloadCache],
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
          Plugins
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
          Plugins
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

  if (mode.kind === "entering-url") {
    const label = HOST_LABELS[mode.target as HostId] ?? mode.target;
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Plugins
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

  if (mode.kind === "entering-custom-url") {
    const label = HOST_LABELS[mode.target as HostId] ?? mode.target;
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Plugins
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

  const currentPlugin = filteredPlugins[cursor] ?? null;

  return (
    <Box flexDirection="column">
      <PageHead
        title="Plugins"
        count={{ label: `${filteredPlugins.length}/${plugins.length}`, tone: "info" }}
      />

      {/* Filtros + búsqueda */}
      <Box>
        {PLUGIN_FILTERS.map((f, idx) => (
          <Box key={f.id} marginLeft={idx === 0 ? 0 : 1}>
            <Text color={filter === f.id ? colors.accent : colors.fgFaint} bold={filter === f.id}>
              {filter === f.id ? `[${f.label}]` : ` ${f.label} `}
            </Text>
          </Box>
        ))}
        <Box marginLeft={2}>
          <Text color={colors.fgFaint}>
            <Text color={colors.accent} bold>
              f
            </Text>
            {" filtros · "}
            <Text color={colors.accent} bold>
              /
            </Text>
            {" buscar · "}
            <Text color={colors.accent} bold>
              r
            </Text>
            {" refrescar"}
          </Text>
        </Box>
      </Box>

      {searchOpen ? (
        <Box marginTop={1}>
          <InputPrompt
            message="Buscar plugin:"
            defaultValue={query}
            onSubmit={(v) => {
              setQuery(v.trim());
              setSearchOpen(false);
            }}
            isActive={isActive}
          />
        </Box>
      ) : query ? (
        <Box marginTop={1}>
          <Text color={colors.fgFaint}>filtro:</Text>
          <Text color={colors.info}> {query}</Text>
          <Text color={colors.fgFaint}> (Esc o `/` para cambiar)</Text>
        </Box>
      ) : null}

      {plugins.length === 0 && !busy ? (
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle} italic>
            (sin plugins detectados — pulsa <Text color={colors.accent}>n</Text> para agregar desde
            URL git, o instala un companion plugin desde el marketplace de Claude Code)
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          {/* lista */}
          <Box
            flexDirection="column"
            minWidth={42}
            marginRight={1}
            borderStyle="round"
            borderColor={colors.borderActive}
            paddingX={1}
          >
            <Text color={colors.fgMoreSubtle}>PLUGINS</Text>
            {filteredPlugins.length === 0 ? (
              <Text color={colors.fgFaint}>(sin resultados — `f` cambia filtro)</Text>
            ) : (
              filteredPlugins.map((p, i) => (
                <PluginListRow key={p.id} plugin={p} focused={isActive && i === cursor} />
              ))
            )}
          </Box>

          {/* detalle */}
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="round"
            borderColor={colors.borderFaint}
            paddingX={1}
          >
            <Text color={colors.fgMoreSubtle}>DETALLE</Text>
            {currentPlugin ? (
              <PluginDetail plugin={currentPlugin} />
            ) : (
              <Text color={colors.fgFaint}>(seleccioná un plugin)</Text>
            )}
          </Box>
        </Box>
      )}

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

function PluginListRow({ plugin, focused }: { plugin: PluginEntry; focused: boolean }) {
  const installedHosts = plugin.targets.filter((t) => t.installed).map((t) => t.id);
  return (
    <Box>
      <Text color={focused ? colors.accent : colors.fgFaint} {...(focused ? { bold: true } : {})}>
        {focused ? "▸" : " "}
      </Text>
      <Text> </Text>
      <Box minWidth={22}>
        <Text
          color={focused ? colors.fgBright : colors.fgSubtle}
          {...(focused ? { bold: true, inverse: true } : {})}
        >
          {focused ? ` ${plugin.namespace} ` : plugin.namespace}
        </Text>
      </Box>
      <Box minWidth={10}>
        <Text color={colors.info}>{plugin.version ? `v${plugin.version}` : "—"}</Text>
      </Box>
      <Box>
        <Text color={colors.fgFaint}>
          {installedHosts.length}/{plugin.targets.length}
        </Text>
      </Box>
      <Box marginLeft={1}>
        <HostChipStrip
          active={installedHosts}
          hosts={plugin.targets.map((t) => ({
            id: t.id,
            name: t.label,
            glyph: t.id[0]?.toUpperCase() ?? "?",
            short: t.id,
            backed: true,
          }))}
        />
      </Box>
    </Box>
  );
}

function PluginDetail({ plugin }: { plugin: PluginEntry }) {
  return (
    <Box flexDirection="column">
      <Text color={colors.fgBright} bold>
        {plugin.label}
      </Text>
      <Text color={colors.fgMoreSubtle}>
        version · <Text color={colors.info}>{plugin.version ?? "—"}</Text>
        {plugin.skillCount !== null ? (
          <Text color={colors.fgFaint}> · {plugin.skillCount} skills</Text>
        ) : null}
      </Text>
      {!plugin.sourcePath && !plugin.sourceUrl ? (
        <Box marginTop={1}>
          <Pill tone="warn">fuente no encontrada</Pill>
        </Box>
      ) : !plugin.sourcePath && plugin.sourceUrl ? (
        <Box marginTop={1}>
          <Pill tone="info">instalará desde git</Pill>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.fgMoreSubtle}>hosts</Text>
        {plugin.targets.map((t) => (
          <Box key={t.id}>
            <HostChip id={t.id} on={t.installed} />
            <Text> </Text>
            <Text color={t.installed ? colors.fgBright : colors.fgFaint}>{t.label}</Text>
            <Text color={colors.fgFaint}> · {t.path}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.fgFaint}>
          <Text color={colors.accent} bold>
            ⏎
          </Text>{" "}
          acciones ·{" "}
          <Text color={colors.accent} bold>
            n
          </Text>{" "}
          nuevo desde URL
        </Text>
      </Box>
    </Box>
  );
}

async function buildPluginEntries(homeDir: string): Promise<PluginEntry[]> {
  return detectCompanionPlugins(homeDir);
}

async function detectCompanionPlugins(homeDir: string): Promise<PluginEntry[]> {
  const tuples = await discoverPluginTuples(homeDir);
  const entries: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const { marketplace, namespace } of tuples) {
    if (seen.has(namespace)) continue;
    seen.add(namespace);
    const entry = await buildCompanionEntry(homeDir, marketplace, namespace);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function discoverPluginTuples(
  homeDir: string,
): Promise<Array<{ marketplace: string; namespace: string }>> {
  const tuples: Array<{ marketplace: string; namespace: string }> = [];
  const claudeCache = join(homeDir, ".claude", "plugins", "cache");
  try {
    const marketplaces = await readdir(claudeCache);
    for (const mp of marketplaces) {
      try {
        const plugins = await readdir(join(claudeCache, mp));
        for (const p of plugins) {
          try {
            const s = await stat(join(claudeCache, mp, p));
            if (s.isDirectory()) {
              tuples.push({ marketplace: mp, namespace: p });
            }
          } catch {
            // skip non-stat entries
          }
        }
      } catch {
        // skip non-readable marketplace
      }
    }
  } catch {
    // no claude cache yet
  }
  return tuples;
}

async function buildCompanionEntry(
  homeDir: string,
  marketplace: string,
  namespace: string,
): Promise<PluginEntry | null> {
  const cacheBase = join(homeDir, ".claude", "plugins", "cache", marketplace, namespace);
  const version = await findLatestVersion(cacheBase);
  const skillsDir = version ? join(cacheBase, version, "skills") : null;
  const skillCount = skillsDir ? await countSkillDirs(skillsDir) : null;

  const targets: PluginTargetStatus[] = [
    {
      id: "claude",
      label: HOST_LABELS.claude,
      path: `~/.claude/plugins/cache/*/${namespace}/`,
      installed: await isHostCacheDetected(homeDir, "claude", namespace),
    },
    {
      id: "codex",
      label: HOST_LABELS.codex,
      path: `~/.codex/plugins/cache/*/${namespace}/`,
      installed: await isHostCacheDetected(homeDir, "codex", namespace),
    },
    {
      id: "warp",
      label: HOST_LABELS.warp,
      path: `~/.warp/skills/${namespace}-*/`,
      installed: await areSkillsInstalled(homeDir, "warp", namespace),
    },
    {
      id: "agents",
      label: HOST_LABELS.agents,
      path: `~/.agents/skills/${namespace}-*/`,
      installed: await areSkillsInstalled(homeDir, "agents", namespace),
    },
  ];

  return {
    id: namespace,
    label: `${marketplace}/${namespace}`,
    namespace,
    sourcePath: skillsDir,
    sourceUrl: null,
    sourceRef: null,
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

async function isHostCacheDetected(
  homeDir: string,
  host: "claude" | "codex",
  namespace: string,
): Promise<boolean> {
  const cacheRoot = join(homeDir, `.${host}`, "plugins", "cache");
  try {
    const marketplaces = await readdir(cacheRoot);
    for (const mp of marketplaces) {
      const pluginDir = join(cacheRoot, mp, namespace);
      try {
        const s = await stat(pluginDir);
        if (s.isDirectory()) return true;
      } catch {
        // not here
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function areSkillsInstalled(
  homeDir: string,
  host: "warp" | "agents",
  namespace: string,
): Promise<boolean> {
  const skillsRoot = join(homeDir, `.${host}`, "skills");
  try {
    const entries = await readdir(skillsRoot);
    const prefix = `${namespace}-`;
    for (const e of entries) {
      if (!e.startsWith(prefix)) continue;
      try {
        const s = await stat(join(skillsRoot, e));
        if (s.isDirectory()) return true;
      } catch {
        // skip
      }
    }
  } catch {
    return false;
  }
  return false;
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
