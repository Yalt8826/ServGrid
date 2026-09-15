/**
 * T4 Complete sheet tests (T1.19, UI/plan-2/04-TECHNICIAN.md §T4) — the
 * nine the spec names:
 *
 * 1. Amount emptied → Paid-by replaced by "No payment taken"; submitted
 *    payload carries `collection_mode: 'none'`.
 * 2. Discount disclosure opens amount AND reason together; submit
 *    blocked without a reason.
 * 3. In-warranty + charge raises EXACTLY ONE confirmation.
 * 4. Parts list renders no subtotal and changes no figure.
 * 5. A `battery` line has the equipment checkbox ON by default; an
 *    `accessory` line OFF.
 * 6. One list produces both `parts[]` and `stackChanges[]`, with only
 *    ticked lines in the latter.
 * 7. Submit has no connectivity input — never disabled for a network reason.
 * 8. Success haptic fires when the server accepts, NOT on tap; a refusal
 *    keeps the sheet open, the reason on a banner, the typing intact.
 * 9. Prepaid branch hides amount AND Paid-by.
 *
 * Plus the "Done when" boxes: the sheet leaves the stepper visible (the
 * ~140pt context strip over the detail screen), the one-dialog rule
 * holds elsewhere, the MoneyGate's required `action` prop is proven both
 * ways, and the touch rows grow instead of clipping at 200% dynamic type
 * (`minHeight`, never a fixed height). The pure model
 * (`completeSheet.ts`) is asserted alongside the screen it drives.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { act } from 'react';
import { Text, View } from 'react-native';
// The stub module DIRECTLY: same instance the vitest alias feeds
// `haptics.ts` under test, and the one with the `__fired` surface.
import * as Haptics from '../../test-stubs/expo-haptics';

import { allText, create, findAll, findAllByTestID, findByTestID, firstDescendantOfType, toJson, type Node, type ReactTestRenderer } from '../../components/ui/testing';
import { MoneyGate } from '../../components/domain/MoneyGate';
import { JobDetailScreen, type JobDetailDeps } from './JobDetailScreen';
import { CompleteSheet, CONTEXT_STRIP_EXTRA_PT, type CompleteSheetDeps } from './CompleteSheet';
import {
  amountAfterDiscountOf,
  chargeApplies,
  equipmentDefaultFor,
  partLineOf,
  payloadOf,
  submitBlockerOf,
  warrantyConfirmMessageOf,
  type CompleteSheetPayload,
  type PartProduct,
} from './completeSheet';
import { statusPillOf, type JobView } from './jobView';
import type { JobStatus } from '@servgrid/shared';

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST
const SCHEDULED = '2026-09-11T14:30:00+05:30';

const BATTERY: PartProduct = { id: '01890a5e-p000-7000-8000-000000000001', name: 'Exide 150Ah battery', category: 'battery' };
const ACCESSORY: PartProduct = { id: '01890a5e-p000-7000-8000-000000000002', name: 'Air filter', category: 'accessory' };

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
      scheduledFor: SCHEDULED,
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
    // In warranty until 14 Mar 2027 — the warranty-confirmation fixture.
    unit: {
      name: 'UPS 850VA',
      brand: 'Luminous',
      serialNumber: 'LM8842219',
      warrantyExpiresOn: '2027-03-14',
    },
    ...extra,
  };
}

type Deps = CompleteSheetDeps;

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    view: viewOf(),
    products: [BATTERY, ACCESSORY],
    role: 'technician',
    now: NOW,
    onSubmit: vi.fn(async (_payload: CompleteSheetPayload) => {}),
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

/** The editable input inside a field subtree (TextField/MoneyField). */
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
  const button = findByTestID(tree, 'complete-submit');
  const hit = findAll(button ?? null, (candidate) => typeof candidate.props.onPress === 'function')[0];
  const disabled = (hit?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
  if (disabled) throw new Error('Submit is disabled — the test must not fake a press the button would ignore.');
  return press(tree, 'complete-submit');
}

function isDisabled(tree: Node | string | null): boolean {
  const button = findByTestID(tree, 'complete-submit');
  const hit = findAll(button ?? null, (candidate) => typeof candidate.props.onPress === 'function')[0];
  return (hit?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
}

function submittedPayload(deps: Deps, call = 0): CompleteSheetPayload {
  const mock = deps.onSubmit as ReturnType<typeof vi.fn>;
  expect(mock.mock.calls.length).toBeGreaterThan(call);
  return mock.mock.calls[call]![0] as CompleteSheetPayload;
}

/** One parts line's container, matched by the product name it renders. */
function lineOf(tree: Node | string | null, name: string): Node {
  const lines = findAll(tree, (node) => {
    const id = node.props.testID;
    return typeof id === 'string' && /^complete-line-line-\d+$/.test(id) && allText(node).join(' ').includes(name);
  });
  if (lines.length !== 1) throw new Error(`Expected exactly one part line named ${name}, found ${lines.length}`);
  return lines[0]!;
}

/** A control of one line by suffix (`-serial`, `-equipment`, `-remove`). */
function lineControlOf(tree: Node | string | null, name: string, suffix: string): Node {
  const line = lineOf(tree, name);
  const id = String(line.props.testID) + suffix;
  const hit = findByTestID(line, id);
  if (hit === undefined) throw new Error(`No ${id} on the line`);
  return hit;
}

async function addCataloguePart(renderer: ReactTestRenderer, productId: string): Promise<void> {
  await press(toJson(renderer), 'complete-part-add');
  await press(toJson(renderer), `complete-part-option-${productId}`);
}

// ── the nine ─────────────────────────────────────────────────────────────────

describe('CompleteSheet (§T4)', () => {
  beforeEach(() => {
    seq = 0;
    Haptics.__reset();
  });

  it('1 · an emptied amount replaces Paid-by with "No payment taken" and submits collection_mode none', async () => {
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    let tree = toJson(renderer);

    // A charge first: the segments are how he says the money moved.
    await typeInto(tree, 'complete-amount', '500');
    await typeInto(tree, 'complete-work-done', 'Replaced the battery bank.');
    tree = toJson(renderer);
    expect(findByTestID(tree, 'complete-paid-by')).toBeDefined();
    expect(findByTestID(tree, 'complete-segment-cash')).toBeDefined();
    expect(findByTestID(tree, 'complete-no-payment')).toBeUndefined();

    // Emptied — the segments are replaced IN PLACE by the honest line.
    await typeInto(tree, 'complete-amount', '');
    tree = toJson(renderer);
    expect(findByTestID(tree, 'complete-paid-by')).toBeUndefined();
    expect(findByTestID(tree, 'complete-segment-cash')).toBeUndefined();
    const line = findByTestID(tree, 'complete-no-payment');
    expect(line).toBeDefined();
    expect(allText(line ?? null).join(' ')).toBe('No payment taken');

    await trySubmit(tree);
    const payload = submittedPayload(deps);
    expect(payload.collectionMode).toBe('none');
    // No charge → no money fields at all: the server's honest zeros.
    expect(payload.cost).toBeUndefined();
    expect(payload.discountAmount).toBeUndefined();
  });

  it('2 · the discount disclosure opens amount and reason together; submit is blocked without a reason', async () => {
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    let tree = toJson(renderer);

    expect(findByTestID(tree, 'complete-discount')).toBeUndefined();
    await press(tree, 'complete-discount-toggle');
    tree = toJson(renderer);

    // Together, never one-then-the-other — the database refuses the row
    // without a reason, so the sheet asks for both at once (§T4).
    expect(findByTestID(tree, 'complete-discount-amount')).toBeDefined();
    expect(findByTestID(tree, 'complete-discount-reason')).toBeDefined();

    await typeInto(tree, 'complete-work-done', 'Fixed the inverter.');
    await typeInto(tree, 'complete-amount', '1200');
    await typeInto(tree, 'complete-discount-amount', '200');
    tree = toJson(renderer);

    // Blocked, with the why visible under the button.
    expect(allText(findByTestID(tree, 'complete-submit') ?? null).join(' ')).toContain('A discount needs a reason');
    expect(isDisabled(tree)).toBe(true);
    expect(() => trySubmit(tree)).toThrow('Submit is disabled');

    await typeInto(tree, 'complete-discount-reason', 'Loyalty discount, office approved.');
    tree = toJson(renderer);
    expect(isDisabled(tree)).toBe(false);
    await trySubmit(tree);

    // The charge is on an in-warranty unit (the default fixture), so the
    // sheet's one dialog intercepts even on a discounted figure — confirm
    // and the discount files with it.
    expect(findByTestID(toJson(renderer), 'complete-warranty')).toBeDefined();
    await press(toJson(renderer), 'complete-warranty-confirm');

    const payload = submittedPayload(deps);
    expect(payload.cost).toBe('1200');
    expect(payload.discountAmount).toBe('200');
    expect(payload.discountReason).toBe('Loyalty discount, office approved.');
  });

  it('3 · an in-warranty unit with a charge raises exactly one confirmation — a prompt, not a block', async () => {
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    const tree = toJson(renderer);

    await typeInto(tree, 'complete-work-done', 'Replaced the PCB.');
    await typeInto(tree, 'complete-amount', '500');
    await trySubmit(toJson(renderer));

    // Exactly one dialog, carrying the expiry date (§T4's sentence).
    const dialogs = findAllByTestID(toJson(renderer), 'complete-warranty');
    expect(dialogs).toHaveLength(1);
    expect(allText(dialogs[0] ?? null).join(' ')).toContain(warrantyConfirmMessageOf(deps.view));
    expect(allText(dialogs[0] ?? null).join(' ')).toContain('This unit is under warranty until 14 Mar 2027. Charge anyway?');

    // Confirm and it files — no second gate, no re-ask.
    await press(toJson(renderer), 'complete-warranty-confirm');
    expect(deps.onSubmit).toHaveBeenCalledTimes(1);
    expect(deps.onDismiss).toHaveBeenCalledTimes(1);
    expect(findByTestID(toJson(renderer), 'complete-warranty')).toBeUndefined();
  });

  it('3b · a charge on a unit out of warranty files with no confirmation at all', async () => {
    const deps = baseDeps({
      view: viewOf({}, { unit: { name: 'UPS 850VA', brand: null, serialNumber: 'LM8842219', warrantyExpiresOn: '2026-01-01' } }),
    });
    const renderer = await create(<CompleteSheet {...deps} />);
    const tree = toJson(renderer);

    await typeInto(tree, 'complete-work-done', 'Replaced the PCB.');
    await typeInto(tree, 'complete-amount', '500');
    await trySubmit(toJson(renderer));

    // The ONLY dialog on this sheet is the warranty one (§T4) — nothing
    // else stands in its place, and the charge files straight through.
    expect(findByTestID(toJson(renderer), 'complete-warranty')).toBeUndefined();
    expect(deps.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('3c · a unit with no warranty expiry still renders the sheet — the dialog message degrades to the bare question', async () => {
    // Regression: the dialog message is built on EVERY render of the
    // sheet, and a null `warrantyExpiresOn` reached
    // `new Date('T00:00:00Z')` — RangeError, red screen, no sheet. Real
    // units routinely carry no warranty date; the fixtures always had one.
    const deps = baseDeps({
      view: viewOf({}, { unit: { name: 'UPS 850VA', brand: null, serialNumber: 'LM8842219', warrantyExpiresOn: null } }),
    });
    const renderer = await create(<CompleteSheet {...deps} />);
    expect(toJson(renderer)).toBeDefined();
    expect(warrantyConfirmMessageOf(deps.view)).toBe('Charge anyway?');

    // No unit at all — same sentence, still nothing to format.
    const noUnit = baseDeps({ view: viewOf({}, { unit: undefined }) });
    await create(<CompleteSheet {...noUnit} />);
    expect(warrantyConfirmMessageOf(noUnit.view)).toBe('Charge anyway?');
  });

  it('4 · the parts list never shows a subtotal and never changes the figure', async () => {
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    await press(toJson(renderer), 'complete-parts-toggle');
    await addCataloguePart(renderer, BATTERY.id);
    await addCataloguePart(renderer, ACCESSORY.id);
    const tree = toJson(renderer);

    const list = findByTestID(tree, 'complete-parts-list');
    expect(list).toBeDefined();
    const listText = allText(list ?? null).join(' ').toLowerCase();
    expect(listText).not.toContain('₹');
    expect(listText).not.toContain('total');

    // The figure above is exactly what he typed — a tick beside a part
    // must not suggest it feeds the amount (§T4).
    const before = inputOf(tree, 'complete-amount').props.value;
    await act(async () => {
      pressableOf(lineControlOf(tree, 'Air filter', '-remove')).props.onPress?.();
    });
    const after = inputOf(toJson(renderer), 'complete-amount').props.value;
    expect(after).toBe(before);
    expect(submittedPayloadCallCount(deps)).toBe(0);
  });

  it('5 · a battery line defaults the equipment checkbox ON; an accessory line OFF', async () => {
    const renderer = await create(<CompleteSheet {...baseDeps()} />);
    await press(toJson(renderer), 'complete-parts-toggle');
    await addCataloguePart(renderer, BATTERY.id);
    await addCataloguePart(renderer, ACCESSORY.id);
    const tree = toJson(renderer);

    // The battery is standing at the site now — the right answer with no
    // touch. The filter is a consumable — off, also with no touch.
    const battery = lineControlOf(tree, 'Exide 150Ah battery', '-equipment');
    const filter = lineControlOf(tree, 'Air filter', '-equipment');
    expect(checkedOf(battery)).toBe(true);
    expect(checkedOf(filter)).toBe(false);

    // And the pure default, table form (§T4's category list).
    expect(equipmentDefaultFor('ups')).toBe(true);
    expect(equipmentDefaultFor('battery')).toBe(true);
    expect(equipmentDefaultFor('inverter')).toBe(true);
    expect(equipmentDefaultFor('accessory')).toBe(false);
    expect(equipmentDefaultFor('spare')).toBe(false);
    expect(equipmentDefaultFor(null)).toBe(false); // free text
  });

  it('6 · one list files both arrays: every line in parts[], only ticked lines in stackChanges[]', async () => {
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    await press(toJson(renderer), 'complete-parts-toggle');
    await addCataloguePart(renderer, BATTERY.id);
    await addCataloguePart(renderer, ACCESSORY.id);
    const tree = toJson(renderer);

    // Serial on the ticked battery — the site's stack is serial-tracked.
    const serial = firstDescendantOfType(lineControlOf(tree, 'Exide 150Ah battery', '-serial'), 'TextInput');
    await act(async () => {
      serial?.props.onChangeText?.('EX2291184');
    });
    await typeInto(tree, 'complete-work-done', 'Battery swap.');
    await trySubmit(toJson(renderer));

    const payload = submittedPayload(deps);
    expect(payload.parts).toHaveLength(2); // consumed on this job
    expect(payload.stackChanges).toEqual([
      // Only the TICKED line — the filter lives in parts[] alone.
      { productId: BATTERY.id, serialNumber: 'EX2291184', installedOn: '2026-09-11' },
    ]);

    // Unticking is the override (§T4: a suggestion, not a rule) — and it
    // keeps the line out of the site's stack while it stays a part.
    const fresh = baseDeps();
    const freshRenderer = await create(<CompleteSheet {...fresh} />);
    await press(toJson(freshRenderer), 'complete-parts-toggle');
    await addCataloguePart(freshRenderer, BATTERY.id);
    const freshTree = toJson(freshRenderer);
    await press(freshTree, String(lineControlOf(freshTree, 'Exide 150Ah battery', '-equipment').props.testID));
    await typeInto(freshTree, 'complete-work-done', 'Battery swap, own stock.');
    await trySubmit(toJson(freshRenderer));

    const freshPayload = submittedPayload(fresh);
    expect(freshPayload.parts).toHaveLength(1);
    expect(freshPayload.stackChanges).toBeUndefined();
    expect(partLineOf(ACCESSORY, '').addToEquipment).toBe(false);
  });

  it('7 · submit is never disabled for a network reason — the sheet has no connectivity input', async () => {
    // The deps interface has NO connectivity input at all — there is
    // nothing it could disable for. A lost connection is the
    // no-connection gate's to show, over the sheet, never inside it.
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    let tree = toJson(renderer);

    await typeInto(tree, 'complete-work-done', 'Cleaned and tested.');
    tree = toJson(renderer);
    expect(isDisabled(tree)).toBe(false);

    // And it files: the route sends it, and the sheet dismisses once it lands.
    await trySubmit(tree);
    expect(deps.onSubmit).toHaveBeenCalledTimes(1);
    expect(deps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('8 · the Success haptic waits for the server to accept — never on tap; a refusal keeps the sheet', async () => {
    let accept!: () => void;
    const deps = baseDeps({
      onSubmit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            accept = resolve;
          }),
      ),
    });
    const renderer = await create(<CompleteSheet {...deps} />);

    await typeInto(toJson(renderer), 'complete-work-done', 'Battery swap.');
    await trySubmit(toJson(renderer));

    // The tap sent the work; the notification did NOT fire on intent.
    expect(deps.onSubmit).toHaveBeenCalledTimes(1);
    expect(Haptics.__fired().every((entry) => !entry.startsWith('notification'))).toBe(true);
    expect(deps.onDismiss).not.toHaveBeenCalled();

    // The server has it — NOW the honest signal (NotificationSuccess), then the sheet goes.
    await act(async () => {
      accept();
    });
    expect(Haptics.__fired()).toEqual(['notification:notificationSuccess']);
    expect(deps.onDismiss).toHaveBeenCalledTimes(1);

    // A refusal is the banner's job, never a success beat — and nothing typed is lost.
    Haptics.__reset();
    const refused = baseDeps({
      onSubmit: vi.fn(async () => {
        throw new Error('This job was cancelled by the office at 14:32.');
      }),
    });
    const refusedRenderer = await create(<CompleteSheet {...refused} />);
    await typeInto(toJson(refusedRenderer), 'complete-work-done', 'Battery swap.');
    await trySubmit(toJson(refusedRenderer));
    await act(async () => {});
    expect(Haptics.__fired()).toEqual([]);
    expect(refused.onDismiss).not.toHaveBeenCalled();
    const banner = findByTestID(toJson(refusedRenderer), 'complete-banner');
    expect(banner, 'the refusal is shown').toBeDefined();
    expect(allText(banner!).join(' ')).toContain('This job was cancelled by the office at 14:32.');
    const input = firstDescendantOfType(findByTestID(toJson(refusedRenderer), 'complete-work-done')!, 'TextInput');
    expect(input!.props.value).toBe('Battery swap.');
  });

  it('9 · an AMC job completes like any other — the money fields stand', async () => {
    // 2B: no prepaid branch (decision 2026-09-15). The Free/Charge choice
    // is T2B.5's; until then an AMC job closes through the same fields.
    const deps = baseDeps({
      view: viewOf({ contract: { number: 'AMC-2627-00031', endDate: '2027-09-14' } }),
    });
    const renderer = await create(<CompleteSheet {...deps} />);
    let tree = toJson(renderer);

    // The ordinary money half is present for an AMC job too.
    expect(findByTestID(tree, 'complete-amount')).toBeDefined();
    expect(findByTestID(tree, 'complete-paid-by')).toBeUndefined(); // nothing charged yet — "No payment taken"
    expect(findByTestID(tree, 'complete-prepaid')).toBeUndefined();

    // Submitting free: no cost key, mode none — the honest zeros.
    await typeInto(tree, 'complete-work-done', 'Quarterly service.');
    tree = toJson(renderer);
    await trySubmit(tree);

    const payload = submittedPayload(deps);
    expect(payload.collectionMode).toBe('none');
    expect(payload.cost).toBeUndefined();
    expect(payload.discountAmount).toBeUndefined();
    expect(chargeApplies('', '')).toBe(false);
  });
});

function checkedOf(node: Node): boolean {
  return (node.props.accessibilityState as { checked?: boolean } | undefined)?.checked === true;
}

function pressableOf(node: Node): Node {
  const hit = findAll(node, (candidate) => typeof candidate.props.onPress === 'function')[0];
  if (hit === undefined) throw new Error('No pressable under the node');
  return hit;
}

function submittedPayloadCallCount(deps: Deps): number {
  return (deps.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length;
}

// ── the Done-when boxes ──────────────────────────────────────────────────────

describe('CompleteSheet — Done when (§T4)', () => {
  beforeEach(() => {
    seq = 0;
    Haptics.__reset();
  });

  function detailDeps(view: JobView): JobDetailDeps {
    return {
      view,
      events: [{ id: 'ev-1', label: statusPillOf('in_progress').label, at: SCHEDULED, to: 'in_progress' as JobStatus }],
      completedAt: null,
      onBack: vi.fn(),
      onCall: vi.fn(),
      onNavigate: vi.fn(),
      onStartJob: vi.fn(),
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      onRefresh: vi.fn(),
      now: NOW,
    };
  }

  it('the sheet leaves the StatusStepper in the tree and unobscured — ~140pt of context strip', async () => {
    const view = viewOf();
    const sheetDeps = baseDeps({ view });
    const renderer = await create(
      <View>
        <JobDetailScreen {...detailDeps(view)} />
        <CompleteSheet {...sheetDeps} />
      </View>,
    );
    const tree = toJson(renderer);

    // The stepper is IN the tree — the detail screen is still under it.
    expect(findByTestID(tree, 'detail-stepper')).toBeDefined();

    // And the sheet reserves the strip that keeps it visible: the
    // context wrapper (140 − 64) plus the Sheet's own 64pt minimum —
    // enough for the docket header AND the hero (03-COMPONENTS.md `Sheet`).
    const strip = findByTestID(tree, 'complete-context-strip');
    expect(styleOf(strip).paddingTop).toBe(CONTEXT_STRIP_EXTRA_PT);
    const sheet = findByTestID(tree, 'complete-sheet');
    const panels = findAll(sheet ?? null, (node) => styleOf(node).marginTop === 64);
    expect(panels.length).toBeGreaterThanOrEqual(1);
    expect(CONTEXT_STRIP_EXTRA_PT + 64).toBeGreaterThanOrEqual(140);

    // Unobscured means ABOVE the sheet: the stepper renders before it.
    const ordered = findAll(tree, (node) => node.props.testID === 'detail-stepper' || node.props.testID === 'complete-sheet');
    expect(ordered.map((node) => node.props.testID)).toEqual(['detail-stepper', 'complete-sheet']);
  });

  it('the MoneyGate takes the action as a required prop — read hides, create shows', async () => {
    // The trap, pinned: the technician's job.money READ scope is none.
    const readGate = await create(
      <MoneyGate role="technician" action="read">
        <Text>amount</Text>
      </MoneyGate>,
    );
    expect(readGate.toJSON()).toBeNull(); // a gate defaulting to read would hide the field — T4's named failure

    const createGate = await create(
      <MoneyGate role="technician" action="create">
        <Text>amount</Text>
      </MoneyGate>,
    );
    expect(createGate.toJSON()).not.toBeNull();

    // And on the sheet itself: a role without the write-once cell sees no
    // money half at all (belt-and-braces over the server's schema).
    const dispatcher = baseDeps({ role: 'dispatcher' });
    const renderer = await create(<CompleteSheet {...dispatcher} />);
    const tree = toJson(renderer);
    expect(findByTestID(tree, 'complete-money-gate')).toBeUndefined();
    expect(findByTestID(tree, 'complete-amount')).toBeUndefined();
  });

  it('200% dynamic type: the touch rows grow — minHeight everywhere, never a fixed height', async () => {
    const deps = baseDeps();
    const renderer = await create(<CompleteSheet {...deps} />);
    let tree = toJson(renderer);

    // A charge so the segments render — they are touch rows too.
    await typeInto(tree, 'complete-amount', '500');
    await typeInto(tree, 'complete-work-done', 'Cleaned.');
    tree = toJson(renderer);

    // Segments, the no-payment line, the disclosures, the checkbox and
    // the submit row are floor-sized, not ceiling-sized: at 200% the
    // label wraps and the row grows instead of clipping (§T4 Done when).
    const segment = findByTestID(tree, 'complete-segment-cash');
    expect(styleOf(segment).minHeight).toBe(52);
    expect(styleOf(segment).height).toBeUndefined();

    await typeInto(tree, 'complete-amount', '');
    tree = toJson(renderer);
    const noPayment = findByTestID(tree, 'complete-no-payment');
    expect(styleOf(noPayment).minHeight).toBe(52);
    expect(styleOf(noPayment).height).toBeUndefined();

    const disclosure = findByTestID(tree, 'complete-parts-toggle');
    expect(styleOf(disclosure).minHeight).toBe(52);
    expect(styleOf(disclosure).height).toBeUndefined();

    const checkbox = findByTestID(tree, 'complete-customer-confirmed');
    expect(typeof styleOf(checkbox).minHeight).toBe('number');
    expect(styleOf(checkbox).height).toBeUndefined();

    const submit = findByTestID(tree, 'complete-submit');
    const submitPressable = findAll(submit ?? null, (candidate) => candidate.type === 'Pressable')[0];
    expect(styleOf(submitPressable).minHeight).toBe(52);

    // The Work done field is multiline and grows the same way.
    const workField = findByTestID(tree, 'complete-work-done');
    const workInput = workField === undefined ? undefined : firstDescendantOfType(workField, 'TextInput');
    expect(workInput).toBeDefined();
    expect((workInput!.props.style as Record<string, unknown>).minHeight).toBeGreaterThan(0);
  });

  it('the pure branches agree with the screen: after-discount, blockers, and the payload shape', () => {
    // The only derived figure, and it never renders (never a subtotal).
    expect(amountAfterDiscountOf('500', '')).toBe(500);
    expect(amountAfterDiscountOf('500', '500')).toBe(0);
    expect(amountAfterDiscountOf('', '')).toBeNull();
    expect(chargeApplies('500', '500')).toBe(false); // zero after discount
    expect(chargeApplies('', '')).toBe(false); // empty
    expect(chargeApplies('500', '200')).toBe(true);

    // Submit blockers are validation facts only — no network-shaped
    // input exists to disable submit for a network reason (§T4 Never).
    const valid = { workSummary: 'Done', amount: '', discountAmount: '', discountReason: '', lines: [] };
    expect(submitBlockerOf(valid)).toBeNull();
    expect(submitBlockerOf({ ...valid, workSummary: ' ' })).toBe('Say what work was done.');
    expect(submitBlockerOf({ ...valid, amount: '100', discountAmount: '100', discountReason: '' })).toBe(
      'A discount needs a reason — say why the amount was reduced.',
    );
    expect(
      submitBlockerOf({ ...valid, amount: '100', discountAmount: '200', discountReason: 'why not' }),
    ).toContain('larger than the amount');

    // The payload never carries `amountCollected` — the column is
    // generated server-side; sending it would store derived money.
    const payload = payloadOf({
      view: viewOf(),
      workSummary: 'Done',
      amount: '500',
      discountAmount: '',
      discountReason: '',
      selectedMode: 'upi',
      lines: [],
      customerConfirmed: true,
      now: NOW,
      completedAt: '2026-09-11T10:00:00.000Z',
    });
    expect(payload.collectionMode).toBe('upi');
    expect(payload.customerSigned).toBe(true);
    expect('amountCollected' in payload).toBe(false);
    expect(payload.completedAt).toBe('2026-09-11T10:00:00.000Z');
  });
});
