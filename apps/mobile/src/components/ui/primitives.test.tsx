/**
 * Tests for the remaining primitives (T0.12): Select, DatePicker,
 * Sheet, Banner, Skeleton, Chip, EmptyState, ConfirmDialog — each in
 * the eight states, with the doc contracts asserted.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import { DensityProvider } from './DensityProvider';
import { Select } from './Select';
import { DatePicker, formatDateEnIN } from './DatePicker';
import { Sheet } from './Sheet';
import { Banner } from './Banner';
import { Skeleton } from './Skeleton';
import { Chip } from './Chip';
import { EmptyState } from './EmptyState';
import { ConfirmDialog } from './ConfirmDialog';
import { allText, create, findByTestID, toJson, type Node } from './testing';

function mount(ui: React.ReactElement, density: 'field' | 'console' | 'desk' = 'field') {
  return create(<DensityProvider density={density}>{ui}</DensityProvider>);
}

describe('Select', () => {
  const opts = [
    { value: 'te', label: 'Technician' },
    { value: 'di', label: 'Dispatcher' },
  ];
  it('renders all eight state shapes without throwing', async () => {
    for (const d of ['field', 'console', 'desk'] as const) {
      await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} testID="sel" />, d);
    }
    await mount(<Select label="Role" value="te" options={opts} onSelect={() => {}} testID="sel" />);
    await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} disabled testID="sel" />);
    await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} loading testID="sel" />);
    await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} errorText="Pick one" testID="sel" />);
  });
  it('shows the selected label, not a placeholder, once chosen', async () => {
    const r = await mount(<Select label="Role" value="te" options={opts} onSelect={() => {}} testID="sel" />);
    expect(allText(toJson(r))).toContain('Technician');
    expect(allText(toJson(r))).not.toContain('Select');
  });
});

/**
 * The dropdown itself (OW.1, 2026-09-16). Until this task the trigger
 * rendered and nothing opened — pressing it re-selected the value already
 * chosen — so every filter built on `Select` was dead on every screen.
 * These are the behaviours a filter needs to actually be one. Under the
 * test stub `Platform.OS` is `android`, so the native `Sheet` path is what
 * runs here; the web popover shares this state machine and differs only in
 * where the rows are painted.
 */
describe('Select — the menu opens, filters, chooses and closes', () => {
  const opts = [
    { value: 'te', label: 'Technician' },
    { value: 'di', label: 'Dispatcher' },
  ];

  async function press(node: Node | undefined): Promise<void> {
    expect(node).toBeDefined();
    await act(async () => {
      (node!.props as { onPress: () => void }).onPress();
    });
  }

  it('starts closed — no options in the tree until asked', async () => {
    const r = await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} testID="sel" />);
    expect(findByTestID(toJson(r), 'sel-options')).toBeUndefined();
    expect(findByTestID(toJson(r), 'sel-option-te')).toBeUndefined();
  });

  it('the trigger opens it, and every option is a row', async () => {
    const r = await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} testID="sel" />);
    await press(findByTestID(toJson(r), 'sel-trigger'));
    expect(findByTestID(toJson(r), 'sel-option-te')).toBeDefined();
    expect(findByTestID(toJson(r), 'sel-option-di')).toBeDefined();
  });

  it('choosing a row reports that value and closes the menu', async () => {
    const chosen: string[] = [];
    const r = await mount(
      <Select label="Role" value={null} options={opts} onSelect={(v) => chosen.push(v)} testID="sel" />,
    );
    await press(findByTestID(toJson(r), 'sel-trigger'));
    await press(findByTestID(toJson(r), 'sel-option-di'));
    expect(chosen).toEqual(['di']);
    expect(findByTestID(toJson(r), 'sel-option-di')).toBeUndefined();
  });

  it('marks the chosen row as selected, so the open menu says where you are', async () => {
    const r = await mount(<Select label="Role" value="te" options={opts} onSelect={() => {}} testID="sel" />);
    await press(findByTestID(toJson(r), 'sel-trigger'));
    const row = findByTestID(toJson(r), 'sel-option-te');
    expect((row!.props as { accessibilityState?: { selected?: boolean } }).accessibilityState?.selected).toBe(true);
  });

  it('the caret says which way it opens', async () => {
    const r = await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} testID="sel" />);
    expect(allText(findByTestID(toJson(r), 'sel-caret') ?? null).join('')).toBe('▼');
    await press(findByTestID(toJson(r), 'sel-trigger'));
    expect(allText(findByTestID(toJson(r), 'sel-caret') ?? null).join('')).toBe('▲');
  });

  it('a long list carries a filter field; a short one does not', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `t${i}`, label: `Technician ${i}` }));
    const short = await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} testID="sel" />);
    await press(findByTestID(toJson(short), 'sel-trigger'));
    expect(findByTestID(toJson(short), 'sel-search')).toBeUndefined();

    const long = await mount(<Select label="Who" value={null} options={many} onSelect={() => {}} testID="who" />);
    await press(findByTestID(toJson(long), 'who-trigger'));
    expect(findByTestID(toJson(long), 'who-search')).toBeDefined();
  });

  // The rep's accounts and catalogue are five rows today and will not stay
  // that way. The caller knows that; the list's own length never will.
  it('a caller can force the filter field on a short list, or off a long one', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `t${i}`, label: `Technician ${i}` }));

    const forcedOn = await mount(
      <Select label="Customer" value={null} options={opts} onSelect={() => {}} searchable testID="on" />,
    );
    await press(findByTestID(toJson(forcedOn), 'on-trigger'));
    expect(findByTestID(toJson(forcedOn), 'on-search')).toBeDefined();

    const forcedOff = await mount(
      <Select label="Who" value={null} options={many} onSelect={() => {}} searchable={false} testID="off" />,
    );
    await press(findByTestID(toJson(forcedOff), 'off-trigger'));
    expect(findByTestID(toJson(forcedOff), 'off-search')).toBeUndefined();
  });

  it('typing filters the rows, and nothing matching says so', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `t${i}`, label: `Technician ${i}` }));
    const r = await mount(<Select label="Who" value={null} options={many} onSelect={() => {}} testID="who" />);
    await press(findByTestID(toJson(r), 'who-trigger'));

    const type = async (text: string): Promise<void> => {
      const field = findByTestID(toJson(r), 'who-search');
      await act(async () => {
        (field!.props as { onChangeText: (next: string) => void }).onChangeText(text);
      });
    };

    await type('Technician 1');
    expect(findByTestID(toJson(r), 'who-option-t1')).toBeDefined();
    expect(findByTestID(toJson(r), 'who-option-t2')).toBeUndefined();

    await type('plumber');
    expect(findByTestID(toJson(r), 'who-no-match')).toBeDefined();
  });

  it('outranks whatever is painted after it while open (OW.5)', async () => {
    // The menu used to open BEHIND the table it filters: a z-index only
    // competes inside its own stacking context, and the table is the
    // later sibling. The field itself has to rise while it is open.
    const r = await mount(<Select label="Role" value={null} options={opts} onSelect={() => {}} testID="sel" />);
    const styleOf = (node: Node | undefined): Record<string, unknown> =>
      Object.assign({}, ...(Array.isArray(node?.props.style) ? node!.props.style : [node?.props.style]).filter(Boolean));

    expect(styleOf(findByTestID(toJson(r), 'sel')).zIndex).toBeUndefined();
    await press(findByTestID(toJson(r), 'sel-trigger'));
    expect(styleOf(findByTestID(toJson(r), 'sel')).zIndex).toBe(50);
  });

  it('dismissing without choosing changes nothing', async () => {
    const chosen: string[] = [];
    const r = await mount(
      <Select label="Role" value={null} options={opts} onSelect={(v) => chosen.push(v)} testID="sel" />,
    );
    await press(findByTestID(toJson(r), 'sel-trigger'));
    await press(findByTestID(toJson(r), 'sel-sheet-scrim'));
    expect(chosen).toEqual([]);
    expect(findByTestID(toJson(r), 'sel-option-te')).toBeUndefined();
  });
});

describe('DatePicker', () => {
  it('formats D MMM this year and D MMM YYYY otherwise (§6)', () => {
    expect(formatDateEnIN('2026-03-14', 2026)).toBe('14 Mar');
    expect(formatDateEnIN('2027-03-14', 2026)).toBe('14 Mar 2027');
  });
  it('renders the eight state shapes without throwing', async () => {
    for (const d of ['field', 'console', 'desk'] as const) {
      await mount(<DatePicker label="Date" value={null} onChange={() => {}} testID="dp" />, d);
    }
    await mount(<DatePicker label="Date" value="2026-03-14" onChange={() => {}} testID="dp" />);
    await mount(<DatePicker label="Date" value={null} onChange={() => {}} disabled testID="dp" />);
    await mount(<DatePicker label="Date" value={null} onChange={() => {}} loading testID="dp" />);
    await mount(<DatePicker label="Date" value={null} onChange={() => {}} errorText="Pick a date" testID="dp" />);
  });
});

describe('Sheet', () => {
  it('hidden renders nothing; visible renders title and scrim', async () => {
    const hidden = await mount(<Sheet visible={false} onDismiss={() => {}} testID="sheet" />);
    expect(toJson(hidden)).toBeNull();
    const r = await mount(
      <Sheet visible title="Complete job" onDismiss={() => {}} testID="sheet" />,
    );
    expect(allText(toJson(r))).toContain('Complete job');
    expect(findByTestID(toJson(r), 'sheet-scrim')).toBeTruthy();
  });
  it('never dismisses on scrim tap with unsaved input — asks instead', async () => {
    let dismissed = 0;
    const r = await mount(
      <Sheet visible hasUnsavedInput onDismiss={() => (dismissed += 1)} testID="sheet" />,
    );
    const scrim = findByTestID(toJson(r), 'sheet-scrim')!;
    await act(async () => {
      scrim.props.onPress?.();
    });
    expect(dismissed).toBe(0);
    expect(allText(toJson(r)).join(' | ')).toContain('Unsaved changes');
  });
  it('dismisses on scrim tap when clean', async () => {
    let dismissed = 0;
    const r = await mount(<Sheet visible onDismiss={() => (dismissed += 1)} testID="sheet" />);
    const scrim = findByTestID(toJson(r), 'sheet-scrim')!;
    await act(async () => {
      scrim.props.onPress?.();
    });
    expect(dismissed).toBe(1);
  });
});

describe('Banner', () => {
  it('renders the four tones without throwing', async () => {
    for (const tone of ['danger', 'warning', 'success', 'info'] as const) {
      await mount(<Banner tone={tone} message="Server says no" testID="b" />);
    }
  });
  it('shows the server message verbatim with up to two actions', async () => {
    const r = await mount(
      <Banner
        tone="danger"
        message="Job already closed"
        actions={[
          { label: 'Retry', onPress: () => {} },
          { label: 'Details', onPress: () => {} },
        ]}
        testID="b"
      />,
    );
    const texts = allText(toJson(r));
    expect(texts).toContain('Job already closed');
    expect(texts).toContain('Retry');
    expect(texts).toContain('Details');
  });
});

describe('Skeleton', () => {
  it('waits 200ms before appearing (no flash on fast loads)', async () => {
    const r = await mount(<Skeleton width={120} height={16} testID="sk" />);
    expect(toJson(r)).toBeNull();
    await act(async () => {
      await new Promise((res) => setTimeout(res, 260));
    });
    expect(toJson(r)).not.toBeNull();
  });
});

describe('Chip', () => {
  it('toggles with the Selection haptic path', async () => {
    let toggles = 0;
    const r = await mount(<Chip label="AMC" selected onToggle={() => (toggles += 1)} testID="chip" />);
    const node = findByTestID(toJson(r), 'chip')!;
    await act(async () => {
      node.props.onPress?.();
    });
    expect(toggles).toBe(1);
  });
  it('renders at every density (32 / 36 tall)', async () => {
    for (const d of ['field', 'console', 'desk'] as const) {
      await mount(<Chip label="AMC" testID="chip" />, d);
    }
  });
});

describe('EmptyState', () => {
  it('one body line, one secondary action', async () => {
    const r = await mount(
      <EmptyState message="Nothing needs attention" actionLabel="Refresh" onAction={() => {}} testID="es" />,
    );
    const texts = allText(toJson(r));
    expect(texts).toContain('Nothing needs attention');
    expect(texts).toContain('Refresh');
  });
  it('informational empty has no action', async () => {
    const r = await mount(<EmptyState message="Nothing needs attention" testID="es" />);
    expect(allText(toJson(r))).toEqual(['Nothing needs attention']);
  });
});

describe('ConfirmDialog', () => {
  it('destructive on the right via danger variant, cancel present', async () => {
    const r = await mount(
      <ConfirmDialog
        visible
        title="Void job?"
        message="This cannot be undone."
        confirmLabel="Void job"
        onCancel={() => {}}
        onConfirm={() => {}}
        testID="cd"
      />,
    );
    expect(findByTestID(toJson(r), 'cd-confirm')).toBeTruthy();
    const texts = allText(toJson(r));
    expect(texts).toContain('Void job');
    expect(texts).toContain('Cancel');
  });
  it('disabled explains why', async () => {
    const r = await mount(
      <ConfirmDialog
        visible
        title="Void job?"
        message="This cannot be undone."
        confirmLabel="Void job"
        onCancel={() => {}}
        onConfirm={() => {}}
        disabled
        testID="cd"
      />,
    );
    expect(allText(toJson(r))).toContain('Unavailable while the server is unreachable');
  });
});
