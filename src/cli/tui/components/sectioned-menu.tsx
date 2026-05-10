import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { colors, icons } from "../theme.js";

export type MenuItem<T extends string> =
  | { kind: "item"; label: string; value: T; description?: string }
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

  return (
    <Box flexDirection="column">
      {keyedItems.map(({ item, index, key }) => {
        if (item.kind === "section") {
          if (!item.label) {
            return <Text key={key}> </Text>;
          }
          return (
            <Box key={key} marginTop={1}>
              <Text color={colors.fgMoreSubtle}>{icons.section.repeat(2)} </Text>
              <Text color={colors.accent} bold>
                {item.label}
              </Text>
            </Box>
          );
        }
        const selectable = selectables.find((entry) => entry.index === index);
        const isFocused = selectable?.index === selectables[focused]?.index;
        return (
          <Box key={key}>
            <Text color={isFocused ? colors.primary : colors.fgMoreSubtle} bold={isFocused}>
              {isFocused ? `${icons.focusBullet} ` : `${icons.dimBullet} `}
            </Text>
            <Text {...(isFocused ? { color: colors.fg, bold: true } : { color: colors.fgSubtle })}>
              {item.label}
            </Text>
          </Box>
        );
      })}
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
