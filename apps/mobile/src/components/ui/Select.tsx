/**
 * `Select` — the dropdown every filter and picker in the product is built
 * on (Phase 0 primitive list; rebuilt in OW.1, 2026-09-16).
 *
 * It used to be a stub: the trigger rendered in all its states, but the
 * press handler re-selected the value already chosen and no menu ever
 * opened, so every filter on every screen did nothing at all. That is the
 * bug this file exists to end.
 *
 * Two presentations behind ONE props contract, so no caller changes:
 *
 * - **Web** — an inline popover under the trigger, the shape a console
 *   filter has to have: click to open, click away or Escape to close,
 *   Up/Down to walk the options and Enter to take one. The backdrop is a
 *   sibling that covers the window, so the click that dismisses never
 *   reaches the thing behind it.
 * - **Native** — the `Sheet` the spec always named, because an absolutely
 *   positioned menu inside a scrolling list is clipped on Android and a
 *   thumb wants a big target anyway.
 *
 * **A long list gets a filter field** (over `SEARCH_THRESHOLD` options):
 * eight technicians are a list, sixty customers are a search, and the
 * dispatcher should not have to know which one he is looking at.
 *
 * The trigger keeps its old anatomy — label above, the chosen option as
 * the summary (never a placeholder once chosen), helper or error caption
 * below — and its density heights: 52 field, 44 console, 36 desk.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { haptic } from './haptics';
import { Sheet } from './Sheet';
import { captionStyle } from './uiBase';

/** Web is the only surface with a pointer to click away with and a keyboard to walk the list. */
const WEB = Platform.OS === 'web';

/** Above this many options the menu carries a filter field. */
export const SEARCH_THRESHOLD = 8;

/** The popover's ceiling: past this it scrolls rather than running off the window. */
const MENU_MAX_HEIGHT = 320;

export interface SelectOption {
  value: string;
  label: string;
  /** Second line on the row — the load count, the area, whatever discriminates. */
  caption?: string;
}

export interface SelectProps {
  label: string;
  value: string | null;
  options: SelectOption[];
  onSelect: (value: string) => void;
  /** The summary when nothing is chosen. Defaults to "Select". */
  placeholder?: string;
  helperText?: string;
  errorText?: string;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}

function rowHeightFor(density: 'field' | 'console' | 'desk'): number {
  return density === 'field' ? TAP.min : density === 'console' ? 44 : 36;
}

export function Select({
  label,
  value,
  options,
  onSelect,
  placeholder = 'Select',
  helperText,
  errorText,
  disabled = false,
  loading = false,
  testID,
}: SelectProps): React.ReactNode {
  const density = useDensity();
  const [pressed, setPressed] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Which row the keyboard is on. -1 means "nothing highlighted yet", so the
  // first Down lands on the top row rather than skipping it.
  const [active, setActive] = useState(-1);
  const closedBy = useRef<'select' | 'dismiss' | null>(null);

  const height = rowHeightFor(density);
  const selected = options.find((o) => o.value === value) ?? null;
  const searchable = options.length > SEARCH_THRESHOLD;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(needle) || (o.caption ?? '').toLowerCase().includes(needle),
    );
  }, [options, query]);

  // Opening starts clean: the filter empty, the highlight on the chosen row
  // so Enter without arrowing re-picks what is already there.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(selected === null ? -1 : options.findIndex((o) => o.value === selected.value));
  }, [open, options, selected]);

  function close(): void {
    closedBy.current = 'dismiss';
    setOpen(false);
  }

  function choose(optionValue: string): void {
    closedBy.current = 'select';
    haptic('pickerSelect');
    onSelect(optionValue);
    setOpen(false);
  }

  function moveHighlight(delta: number): void {
    if (visible.length === 0) return;
    setActive((current) => {
      const next = current + delta;
      if (next < 0) return visible.length - 1;
      if (next >= visible.length) return 0;
      return next;
    });
  }

  /**
   * Web keyboard handling. react-native-web forwards `onKeyDown` to the DOM
   * node; the cast is how a web-only prop passes React Native's types
   * without a platform fork of the whole component.
   */
  const keyHandlers = WEB
    ? ({
        onKeyDown: (event: { key?: string; preventDefault?: () => void }) => {
          const key = event.key ?? '';
          if (key === 'Escape' && open) {
            event.preventDefault?.();
            close();
            return;
          }
          if ((key === 'ArrowDown' || key === 'ArrowUp') && !disabled && !loading) {
            event.preventDefault?.();
            if (!open) {
              setOpen(true);
              return;
            }
            moveHighlight(key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if ((key === 'Enter' || key === ' ') && open) {
            event.preventDefault?.();
            const row = visible[active];
            if (row !== undefined) choose(row.value);
          }
        },
      } as Record<string, unknown>)
    : {};

  const rows = (
    <ScrollView
      style={{ maxHeight: MENU_MAX_HEIGHT }}
      keyboardShouldPersistTaps="handled"
      testID={testID ? `${testID}-options` : undefined}
    >
      {visible.length === 0 ? (
        <Text
          testID={testID ? `${testID}-no-match` : undefined}
          style={{ ...captionStyle.caption, padding: SPACE[3] }}
        >
          Nothing matches.
        </Text>
      ) : (
        visible.map((option, index) => {
          const isSelected = option.value === value;
          const isActive = index === active;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              testID={testID ? `${testID}-option-${option.value}` : undefined}
              onPress={() => choose(option.value)}
              onHoverIn={WEB ? () => setActive(index) : undefined}
              style={{
                minHeight: Math.max(height, TAP.min - 8),
                paddingHorizontal: SPACE[3],
                paddingVertical: SPACE[2],
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: SPACE[2],
                backgroundColor: isActive ? SEMANTIC.bg.pressed : 'transparent',
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    ...textStyle('body', density),
                    color: SEMANTIC.text.primary,
                    fontWeight: isSelected ? '600' : '400',
                  }}
                >
                  {option.label}
                </Text>
                {option.caption !== undefined ? (
                  <Text style={captionStyle.caption}>{option.caption}</Text>
                ) : null}
              </View>
              {isSelected ? (
                <Text style={{ ...textStyle('body', density), color: SEMANTIC.text.primary }}>✓</Text>
              ) : null}
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );

  const filterField = searchable ? (
    <View style={{ padding: SPACE[2], borderBottomWidth: 1, borderBottomColor: SEMANTIC.line.default }}>
      <TextInputCompat
        value={query}
        onChangeText={setQuery}
        placeholder="Type to filter"
        density={density}
        testID={testID ? `${testID}-search` : undefined}
      />
    </View>
  ) : null;

  return (
    <View testID={testID} style={{ alignSelf: 'stretch' }} {...keyHandlers}>
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 }}>{label}</Text>

      <View style={{ position: 'relative' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled, expanded: open }}
          testID={testID ? `${testID}-trigger` : undefined}
          disabled={disabled || loading}
          onPress={() => {
            haptic('pickerSelect');
            setOpen((current) => !current);
          }}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={{
            height,
            minHeight: height,
            borderRadius: RADII.control,
            borderWidth: 1,
            borderColor: errorText
              ? SEMANTIC.feedback.danger
              : open
                ? SEMANTIC.line.focus
                : SEMANTIC.line.default,
            backgroundColor: disabled ? SEMANTIC.bg.pressed : pressed ? SEMANTIC.bg.pressed : SEMANTIC.bg.raised,
            paddingHorizontal: 12,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: SPACE[2],
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              ...textStyle('body', density),
              color: selected ? SEMANTIC.text.primary : SEMANTIC.text.placeholder,
              flex: 1,
            }}
          >
            {selected ? selected.label : placeholder}
          </Text>
          {loading ? (
            <Text style={captionStyle.caption}>…</Text>
          ) : (
            // The one affordance the stub never had: a caret that says this
            // opens, and which way it is pointing right now.
            <Text
              testID={testID ? `${testID}-caret` : undefined}
              style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}
            >
              {open ? '▲' : '▼'}
            </Text>
          )}
        </Pressable>

        {/* WEB: the popover and the click-away backdrop behind it. */}
        {WEB && open ? (
          <>
            <Pressable
              testID={testID ? `${testID}-backdrop` : undefined}
              accessibilityRole="button"
              onPress={close}
              style={{ position: 'absolute', top: -2000, left: -2000, right: -2000, bottom: -2000 }}
            />
            <View
              testID={testID ? `${testID}-menu` : undefined}
              style={{
                position: 'absolute',
                top: height + 4,
                left: 0,
                right: 0,
                zIndex: 20,
                backgroundColor: SEMANTIC.bg.raised,
                borderWidth: 1,
                borderColor: SEMANTIC.line.default,
                borderRadius: RADII.control,
                overflow: 'hidden',
              }}
            >
              {filterField}
              {rows}
            </View>
          </>
        ) : null}
      </View>

      {errorText ? (
        <Text
          testID={testID ? `${testID}-error` : undefined}
          style={[captionStyle.caption, { color: SEMANTIC.feedback.danger, marginTop: 4 }]}
        >
          {errorText}
        </Text>
      ) : helperText ? (
        <Text style={[captionStyle.caption, { marginTop: 4 }]}>{helperText}</Text>
      ) : null}

      {/* NATIVE: the sheet the spec named — no clipping, thumb-sized rows. */}
      {!WEB ? (
        <Sheet visible={open} title={label} onDismiss={close} testID={testID ? `${testID}-sheet` : undefined}>
          {filterField}
          {rows}
        </Sheet>
      ) : null}
    </View>
  );
}

/**
 * The filter field. `TextField` carries a label and its own spacing, which
 * is wrong inside a menu — this is the bare input the menu wants, with the
 * same border and type as everything else.
 */
function TextInputCompat({
  value,
  onChangeText,
  placeholder,
  density,
  testID,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  density: 'field' | 'console' | 'desk';
  testID?: string;
}): React.ReactNode {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={SEMANTIC.text.placeholder}
      testID={testID}
      style={{
        ...textStyle('body', density),
        color: SEMANTIC.text.primary,
        borderWidth: 1,
        borderColor: SEMANTIC.line.default,
        borderRadius: RADII.control,
        paddingHorizontal: SPACE[2],
        paddingVertical: SPACE[1],
        minHeight: rowHeightFor(density),
      }}
    />
  );
}
