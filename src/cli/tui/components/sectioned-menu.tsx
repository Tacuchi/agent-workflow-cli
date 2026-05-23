import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { type ColorName, colors, icons } from "../theme.js";

export interface MenuItemTrailing {
  icon: string;
  color: ColorName;
  text?: string;
}

export type MenuItem<T extends string> =
  | {
      kind: "item";
      label: string;
      value: T;
      description?: string;
      trailing?: MenuItemTrailing;
    }
  | { kind: "section"; label?: string };

export interface SectionedMenuProps<T extends string> {
  items: MenuItem<T>[];
  onSelect: (value: T) => void;
  isActive?: boolean;
  defaultValue?: T;
}

export function SectionedMenu<T extends string>(props: SectionedMenuProps<T>) {
  const { items, onSelect, isActive = true, defaultValue } = props;
  const selectables = items
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: Extract<MenuItem<T>, { kind: "item" }>; index: number } => {
      return entry.item.kind === "item";
    });

  const initialFocus = (() => {
    if (defaultValue === undefined) return 0;
    const found = selectables.findIndex((entry) => entry.item.value === defaultValue);
    return found >= 0 ? found : 0;
  })();

  const [focused, setFocused] = useState<number>(initialFocus);

  // Clamp defensivo: si los items cambian y el focus queda fuera de rango,
  // re-anclar al último seleccionable. Cubre menus dinámicos.
  useEffect(() => {
    if (selectables.length === 0) return;
    if (focused >= selectables.length) {
      setFocused(selectables.length - 1);
    }
  }, [selectables.length, focused]);

  useInput(
    (_, key) => {
      if (selectables.length === 0) return;
      if (key.upArrow) {
        setFocused((current) => (current - 1 + selectables.length) % selectables.length);
        return;
      }
      if (key.downArrow) {
        setFocused((current) => (current + 1) % selectables.length);
        return;
      }
      if (key.return) {
        const target = selectables[focused];
        if (target) onSelect(target.item.value);
      }
    },
    { isActive },
  );

  const keyedItems = computeStableKeys(items);
  const focusedIndex = selectables[focused]?.index;

  return (
    <Box flexDirection="column">
      {keyedItems.map(({ item, index, key }) => {
        if (item.kind === "section") {
          return <SectionRow key={key} label={item.label} />;
        }
        return <ItemRow key={key} item={item} isFocused={index === focusedIndex} />;
      })}
    </Box>
  );
}

function SectionRow({ label }: { label: string | undefined }) {
  if (!label) return <Text> </Text>;
  return (
    <Box marginTop={1}>
      <Text color={colors.fgMoreSubtle}>{icons.section.repeat(2)} </Text>
      <Text color={colors.accent} bold>
        {label}
      </Text>
    </Box>
  );
}

function ItemRow<T extends string>({
  item,
  isFocused,
}: {
  item: Extract<MenuItem<T>, { kind: "item" }>;
  isFocused: boolean;
}) {
  const trailing = item.trailing;
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color={isFocused ? colors.primary : colors.fgMoreSubtle} bold={isFocused}>
          {isFocused ? `${icons.focusBullet} ` : `${icons.dimBullet} `}
        </Text>
        <Text {...(isFocused ? { color: colors.fg, bold: true } : { color: colors.fgSubtle })}>
          {item.label}
        </Text>
      </Box>
      {trailing ? (
        <Text color={trailing.color}>
          {trailing.icon}
          {trailing.text ? ` ${trailing.text}` : ""}
        </Text>
      ) : null}
    </Box>
  );
}

function computeStableKeys<T extends string>(
  items: MenuItem<T>[],
): { item: MenuItem<T>; index: number; key: string }[] {
  const counters = new Map<string, number>();
  return items.map((item, index) => {
    const base = item.kind === "item" ? `i:${item.value}` : `s:${item.label ?? "blank"}`;
    const seen = counters.get(base) ?? 0;
    counters.set(base, seen + 1);
    return { item, index, key: seen === 0 ? base : `${base}#${seen}` };
  });
}
