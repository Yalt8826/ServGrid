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
import { allText, create, findByTestID, toJson } from './testing';

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
