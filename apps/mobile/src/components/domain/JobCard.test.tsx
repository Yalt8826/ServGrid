/**
 * JobCard tests (§T2 list card). The card is the most-seen object in the
 * product; this file holds its pure decisions — the contract chip first
 * (T2B.3): an AMC job's card carries the single word `AMC` (§T2 chip is
 * `[AMC]`), an ordinary job carries no chip at all. The number and end
 * date live on the detail screen, never the card.
 *
 * T2B.5 pins the chip's COLOUR too: the AMC chip reads the muted token
 * (`SEMANTIC.text.secondary` on the dense card ground, PLAN-FRONTEND.md
 * §8), never the accent — accent is for the primary action and the
 * active state only, and an accent chip on every AMC card would spend
 * the one accent on a label. Asserted against the RENDERED node, the way
 * a style regression would actually show.
 */
import { describe, expect, it } from 'vitest';

import { alpha, COLORS, SEMANTIC, SLATE, STATUS, TINT } from '@servgrid/shared';
import { View } from 'react-native';
import { create, findAll, findByTestID, toJson, type Node } from '../ui/testing';
import { contractChipLabel, JobCard } from './JobCard';
import type { JobView } from '../../screens/technician/jobView';

let seq = 0;

function viewOf(contract: { number: string; endDate: string } | null): JobView {
  seq += 1;
  return {
    job: {
      id: `01890a5e-7800-7000-8000-${String(seq).padStart(12, '0')}`,
      jobNumber: 'JC-2627-00042',
      title: 'Battery swap',
      status: 'in_progress',
      priority: 'normal',
      scheduledFor: '2026-09-11T14:30:00+05:30',
      customerId: '01890a5e-c000-7000-8000-000000000001',
      contactName: 'Mr Prakash',
      contactPhone: '+919812345678',
      description: null,
      contract,
      version: 3,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: null,
    pending: false,
    rejectedMessage: null,
  };
}

/** The card's one chip node — the Text whose whole text is the word AMC. */
function amcChipOf(root: Node): Node {
  const hits = findAll(
    root,
    (n) => n.type === 'Text' && (n.children ?? []).filter((c): c is string => typeof c === 'string').join('') === 'AMC',
  );
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

function styleOfNode(node: Node): Record<string, unknown> {
  const raw = node.props.style;
  const parts = (Array.isArray(raw) ? raw : [raw]).filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === 'object',
  );
  return Object.assign({}, ...parts);
}

describe('JobCard — contractChipLabel', () => {
  it('is null without a contract — an ordinary job shows no chip', () => {
    expect(contractChipLabel(null)).toBeNull();
  });

  it("is 'AMC' with a contract — the word alone, never a price or a count", () => {
    expect(contractChipLabel({ number: 'AMC-2627-00031', endDate: '2027-09-14' })).toBe('AMC');
  });
});

describe('JobCard — the AMC chip renders muted, never accent (T2B.5)', () => {
  it('an AMC job renders exactly one chip, in the muted ink on the card ground', async () => {
    const renderer = await create(<JobCard view={viewOf({ number: 'AMC-2627-00031', endDate: '2027-09-14' })} />);
    const chip = amcChipOf(toJson(renderer));
    const style = styleOfNode(chip);

    expect(style.color).toBe(SEMANTIC.text.secondary);
    expect(style.color).not.toBe(COLORS.accent); // the safety-yellow accent, theme.ts's alone
  });

  it('an ordinary job renders no chip Text at all', async () => {
    const renderer = await create(<JobCard view={viewOf(null)} />);
    const tree = toJson(renderer);
    const chips = findAll(
      tree,
      (n) => n.type === 'Text' && (n.children ?? []).filter((c): c is string => typeof c === 'string').join('') === 'AMC',
    );
    expect(chips).toHaveLength(0);
  });
});

/**
 * The card's zones (mobile UI overhaul, 2026-09-16). It was one undivided
 * white block; these assertions hold the three things that make a list of
 * twelve scannable — the hairline between "which job" and "when and where
 * it stands", the job number in its own chip, and the status as a tinted
 * chip rather than the same outline on every card.
 */
describe('JobCard — the zones', () => {
  const flat = (node: Node): Record<string, unknown> =>
    Object.assign({}, ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style]));

  const hairlineOf = (root: Node): Node[] =>
    findAll(root, (n) => flat(n).height === 1 && flat(n).backgroundColor === SEMANTIC.line.default);

  it('draws exactly one hairline between the identity block and the meta row', async () => {
    const renderer = await create(<JobCard view={viewOf(null)} testID="card" />);
    expect(hairlineOf(toJson(renderer))).toHaveLength(1);
  });

  it('draws no hairline on a compact row — the row is already two lines', async () => {
    const renderer = await create(<JobCard view={viewOf(null)} compact testID="card" />);
    expect(hairlineOf(toJson(renderer))).toHaveLength(0);
  });

  it('seals the action footer off with its own hairline', async () => {
    const renderer = await create(
      <JobCard view={viewOf(null)} testID="card" actions={<View testID="card-actions" />} />,
    );
    expect(hairlineOf(toJson(renderer))).toHaveLength(2);
  });

  it('tints the status chip from the status ink, keeping the word in slate.900', async () => {
    const renderer = await create(<JobCard view={viewOf(null)} testID="card" />);
    const chip = findByTestID(toJson(renderer), 'card-status')!;
    // `in_progress` is the accent, so the tint is derived from it.
    expect(flat(chip).backgroundColor).toBe(alpha(STATUS.in_progress, TINT.chip));
    expect(flat(chip).borderColor).toBe(alpha(STATUS.in_progress, TINT.chipLine));
    // The word keeps the body ink — a tint is a ground, never an ink.
    const word = findByTestID(toJson(renderer), 'card-status-word')!;
    expect(flat(word).color).toBe(SEMANTIC.text.primary);
  });

  it('gives the job number its own chip so the identifier is findable', async () => {
    const renderer = await create(<JobCard view={viewOf(null)} testID="card" />);
    const number = findByTestID(toJson(renderer), 'card-number')!;
    expect((number.children ?? []).join('')).toBe('JC-2627-00042');
    // Tinted from the frame ink, not a status — a number is not a state.
    const chip = findAll(toJson(renderer), (n) => flat(n).backgroundColor === alpha(SLATE[900], TINT.band));
    expect(chip).toHaveLength(1);
  });
});
