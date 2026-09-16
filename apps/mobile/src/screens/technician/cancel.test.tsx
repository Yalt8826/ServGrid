/**
 * T5 Cancel sheet tests (T1.20, UI/plan-2/04-TECHNICIAN.md §T5) — the
 * four the spec names:
 *
 * 1. `other` without a note blocks submit.
 * 2. A past date is refused with a message, not silently clamped.
 * 3. Choosing a date renders the confirmation line with the formatted
 *    date.
 * 4. Reason rows are ≥52pt.
 *
 * Plus the 2B fact (an AMC job shows no warning — nothing is spent), the
 * §T5 motion facts (Selection haptic on reason rows), the payload's
 * strict shape, and the timeline fold of the server's cancelled event —
 * what the detail screen shows once the cancellation is filed. The pure
 * model (`cancelSheet.ts`) is asserted alongside the screen it drives.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { act } from 'react';
// The stub module DIRECTLY: same instance the vitest alias feeds
// `haptics.ts` under test, and the one with the `__fired` surface.
import * as Haptics from '../../test-stubs/expo-haptics';
import { alpha, COLORS, FRAME, SEMANTIC, TINT } from '@servgrid/shared';

import { allText, create, findAll, findByTestID, firstDescendantOfType, toJson, type Node } from '../../components/ui/testing';
import { CancelSheet, type CancelSheetDeps } from './CancelSheet';
import {
  cancelPayloadOf,
  rescheduleConfirmLine,
  rescheduleDateErrorOf,
  rescheduleWindow,
  submitBlockerOf,
  CANCEL_REASONS,
  type CancelSheetPayload,
} from './cancelSheet';
import { timelineFromEvents } from './jobDetail';
import type { JobView } from './jobView';

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST
const TODAY = '2026-09-11';

let seq = 0;

function viewOf(overrides: Partial<JobView['job']> = {}, extra: Partial<JobView> = {}): JobView {
  seq += 1;
  return {
    job: {
      id: `01890a5e-7800-7000-8000-${String(seq).padStart(12, '0')}`,
      jobNumber: 'JC-2627-00042',
      title: 'Battery swap',
      status: 'in_progress',
      priority: 'normal',
      scheduledFor: '2026-09-11T14:30:00+05:30',
      customerId: 'c1',
      contactName: 'Mr Prakash',
      contactPhone: '+919812345678',
      description: null,
      contract: null,
      version: 3,
      ...overrides,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: null,
    pending: false,
    rejectedMessage: null,
    ...extra,
  };
}

type Deps = CancelSheetDeps;

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    view: viewOf(),
    now: NOW,
    onSubmit: vi.fn(async (_payload: CancelSheetPayload) => {}),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

// ── harness helpers (the host-stub idiom of the sibling tests) ──────────────

function styleOf(node: Node | undefined): Record<string, unknown> {
  const raw = node?.props.style;
  const parts = (Array.isArray(raw) ? raw : [raw]).filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === 'object',
  );
  return Object.assign({}, ...parts);
}

/** The editable input inside a field subtree (TextField). */
function inputOf(tree: Node | string | null, testID: string): Node {
  const field = findByTestID(tree, testID);
  const input = field === undefined ? undefined : firstDescendantOfType(field, 'TextInput');
  if (input === undefined) throw new Error(`No TextInput under ${testID}`);
  return input;
}

async function typeInto(tree: Node | string | null, testID: string, text: string): Promise<void> {
  const input = inputOf(tree, testID);
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

async function press(tree: Node | string | null, testID: string): Promise<void> {
  const node = findByTestID(tree, testID);
  if (node === undefined) throw new Error(`Nothing rendered for ${testID}`);
  const hit = findAll(node, (candidate) => typeof candidate.props.onPress === 'function')[0];
  if (hit === undefined) throw new Error(`No pressable under ${testID}`);
  await act(async () => {
    hit.props.onPress?.();
  });
}

/**
 * Submit only if the button allows it — a disabled Pressable ignores the
 * press on a device, so the harness refuses to fake it too. THROWS
 * SYNCHRONOUSLY when the button is disabled.
 */
function trySubmit(tree: Node | string | null): Promise<void> {
  const button = findByTestID(tree, 'cancel-submit');
  const hit = findAll(button ?? null, (candidate) => typeof candidate.props.onPress === 'function')[0];
  const disabled = (hit?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
  if (disabled) throw new Error('Submit is disabled — the test must not fake a press the button would ignore.');
  return press(tree, 'cancel-submit');
}

function isDisabled(tree: Node | string | null): boolean {
  const button = findByTestID(tree, 'cancel-submit');
  const hit = findAll(button ?? null, (candidate) => typeof candidate.props.onPress === 'function')[0];
  return (hit?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
}

function submittedPayload(deps: Deps, call = 0): CancelSheetPayload {
  const mock = deps.onSubmit as ReturnType<typeof vi.fn>;
  expect(mock.mock.calls.length).toBeGreaterThan(call);
  return mock.mock.calls[call]![0] as CancelSheetPayload;
}

// ── the four ─────────────────────────────────────────────────────────────────

describe('CancelSheet (§T5)', () => {
  beforeEach(() => {
    seq = 0;
    Haptics.__reset();
  });

  it('1 · "other" without a note blocks submit', async () => {
    const deps = baseDeps();
    const renderer = await create(<CancelSheet {...deps} />);
    let tree = toJson(renderer);

    // No reason at all is blocked first, with the why under the button.
    expect(isDisabled(tree)).toBe(true);
    expect(allText(findByTestID(tree, 'cancel-submit') ?? null).join(' ')).toContain('Pick the reason');

    // The reason alone does not unlock it — the note is the rule the
    // server enforces (jobCancelSchema), asked here instead of at the drain.
    await press(tree, 'cancel-reason-other');
    tree = toJson(renderer);
    expect(isDisabled(tree)).toBe(true);
    expect(allText(findByTestID(tree, 'cancel-submit') ?? null).join(' ')).toContain('"Other" needs a note');
    expect(() => trySubmit(tree)).toThrow('Submit is disabled');

    // The note unlocks, and the payload carries both — and nothing else.
    await typeInto(tree, 'cancel-note', 'Gate locked, no answer on the phone.');
    tree = toJson(renderer);
    expect(isDisabled(tree)).toBe(false);
    await trySubmit(tree);

    const payload = submittedPayload(deps);
    expect(payload).toEqual({
      reasonCode: 'other',
      reasonNote: 'Gate locked, no answer on the phone.',
    });
    expect(deps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('2 · a past date is refused with a message, not silently clamped', async () => {
    const deps = baseDeps();
    const renderer = await create(<CancelSheet {...deps} />);
    let tree = toJson(renderer);

    await press(tree, 'cancel-reason-customer_unavailable');
    tree = toJson(renderer);
    expect(findByTestID(tree, 'cancel-reschedule-confirm')).toBeUndefined();

    // The date field's own fallback date is in the past — exactly the
    // attempt the guard exists for. It is REFUSED, loudly.
    await press(tree, 'cancel-reschedule-trigger');
    tree = toJson(renderer);
    const error = findByTestID(tree, 'cancel-reschedule-error');
    expect(error).toBeDefined();
    expect(allText(error ?? null).join(' ')).toBe('That date is in the past — pick a day that has not happened yet.');

    // Not applied, and not clamped to today either: no confirmation line.
    expect(findByTestID(tree, 'cancel-reschedule-confirm')).toBeUndefined();

    // Skippable means submittable: the refusal blocks nothing else.
    expect(isDisabled(tree)).toBe(false);
    await trySubmit(tree);
    const payload = submittedPayload(deps);
    expect('rescheduleTo' in payload).toBe(false);
    expect(payload.reasonCode).toBe('customer_unavailable');

    // The pure guard, table form: past refused, today legal, future legal.
    expect(rescheduleDateErrorOf('2026-09-10', TODAY)).toBe('That date is in the past — pick a day that has not happened yet.');
    expect(rescheduleDateErrorOf(TODAY, TODAY)).toBeNull();
    expect(rescheduleDateErrorOf('2026-09-12', TODAY)).toBeNull();
  });

  it('3 · choosing a date renders the confirmation line with the formatted date', async () => {
    const deps = baseDeps();
    const renderer = await create(<CancelSheet {...deps} />);
    let tree = toJson(renderer);

    await press(tree, 'cancel-reason-customer_unavailable');
    await press(tree, 'cancel-reschedule-open');
    tree = toJson(renderer);
    expect(findByTestID(tree, 'cancel-reschedule-picker')).toBeDefined();

    // Today through the next fortnight, every row a legal choice.
    const window = rescheduleWindow(TODAY);
    expect(window[0]).toBe('2026-09-11');
    expect(window).toHaveLength(14);
    expect(findByTestID(tree, `cancel-reschedule-option-${window[5]}`)).toBeDefined();

    await press(tree, 'cancel-reschedule-option-2026-09-16');
    tree = toJson(renderer);

    // THE confirmation line (§T5: *"Visit moves to 22 Mar."*), from state.
    const confirm = findByTestID(tree, 'cancel-reschedule-confirm');
    expect(confirm).toBeDefined();
    expect(allText(confirm ?? null).join(' ')).toBe('Visit moves to 16 Sep.');
    expect(findByTestID(tree, 'cancel-reschedule-error')).toBeUndefined();

    // The chosen date files verbatim — no shift, no clamp.
    expect(isDisabled(tree)).toBe(false);
    await trySubmit(tree);
    expect(submittedPayload(deps)).toEqual({
      reasonCode: 'customer_unavailable',
      rescheduleTo: '2026-09-16',
    });

    // Removing the date un-reveals the line: skippable both ways.
    const fresh = baseDeps();
    const freshRenderer = await create(<CancelSheet {...fresh} />);
    const freshTree = toJson(freshRenderer);
    await press(freshTree, 'cancel-reason-no_access');
    await press(toJson(freshRenderer), 'cancel-reschedule-open');
    await press(toJson(freshRenderer), 'cancel-reschedule-option-2026-09-12');
    await press(toJson(freshRenderer), 'cancel-reschedule-clear');
    expect(findByTestID(toJson(freshRenderer), 'cancel-reschedule-confirm')).toBeUndefined();
    expect(isDisabled(toJson(freshRenderer))).toBe(false);

    // And the pure label: this year drops the year, the spec's own example.
    expect(rescheduleConfirmLine('2026-03-22', 2026)).toBe('Visit moves to 22 Mar.');
    expect(rescheduleConfirmLine('2027-03-22', 2026)).toBe('Visit moves to 22 Mar 2027.');
  });

  it('4 · reason rows are ≥52pt', async () => {
    const renderer = await create(<CancelSheet {...baseDeps()} />);
    const tree = toJson(renderer);

    // All nine codes the server accepts (jobCancelSchema — one source of
    // truth), each a floor-sized row, never a ceiling-sized one: at 200%
    // dynamic type the label wraps and the row grows instead of clipping.
    for (const reason of CANCEL_REASONS) {
      const row = findByTestID(tree, `cancel-reason-${reason.code}`);
      expect(row).toBeDefined();
      const style = styleOf(row);
      expect(style.minHeight).toBe(52);
      expect(style.height).toBeUndefined();
    }

    // Not a dropdown: every row is tappable in the sheet itself.
    const rows = findAllByReasonTestID(tree);
    expect(rows).toHaveLength(CANCEL_REASONS.length);
  });
});

function findAllByReasonTestID(tree: Node | string | null): Node[] {
  return findAll(tree, (node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('cancel-reason-'));
}

// ── the Done-when box and the seams around the sheet ─────────────────────────

describe('CancelSheet — Done when (§T5)', () => {
  beforeEach(() => {
    seq = 0;
    Haptics.__reset();
  });

  it('an AMC job shows no warning — nothing is spent', async () => {
    // 2B: AMCs carry no visit count (decision 2026-09-15), so cancelling
    // without a date spends nothing and the sheet says so by rendering
    // no warning at all — not for a plain job, not for an AMC job.
    const plain = baseDeps();
    const plainRenderer = await create(<CancelSheet {...plain} />);
    const plainTree = toJson(plainRenderer);
    expect(findByTestID(plainTree, 'cancel-contract-warning')).toBeUndefined();
    expect(allText(plainTree).join(' ')).not.toContain('visits');

    // The AMC-linked job (the technician card's contract shape) cancels
    // exactly the same way — no slot, no warning, no visit arithmetic.
    const contracted = baseDeps({
      view: viewOf({ contract: { number: 'AMC-2627-00031', endDate: '2027-09-14' } }),
    });
    const renderer = await create(<CancelSheet {...contracted} />);
    const tree = toJson(renderer);

    expect(findByTestID(tree, 'cancel-contract-warning')).toBeUndefined();
    expect(allText(tree).join(' ')).not.toContain('AMC');
  });

  it('reason selection fires the Selection haptic and fills the row', async () => {
    const renderer = await create(<CancelSheet {...baseDeps()} />);
    const tree = toJson(renderer);

    await press(tree, 'cancel-reason-no_access');
    expect(Haptics.__fired()).toEqual(['selection']);

    // The chosen row fills slate.900 — the complete sheet's segment
    // idiom, one selection language across the two closers (§T5 Motion).
    const chosen = styleOf(findByTestID(toJson(renderer), 'cancel-reason-no_access'));
    const unchosen = styleOf(findByTestID(toJson(renderer), 'cancel-reason-other'));
    expect(chosen.backgroundColor).not.toBe(unchosen.backgroundColor);
    expect(unchosen.backgroundColor).toBeDefined();
    expect(unchosen.backgroundColor).not.toBe('transparent');
  });

  it('the payload is the strict schema shape — only the keys that exist', () => {
    // Reason only (no note, no date): one key. The server's
    // `jobCancelSchema` is .strict(); an empty note is not a note.
    expect(cancelPayloadOf({ reasonCode: 'no_access', note: '', rescheduleTo: null })).toEqual({
      reasonCode: 'no_access',
    });
    expect(cancelPayloadOf({ reasonCode: 'other', note: '  pad  ', rescheduleTo: null })).toEqual({
      reasonCode: 'other',
      reasonNote: 'pad',
    });
    expect(cancelPayloadOf({ reasonCode: 'duplicate', note: '', rescheduleTo: '2026-09-16' })).toEqual({
      reasonCode: 'duplicate',
      rescheduleTo: '2026-09-16',
    });

    // Blockers: validation facts only — no network-shaped input exists to
    // disable submit for a network reason (§5).
    expect(submitBlockerOf({ reasonCode: null, note: '' })).toBe('Pick the reason the visit did not go ahead.');
    expect(submitBlockerOf({ reasonCode: 'other', note: ' ' })).toBe('"Other" needs a note — say what happened.');
    expect(submitBlockerOf({ reasonCode: 'other', note: 'said come Thursday' })).toBeNull();
    expect(submitBlockerOf({ reasonCode: 'no_access', note: '' })).toBeNull();
  });

  it('the server’s cancelled event folds into the docket timeline; events that move no status do not', () => {
    // The route files POST /v1/jobs/:id/cancel (§6.3); the detail
    // screen's timeline reads the job's trail from the server, so his own
    // cancellation shows the moment the job is read again.
    const entries = timelineFromEvents([
      {
        id: 41,
        eventType: 'status_changed',
        actorId: 'e1',
        actorName: 'Ravi',
        occurredAt: '2026-09-11T09:40:00.000Z',
        fromStatus: 'assigned',
        toStatus: 'in_progress',
        source: 'mobile',
      },
      {
        id: 42,
        eventType: 'cancelled',
        actorId: 'e1',
        actorName: 'Ravi',
        occurredAt: '2026-09-11T10:05:00.000Z',
        fromStatus: 'in_progress',
        toStatus: 'cancelled',
        source: 'mobile',
      },
      {
        id: 43,
        eventType: 'rescheduled',
        actorId: 'e2',
        actorName: 'Office',
        occurredAt: '2026-09-11T10:06:00.000Z',
        fromStatus: null,
        toStatus: null,
        source: 'web',
      },
    ]);
    expect(entries.map((entry) => entry.label)).toEqual(['In progress', 'Cancelled']);
    expect(entries[1]).toEqual({ id: '42', label: 'Cancelled', at: '2026-09-11T10:05:00.000Z', to: 'cancelled' });
  });
});

/**
 * The sheet's own pass (2026-09-16, mobile UI overhaul): the reason list
 * reads as a list of choices, the note states its rule where the rule
 * matters, and the day he chose is a strip he can read back to the
 * customer.
 */
describe('CancelSheet — the reasons, the note, and the date', () => {
  it('marks the chosen reason with a shape as well as a colour', async () => {
    const renderer = await create(<CancelSheet {...baseDeps()} />);
    let tree = toJson(renderer);

    // Nine identical outlined rows read as nine text fields. Each carries a
    // mark now, and the chosen one's is the accent tick — a change of shape
    // beside the colour, never colour alone.
    const before = findAll(findByTestID(tree, 'cancel-reason-no_access')!, (n) => typeof n.props['data-icon'] === 'string');
    expect(before).toHaveLength(1);
    expect(before[0]!.props.color).toBe(SEMANTIC.text.placeholder);

    await press(tree, 'cancel-reason-no_access');
    tree = toJson(renderer);
    const after = findAll(findByTestID(tree, 'cancel-reason-no_access')!, (n) => typeof n.props['data-icon'] === 'string');
    expect(after).toHaveLength(1);
    expect(after[0]!.props.color).toBe(FRAME.accent);
  });

  it('states the note rule on the field when Other is chosen', async () => {
    const deps = baseDeps();
    const renderer = await create(<CancelSheet {...deps} />);
    let tree = toJson(renderer);

    // No reason yet: the note is optional, and says so.
    expect(allText(findByTestID(tree, 'cancel-note') ?? null).join(' ')).toContain('Optional');

    await press(tree, 'cancel-reason-other');
    tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'cancel-note') ?? null).join(' ')).toContain('Other needs a note');
    expect(isDisabled(tree)).toBe(true);

    await typeInto(tree, 'cancel-note', 'The gate was locked and nobody called back.');
    tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'cancel-note') ?? null).join(' ')).not.toContain('Other needs a note');
    expect(isDisabled(tree)).toBe(false);

    await trySubmit(tree);
    expect(submittedPayload(deps).reasonCode).toBe('other');
  });

  it('tints the day he chose inside the picker, and confirms it in a strip', async () => {
    const renderer = await create(<CancelSheet {...baseDeps()} />);
    let tree = toJson(renderer);
    await press(tree, 'cancel-reschedule-open');
    tree = toJson(renderer);

    const unchosen = findByTestID(tree, 'cancel-reschedule-option-2026-09-12')!;
    expect(styleOf(unchosen).backgroundColor).toBeUndefined(); // no tint until it is his answer

    // Choosing a day is the choice AND the close (`chooseDate` does both),
    // so the confirmation is what a technician sees — §T5's sentence, in a
    // strip he can read back to the customer.
    await press(tree, 'cancel-reschedule-option-2026-09-12');
    tree = toJson(renderer);
    const confirm = findByTestID(tree, 'cancel-reschedule-confirm')!;
    expect(allText(confirm).join(' ')).toBe('Visit moves to 12 Sep.');
    expect(findByTestID(tree, 'cancel-reschedule-picker')).toBeUndefined();

    // Reopened, the day he chose is the tinted row — and "Never mind"
    // leaves it chosen, because it is his answer already.
    await press(tree, 'cancel-reschedule-open');
    tree = toJson(renderer);
    const chosen = findByTestID(tree, 'cancel-reschedule-option-2026-09-12')!;
    expect(styleOf(chosen).backgroundColor).toBe(alpha(COLORS.accent, TINT.chip));
  });
});
